// FreeTally serves a shared tally for counting people through the doors at an event.
// Settings come from environment variables; README.md lists them.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// env returns the environment variable key, or fallback when it's unset or empty.
func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// envDuration reads key as a whole number of milliseconds, or returns fallback.
func envDuration(key string, fallback time.Duration) time.Duration {
	if ms, err := strconv.Atoi(os.Getenv(key)); err == nil && ms > 0 {
		return time.Duration(ms) * time.Millisecond
	}
	return fallback
}

func main() {
	healthcheck := flag.Bool("healthcheck", false, "check the running server and exit (for Docker)")
	flag.Parse()
	port := env("PORT", "3000")
	if *healthcheck {
		res, err := http.Get("http://127.0.0.1:" + port + "/healthz")
		if err != nil || res.StatusCode != 200 {
			os.Exit(1)
		}
		os.Exit(0)
	}

	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if err := run(port); err != nil {
		slog.Error("stopped", "error", err)
		os.Exit(1)
	}
}

func run(port string) error {
	adminKey := os.Getenv("ADMIN_KEY")
	if adminKey != "" && !regexp.MustCompile(`^[A-Za-z0-9_-]{32,}$`).MatchString(adminKey) {
		return errors.New("ADMIN_KEY must be at least 32 letters, digits, - or _")
	}
	dataDir := env("DATA_DIR", "./data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return err
	}
	store, err := openStore(dataDir)
	if err != nil {
		return err
	}
	defer store.Close()
	slog.SetDefault(slog.New(newLogHandler(slog.Default().Handler(), store)))
	// Machines stop when idle and start on demand, so pruning at start runs often enough.
	if err := store.PruneLog(time.Now().AddDate(0, 0, -180)); err != nil {
		return err
	}
	static, err := loadStatic(os.Getenv("STATIC_DIR"))
	if err != nil {
		return err
	}

	stats := &Stats{}
	app := &App{
		store:     store,
		hub:       newHub(envDuration("BATCH_QUIET_MS", 100*time.Millisecond), envDuration("BATCH_MAX_WAIT_MS", 100*time.Millisecond), stats),
		limits:    newLimits(),
		static:    static,
		stats:     stats,
		adminKey:  adminKey,
		publicURL: strings.TrimRight(os.Getenv("PUBLIC_URL"), "/"),
		ipHeader:  http.CanonicalHeaderKey(strings.TrimSpace(os.Getenv("CLIENT_IP_HEADER"))),
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go stats.logEvery(time.Minute, app.hub, ctx.Done())
	// With IDLE_EXIT_MS set, the server stops itself once nobody has used it for that long, so a
	// host like Fly can stop the machine and start it again on the next request.
	if idleExit := envDuration("IDLE_EXIT_MS", 0); idleExit > 0 {
		app.lastActive.Store(time.Now().UnixMilli())
		go func() {
			t := time.NewTicker(min(time.Minute, idleExit/4))
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					if pages, _ := app.hub.OpenPages(); pages == 0 && app.idleFor() >= idleExit {
						slog.Info("idle, exiting", "after", idleExit.String())
						stop()
						return
					}
				}
			}
		}()
	}
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				app.limits.Sweep()
			}
		}
	}()

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           app.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		// Closing the base context on shutdown ends open live streams too.
		BaseContext: func(_ net.Listener) context.Context { return ctx },
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	slog.Info("started", "port", port, "admin", adminKey != "", "publicUrl", app.publicURL, "clientIpHeader", app.ipHeader)

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(shutdown)
	slog.Info("stopped")
	return nil
}

// idleFor is how long since the last request other than a health check.
func (a *App) idleFor() time.Duration {
	return time.Since(time.UnixMilli(a.lastActive.Load()))
}
