package main

import (
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// exportCSV sends every change to the tally, for admin.
func (a *App) exportCSV(w http.ResponseWriter, t *Tally) error {
	entries, err := a.store.All(t.ID)
	if err != nil {
		return err
	}
	rows := make([][]any, len(entries))
	for i, e := range entries {
		var undoes any
		if e.Undoes != nil {
			undoes = *e.Undoes
		}
		rows[i] = []any{csvTime(e.At), e.Who, e.Delta, e.Total, e.Visitors, undoes}
	}
	writeCSV(w, t, "", "time_utc,who,change,total,visitors,undoes_change", rows)
	return nil
}

// exportLog sends the tally's log, for admin.
func (a *App) exportLog(w http.ResponseWriter, t *Tally) error {
	lines, err := a.store.TallyLog(t)
	if err != nil {
		return err
	}
	rows := make([][]any, len(lines))
	for i, l := range lines {
		scope := "server"
		if l.Tally != "" {
			scope = "tally"
		}
		rows[i] = []any{csvTime(l.At), scope, l.Event, l.Detail}
	}
	writeCSV(w, t, "-log", "time_utc,scope,event,detail", rows)
	return nil
}

// csvTime formats Unix milliseconds as UTC ISO 8601.
func csvTime(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z") }

// writeCSV sends rows as a download named after the tally.
func writeCSV(w http.ResponseWriter, t *Tally, suffix, header string, rows [][]any) {
	var b strings.Builder
	b.WriteString(header + "\r\n")
	for _, cells := range rows {
		for i, c := range cells {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(csvCell(c))
		}
		b.WriteString("\r\n")
	}
	file := strings.Trim(slugPattern.ReplaceAllString(strings.ToLower(t.Name), "-"), "-")
	if file == "" {
		file = t.ID
	}
	h := w.Header()
	h.Set("Content-Type", "text/csv; charset=utf-8")
	h.Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s%s.csv"`, file, suffix))
	h.Set("Cache-Control", "no-store")
	io.WriteString(w, b.String())
}

// slugPattern matches runs of characters a download's file name leaves out.
var slugPattern = regexp.MustCompile(`[^a-z0-9]+`)

// csvCell formats one CSV value, quoting it when needed. nil is an empty cell.
func csvCell(v any) string {
	var s string
	switch x := v.(type) {
	case string:
		s = x
		// Stops spreadsheet apps treating a name like "=SUM(...)" as a formula.
		if s != "" && strings.ContainsRune("=+-@\t\r", rune(s[0])) {
			s = "'" + s
		}
	case nil:
	default:
		s = fmt.Sprint(x)
	}
	if strings.ContainsAny(s, "\",\r\n") {
		s = `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
	}
	return s
}
