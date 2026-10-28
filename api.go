package main

import (
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

const (
	// snapshotLimit is the most entries a snapshot or a reconnecting page's catch-up carries.
	snapshotLimit = 1000
	// The page offers undo for 10 seconds; the extra allows for a slow or queued request.
	undoWindow = 2 * time.Minute
	maxBody    = 4096
)

// httpError is an error with a status and a message fit to show the person using the page.
// Any other error a handler returns becomes a 500 and is logged.
type httpError struct {
	status  int
	message string
}

func (e *httpError) Error() string { return e.message }

// App holds the server's state and handles its requests.
type App struct {
	store     *Store
	hub       *Hub
	limits    *Limits
	static    *Static
	stats     *Stats
	adminKey  string
	publicURL string
	// The header a proxy in front puts the client's address in, or "" when there's no proxy.
	ipHeader string
	// When the last request other than a health check arrived, in Unix milliseconds.
	lastActive atomic.Int64
}

// writeJSON sends v as JSON. r may be nil, which skips compression.
func writeJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	body, _ := json.Marshal(v)
	w.Header().Set("Content-Type", "application/json")
	writeFresh(w, r, status, body)
}

// writeFresh sends a reply built for this request, so it's never cached.
func writeFresh(w http.ResponseWriter, r *http.Request, status int, body []byte) {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	// Small replies aren't worth compressing; snapshots, tally pages and the admin list are.
	if r != nil && len(body) > 1024 && acceptsGzip(r) {
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestSpeed)
		zw.Write(body)
		zw.Close()
		h.Set("Content-Encoding", "gzip")
		h.Set("Vary", "Accept-Encoding")
		body = buf.Bytes()
	}
	w.WriteHeader(status)
	w.Write(body)
}

// writeError sends err as {"error": message}, hiding anything that isn't an httpError.
func writeError(w http.ResponseWriter, err error) {
	var he *httpError
	if !errors.As(err, &he) {
		he = &httpError{500, "Server error"}
	}
	writeJSON(w, nil, he.status, map[string]string{"error": he.message})
}

// handle adapts handlers that return an error, and counts server errors for the activity log.
func (a *App) handle(fn func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := fn(w, r); err != nil {
			var he *httpError
			if !errors.As(err, &he) {
				a.stats.serverErrors.Add(1)
				// The route pattern rather than the path, which can hold the admin key.
				slog.Error("request failed", "tally", r.PathValue("id"), "route", r.Pattern, "error", err)
			}
			writeError(w, err)
		}
	}
}

// readJSON decodes the request body into v. An empty body reads as {}.
func readJSON(r *http.Request, v any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil {
		return &httpError{400, "Invalid request"}
	}
	if len(body) > maxBody {
		return &httpError{413, "Request too large"}
	}
	if len(bytes.TrimSpace(body)) == 0 {
		body = []byte("{}")
	}
	if json.Unmarshal(body, v) != nil {
		return &httpError{400, "Invalid JSON"}
	}
	return nil
}

// tally looks up a tally by id, as a 404 httpError when there's no such tally.
func (a *App) tally(id string) (*Tally, error) {
	if !tallyIDPattern.MatchString(id) {
		return nil, &httpError{404, "Tally not found"}
	}
	t, err := a.store.Tally(id)
	if errors.Is(err, errNotFound) {
		return nil, &httpError{404, "Tally not found"}
	}
	return t, err
}

// baseURL is where phones reach the server, for share links and QR codes: PUBLIC_URL, or else
// the address this request came in on.
func (a *App) baseURL(r *http.Request) string {
	if a.publicURL != "" {
		return a.publicURL
	}
	proto, host := "http", r.Host
	if r.TLS != nil {
		proto = "https"
	}
	// Forwarded headers are believed only behind a named proxy, like the client address.
	if a.ipHeader != "" {
		if p := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]); p == "http" || p == "https" {
			proto = p
		}
		if h := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Host"), ",")[0]); h != "" {
			host = h
		}
	}
	return proto + "://" + host
}

// idChars leaves out characters that are easily mistaken for each other: i, l, o, 0 and 1.
const idChars = "abcdefghjkmnpqrstuvwxyz23456789"

// newID returns a random 10-character tally id.
func newID() string {
	b := make([]byte, 10)
	for i := range b {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(idChars))))
		b[i] = idChars[n.Int64()]
	}
	return string(b)
}

// newOwnerKey returns a secret that lets whoever holds it edit a tally. Only its hash is stored.
func newOwnerKey() string {
	key := make([]byte, 24)
	rand.Read(key)
	return base64.RawURLEncoding.EncodeToString(key)
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// Tallies

type tallyRequest struct {
	Name     json.RawMessage `json:"name"`
	Capacity json.RawMessage `json:"capacity"`
}

func (req tallyRequest) fields() (string, *int64, error) {
	name := cleanText(jsonText(req.Name), 80)
	if name == "" {
		return "", nil, &httpError{400, "Give the tally a name"}
	}
	if isNull(req.Capacity) || string(req.Capacity) == `""` {
		return name, nil, nil
	}
	c, err := wholeNumber(req.Capacity, "Capacity")
	if err != nil {
		return "", nil, err
	}
	if c < 1 {
		return "", nil, &httpError{400, "Capacity must be above zero"}
	}
	return name, &c, nil
}

func (a *App) createTally(w http.ResponseWriter, r *http.Request) error {
	if !a.limits.create.Take(a.clientAddr(r)) {
		a.stats.limited.Add(1)
		return &httpError{429, "Too many new tallies from this network. Try again in a minute."}
	}
	var req tallyRequest
	if err := readJSON(r, &req); err != nil {
		return err
	}
	name, capacity, err := req.fields()
	if err != nil {
		return err
	}
	// Only the creating browser gets this key; it lets that browser edit the tally later.
	ownerKey := newOwnerKey()
	id := newID()
	if err := a.store.CreateTally(id, name, capacity, sha256Hex(ownerKey)); err != nil {
		return err
	}
	a.stats.newTallies.Add(1)
	writeJSON(w, r, 201, map[string]string{"id": id, "ownerKey": ownerKey})
	return nil
}

func (a *App) updateTally(w http.ResponseWriter, r *http.Request) error {
	t, err := a.tally(r.PathValue("id"))
	if err != nil {
		return err
	}
	stored, err := a.store.OwnerHash(t.ID)
	if err != nil {
		return err
	}
	given := sha256Hex(r.Header.Get("X-Owner-Key"))
	if stored == "" || subtle.ConstantTimeCompare([]byte(stored), []byte(given)) != 1 {
		return &httpError{403, "Only the person who started this tally can change it"}
	}
	var req tallyRequest
	if err := readJSON(r, &req); err != nil {
		return err
	}
	name, capacity, err := req.fields()
	if err != nil {
		return err
	}
	updated, err := a.store.UpdateTally(t.ID, name, capacity)
	if err != nil {
		return err
	}
	slog.Info("tally edited", "tally", t.ID)
	a.hub.TallyChanged(updated)
	writeJSON(w, r, 200, updated)
	return nil
}

// Counting

type entryRequest struct {
	Delta  json.RawMessage `json:"delta"`
	Who    json.RawMessage `json:"who"`
	OpID   json.RawMessage `json:"opId"`
	Device json.RawMessage `json:"device"`
	Undoes json.RawMessage `json:"undoes"`
}

func (a *App) addEntry(w http.ResponseWriter, r *http.Request) error {
	t, err := a.tally(r.PathValue("id"))
	if err != nil {
		return err
	}
	var req entryRequest
	if err := readJSON(r, &req); err != nil {
		return err
	}
	opID := jsonText(req.OpID)
	if !opIDPattern.MatchString(opID) {
		return &httpError{400, "Invalid operation id"}
	}
	entry, created, err := a.recordEntry(r, t, &req, opID)
	if err != nil {
		return err
	}
	status := 200
	if created {
		status = 201
	}
	writeJSON(w, r, status, entry)
	return nil
}

// recordEntry validates and stores a change under the write lock. It returns the existing
// entry, not created, for a retry. The reply is written after the lock is released, so a
// slow phone can't hold up everyone else's taps.
func (a *App) recordEntry(r *http.Request, t *Tally, req *entryRequest, opID string) (*Entry, bool, error) {
	a.store.write.Lock()
	defer a.store.write.Unlock()

	// Retries of the same tap return the original entry, even once the tally is closed or busy.
	if existing, err := a.store.EntryByOp(t.ID, opID); err == nil {
		return existing, false, nil
	} else if !errors.Is(err, errNotFound) {
		return nil, false, err
	}

	if t.ClosedAt != nil {
		return nil, false, &httpError{409, "Counting has closed for this tally"}
	}
	device := jsonText(req.Device)
	who := jsonText(req.Who)
	// Pages from before device ids existed are limited by name and address instead.
	phoneKey := t.ID + ":" + device
	if device == "" {
		phoneKey = t.ID + ":" + a.clientAddr(r) + ":" + who
	}
	if !a.limits.phone.Take(phoneKey) {
		a.stats.limitedOn(t.ID)
		return nil, false, &httpError{429, "Slow down a little"}
	}
	if !a.limits.tally.Take(t.ID) {
		a.stats.limitedOn(t.ID)
		return nil, false, &httpError{429, "This tally is very busy"}
	}

	delta, err := wholeNumber(req.Delta, "Amount")
	if err != nil {
		return nil, false, err
	}
	who = cleanText(who, 40)
	if who == "" {
		return nil, false, &httpError{400, "Name is required"}
	}
	if !devicePattern.MatchString(device) {
		return nil, false, &httpError{400, "Invalid device id"}
	}

	var undoes *int64
	if !isNull(req.Undoes) {
		cantUndo := &httpError{400, "That change can't be undone"}
		target, err := strconv.ParseInt(strings.Trim(string(req.Undoes), `"`), 10, 64)
		if err != nil {
			return nil, false, cantUndo
		}
		original, err := a.store.EntryByID(t.ID, target)
		if errors.Is(err, errNotFound) {
			return nil, false, cantUndo
		} else if err != nil {
			return nil, false, err
		}
		if original.Undoes != nil || original.Delta != -delta {
			return nil, false, cantUndo
		}
		if original.Device != device {
			return nil, false, &httpError{403, "You can only undo your own changes"}
		}
		if time.Since(time.UnixMilli(original.At)) > undoWindow {
			return nil, false, &httpError{400, "Too late to undo that change"}
		}
		if done, err := a.store.IsUndone(original.ID); err != nil {
			return nil, false, err
		} else if done {
			return nil, false, &httpError{409, "That change was already undone"}
		}
		undoes = &original.ID
	}

	total, visitors, err := a.store.LastTotals(t.ID)
	if err != nil {
		return nil, false, err
	}
	// Arrivals add to visitors and people leaving don't. An undo takes back only an arrival, which
	// makes its delta negative.
	if undoes == nil {
		visitors += max(delta, 0)
	} else {
		visitors += min(delta, 0)
	}
	entry, err := a.store.InsertEntry(t.ID, delta, total+delta, visitors, who, device, undoes, opID)
	if err != nil {
		return nil, false, err
	}
	a.stats.taps.Add(1)
	a.hub.Publish(t.ID, *entry, nearCapacity(t, entry.Total))
	return entry, true, nil
}

// nearCapacity reports whether total is at or above 90% of the tally's capacity.
func nearCapacity(t *Tally, total int64) bool {
	return t.Capacity != nil && total*10 >= *t.Capacity*9
}

// Reading

type snapshot struct {
	Tally   *Tally  `json:"tally"`
	URL     string  `json:"url"`
	Entries []Entry `json:"entries"`
	Count   int64   `json:"count"`
	Now     int64   `json:"now"`
}

func (a *App) snapshot(r *http.Request, t *Tally) (*snapshot, error) {
	entries, err := a.store.Recent(t.ID, snapshotLimit)
	if err != nil {
		return nil, err
	}
	n, err := a.store.Count(t.ID)
	if err != nil {
		return nil, err
	}
	return &snapshot{Tally: t, URL: a.baseURL(r) + "/t/" + t.ID, Entries: entries, Count: n, Now: time.Now().UnixMilli()}, nil
}

func (a *App) getSnapshot(w http.ResponseWriter, r *http.Request) error {
	t, err := a.tally(r.PathValue("id"))
	if err != nil {
		return err
	}
	snap, err := a.snapshot(r, t)
	if err != nil {
		return err
	}
	writeJSON(w, r, 200, snap)
	return nil
}

func (a *App) qr(w http.ResponseWriter, r *http.Request) error {
	t, err := a.tally(r.PathValue("id"))
	if err != nil {
		return err
	}
	svg, err := qrSVG(a.baseURL(r) + "/t/" + t.ID)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Cache-Control", "no-cache")
	io.WriteString(w, svg)
	return nil
}

// events streams live updates. Current pages ask for v=2 and say which entry they have
// (after=, or Last-Event-ID when the browser reconnects); they get only what they missed.
// Older pages get a full snapshot first, then each entry as it happens.
func (a *App) events(w http.ResponseWriter, r *http.Request) error {
	t, err := a.tally(r.PathValue("id"))
	if err != nil {
		return err
	}
	legacy := r.URL.Query().Get("v") != "2"
	sub, pages, err := a.hub.Subscribe(t.ID, a.clientAddr(r), legacy)
	if err != nil {
		slog.Info("page turned away", "tally", t.ID, "pages", pages)
		return err
	}
	defer a.hub.Unsubscribe(t.ID, sub)
	opened := time.Now()
	slog.Info("page opened", "tally", t.ID, "pages", pages, "legacy", legacy)
	why := "connection lost"
	defer func() {
		slog.Info("page closed", "tally", t.ID, "why", why, "seconds", int(time.Since(opened).Seconds()))
	}()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	rc := http.NewResponseController(w)
	write := func(b []byte) bool {
		// A phone that vanished without closing the connection shouldn't hold a goroutine forever.
		rc.SetWriteDeadline(time.Now().Add(15 * time.Second))
		if _, err := w.Write(b); err != nil {
			return false
		}
		return rc.Flush() == nil
	}

	first := []byte("retry: 2000\n\n")
	if legacy {
		snap, err := a.snapshot(r, t)
		if err != nil {
			why = "server error: " + err.Error()
			return nil
		}
		first = append(first, frame("snapshot", "", snap)...)
	} else {
		after, _ := strconv.ParseInt(r.Header.Get("Last-Event-ID"), 10, 64)
		if after == 0 {
			after, _ = strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
		}
		missed, err := a.store.After(t.ID, after, snapshotLimit+1)
		if err != nil {
			why = "server error: " + err.Error()
			return nil
		}
		// The tally may have been renamed or closed while the page was away.
		first = append(first, frame("tally", "", t)...)
		if len(missed) > snapshotLimit {
			first = append(first, frame("reset", "", struct{}{})...)
		} else if len(missed) > 0 {
			first = append(first, frame("entries", strconv.FormatInt(missed[len(missed)-1].ID, 10), missed)...)
		}
	}
	if !write(first) {
		return nil
	}

	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case f, ok := <-sub.frames:
			if !ok {
				why = "tally deleted"
				return nil
			}
			if !write(f) {
				return nil
			}
		case <-ping.C:
			if !write([]byte(": ping\n\n")) {
				return nil
			}
		case <-sub.gone:
			why = "fell behind"
			return nil
		case <-r.Context().Done():
			why = "closed"
			return nil
		}
	}
}

// Admin

func (a *App) isAdmin(key string) bool {
	return a.adminKey != "" && subtle.ConstantTimeCompare([]byte(key), []byte(a.adminKey)) == 1
}

func (a *App) adminPage(w http.ResponseWriter, r *http.Request) {
	if !a.isAdmin(r.PathValue("key")) {
		writeError(w, &httpError{404, "Not found"})
		return
	}
	a.static.Serve(w, r, "admin.html", 200)
}

// admin wraps a handler so it runs only for the admin key. A wrong key gets the same 404 as any
// unknown address.
func (a *App) admin(fn func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
	return a.handle(func(w http.ResponseWriter, r *http.Request) error {
		if !a.isAdmin(r.PathValue("key")) {
			return &httpError{404, "Not found"}
		}
		return fn(w, r)
	})
}

func (a *App) adminList(w http.ResponseWriter, r *http.Request) error {
	list, err := a.store.Summaries()
	if err != nil {
		return err
	}
	writeJSON(w, r, 200, list)
	return nil
}

func (a *App) adminDelete(w http.ResponseWriter, r *http.Request) error {
	t, err := a.tally(r.PathValue("id"))
	if err != nil {
		return err
	}
	if err := a.store.DeleteTally(t.ID); err != nil {
		return err
	}
	slog.Info("tally deleted", "tally", t.ID)
	a.hub.Deleted(t.ID)
	writeJSON(w, r, 200, map[string]string{"deleted": t.ID})
	return nil
}

// adminAction handles POST close, reopen and owner-key, and GET export.csv and log.csv.
func (a *App) adminAction(w http.ResponseWriter, r *http.Request) error {
	t, err := a.tally(r.PathValue("id"))
	if err != nil {
		return err
	}
	action := r.PathValue("action")
	switch {
	case r.Method == http.MethodPost && (action == "close" || action == "reopen"):
		updated, err := a.store.SetClosed(t.ID, action == "close")
		if err != nil {
			return err
		}
		slog.Info("tally "+action, "tally", t.ID)
		a.hub.TallyChanged(updated)
		writeJSON(w, r, 200, updated)
		return nil
	case r.Method == http.MethodPost && action == "owner-key":
		// Replaces the stored hash, so any earlier owner key stops working.
		ownerKey := newOwnerKey()
		if err := a.store.SetOwnerHash(t.ID, sha256Hex(ownerKey)); err != nil {
			return err
		}
		slog.Info("tally owner key reissued", "tally", t.ID)
		writeJSON(w, r, 200, map[string]string{"ownerKey": ownerKey, "url": a.baseURL(r) + "/t/" + t.ID + "#owner=" + ownerKey})
		return nil
	case r.Method == http.MethodGet && action == "export.csv":
		return a.exportCSV(w, t)
	case r.Method == http.MethodGet && action == "log.csv":
		return a.exportLog(w, t)
	}
	return &httpError{404, "Not found"}
}
