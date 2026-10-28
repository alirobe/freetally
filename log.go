package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"
)

// logHandler writes each log line to stdout and to the database. Fly keeps only a short stretch
// of stdout, and the database copy lets a tally's log be downloaded after the event.
type logHandler struct {
	slog.Handler
	store *Store
	attrs []slog.Attr
}

func newLogHandler(inner slog.Handler, store *Store) *logHandler {
	return &logHandler{Handler: inner, store: store}
}

// Handle writes the line to both. A "tally" attribute files it under that tally; the rest go
// into the detail as JSON.
func (h *logHandler) Handle(ctx context.Context, r slog.Record) error {
	err := h.Handler.Handle(ctx, r)
	tally := ""
	detail := map[string]any{}
	if r.Level != slog.LevelInfo {
		detail["level"] = r.Level.String()
	}
	add := func(a slog.Attr) bool {
		if a.Key == "tally" {
			tally = a.Value.String()
		} else {
			detail[a.Key] = a.Value.Resolve().Any()
			if e, ok := detail[a.Key].(error); ok {
				detail[a.Key] = e.Error()
			}
		}
		return true
	}
	for _, a := range h.attrs {
		add(a)
	}
	r.Attrs(add)
	var body []byte
	if len(detail) > 0 {
		body, _ = json.Marshal(detail)
	}
	h.store.AddLog(r.Time, tally, r.Message, string(body))
	return err
}

func (h *logHandler) WithAttrs(as []slog.Attr) slog.Handler {
	return &logHandler{h.Handler.WithAttrs(as), h.store, append(h.attrs[:len(h.attrs):len(h.attrs)], as...)}
}

func (h *logHandler) WithGroup(name string) slog.Handler {
	return &logHandler{h.Handler.WithGroup(name), h.store, h.attrs}
}

// LogLine is one line of the log as stored. Tally is "" for server-wide lines.
type LogLine struct {
	At     int64
	Tally  string
	Event  string
	Detail string
}

// AddLog stores a log line. A failed write is dropped: logging it would only fail again.
func (s *Store) AddLog(at time.Time, tally, event, detail string) {
	var t any
	if tally != "" {
		t = tally
	}
	s.db.Exec(`INSERT INTO log (at, tally_id, event, detail) VALUES (?, ?, ?, ?)`, at.UnixMilli(), t, event, detail)
}

// TallyLog is the tally's own lines, with the server-wide lines (starts, stops, activity) from
// its lifetime around them.
func (s *Store) TallyLog(t *Tally) ([]LogLine, error) {
	rows, err := s.db.Query(`
		SELECT at, COALESCE(tally_id, ''), event, detail FROM log
		WHERE tally_id = ? OR (tally_id IS NULL AND at >= ?)
		ORDER BY id`, t.ID, t.CreatedAt)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LogLine
	for rows.Next() {
		var l LogLine
		if err := rows.Scan(&l.At, &l.Tally, &l.Event, &l.Detail); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// PruneLog deletes log lines older than before.
func (s *Store) PruneLog(before time.Time) error {
	_, err := s.db.Exec(`DELETE FROM log WHERE at < ?`, before.UnixMilli())
	return err
}
