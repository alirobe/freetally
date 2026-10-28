package main

import (
	"log/slog"
	"net/http"
	"time"
)

// routes maps every URL to its handler and sets the headers common to all responses.
func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	page := func(name string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) { a.static.Serve(w, r, name, 200) }
	}
	mux.HandleFunc("GET /{$}", page("index.html"))
	for _, f := range []string{"app.css", "home.js", "tally.js", "screen.js", "live.js", "fx.js", "admin.js"} {
		mux.HandleFunc("GET /"+f, page(f))
	}
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, r, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /robots.txt", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("User-agent: *\nDisallow: /\n"))
	})

	tallyPage := func(name string) http.HandlerFunc {
		return a.handle(func(w http.ResponseWriter, r *http.Request) error {
			t, err := a.tally(r.PathValue("id"))
			if err != nil {
				a.static.Serve(w, r, "404.html", 404)
				return nil
			}
			snap, err := a.snapshot(r, t)
			if err != nil {
				slog.Error("page snapshot", "error", err)
				snap = nil
			}
			return a.static.ServeTally(w, r, name, t, snap)
		})
	}
	mux.HandleFunc("GET /t/{id}", tallyPage("tally.html"))
	mux.HandleFunc("GET /t/{id}/screen", tallyPage("screen.html"))

	mux.HandleFunc("POST /api/tallies", a.handle(a.createTally))
	mux.HandleFunc("PATCH /api/tallies/{id}", a.handle(a.updateTally))
	mux.HandleFunc("POST /api/tallies/{id}/entries", a.handle(a.addEntry))
	mux.HandleFunc("GET /api/tallies/{id}/events", a.handle(a.events))
	mux.HandleFunc("GET /api/tallies/{id}/snapshot", a.handle(a.getSnapshot))
	mux.HandleFunc("GET /api/tallies/{id}/qr.svg", a.handle(a.qr))

	mux.HandleFunc("GET /admin/{key}", a.adminPage)
	mux.HandleFunc("GET /api/admin/{key}/tallies", a.admin(a.adminList))
	mux.HandleFunc("DELETE /api/admin/{key}/tallies/{id}", a.admin(a.adminDelete))
	mux.HandleFunc("/api/admin/{key}/tallies/{id}/{action}", a.admin(a.adminAction))

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, &httpError{404, "Not found"})
	})

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			a.lastActive.Store(time.Now().UnixMilli())
		}
		h := w.Header()
		h.Set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		// Tally and admin links are secrets, so they're never sent on to other sites.
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Content-Security-Policy", basePolicy)
		mux.ServeHTTP(w, r)
	})
}
