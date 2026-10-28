package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// Tally is one shared count. Times are Unix milliseconds throughout.
type Tally struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"createdAt"`
	Capacity  *int64 `json:"capacity"`
	ClosedAt  *int64 `json:"closedAt"`
}

// Entry is one change to a tally. Entries are never edited or removed: an undo is a new entry
// that reverses an earlier one.
type Entry struct {
	ID    int64 `json:"id"`
	Delta int64 `json:"delta"`
	// The number inside after this change.
	Total int64 `json:"total"`
	// Everyone counted in so far: arrivals add, people leaving don't take away, undoing an arrival does.
	Visitors int64  `json:"visitors"`
	Who      string `json:"who"`
	Device   string `json:"device,omitempty"`
	Undoes   *int64 `json:"undoes,omitempty"`
	// Only the reply to the phone that sent it carries the operation id.
	OpID string `json:"opId,omitempty"`
	At   int64  `json:"at"`
}

// deviceOnWire is how much of a device id pages see: enough to tell a tally's phones apart. The
// full id would be a third of each entry's bytes, and it stays on the server to decide who may undo.
const deviceOnWire = 8

// MarshalJSON shortens the device id to deviceOnWire characters.
func (e Entry) MarshalJSON() ([]byte, error) {
	type wire Entry
	if len(e.Device) > deviceOnWire {
		e.Device = e.Device[:deviceOnWire]
	}
	return json.Marshal(wire(e))
}

// TallySummary is a tally with its figures, for the admin list.
type TallySummary struct {
	Tally
	Changes  int64  `json:"changes"`
	People   int64  `json:"people"`
	LastAt   *int64 `json:"lastAt"`
	Total    int64  `json:"total"`
	Visitors int64  `json:"visitors"`
}

// Store keeps tallies, entries and the log in one SQLite database.
type Store struct {
	db *sql.DB
	// Serialises writes, so reading the last total and inserting the next can't interleave.
	write sync.Mutex
}

// errNotFound is returned by lookups that find no row.
var errNotFound = errors.New("not found")

// openStore opens or creates the database in dir and brings its schema up to date.
func openStore(dir string) (*Store, error) {
	// WAL lets reads run alongside a write; synchronous=NORMAL is safe with WAL and much faster.
	dsn := filepath.Join(dir, "freetally.db") +
		"?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

// migrate creates the first release's tables, then adds anything newer. It only ever adds, so an
// older server can still read the database.
func (s *Store) migrate() error {
	_, err := s.db.Exec(`
		CREATE TABLE IF NOT EXISTS tallies (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS entries (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			tally_id TEXT NOT NULL REFERENCES tallies(id),
			delta INTEGER NOT NULL,
			total INTEGER NOT NULL,
			who TEXT NOT NULL,
			op_id TEXT NOT NULL,
			at INTEGER NOT NULL,
			UNIQUE (tally_id, op_id)
		);
		CREATE INDEX IF NOT EXISTS entries_by_tally ON entries (tally_id, id);
		CREATE TABLE IF NOT EXISTS log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			at INTEGER NOT NULL,
			tally_id TEXT,
			event TEXT NOT NULL,
			detail TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS log_by_tally ON log (tally_id, id);
		CREATE INDEX IF NOT EXISTS log_by_time ON log (at);`)
	if err != nil {
		return err
	}
	// Columns added after the first release. Existing databases gain them on startup.
	for _, c := range []struct{ table, column, def string }{
		{"tallies", "capacity", "INTEGER"},
		{"tallies", "closed_at", "INTEGER"},
		{"tallies", "owner_key_hash", "TEXT"},
		{"entries", "device", "TEXT NOT NULL DEFAULT ''"},
		{"entries", "undoes", "INTEGER"},
	} {
		if _, err := s.addColumn(c.table, c.column, c.def); err != nil {
			return err
		}
	}
	if _, err = s.db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS entries_undo ON entries (undoes) WHERE undoes IS NOT NULL`); err != nil {
		return err
	}
	added, err := s.addColumn("entries", "visitors", "INTEGER NOT NULL DEFAULT 0")
	if err != nil || !added {
		return err
	}
	// Work out the visitors figure for entries made before it was stored, by the same rule as new ones.
	_, err = s.db.Exec(`
		WITH running AS (
			SELECT e.id, SUM(CASE WHEN e.undoes IS NULL THEN MAX(e.delta, 0) ELSE MIN(e.delta, 0) END)
				OVER (PARTITION BY e.tally_id ORDER BY e.id) AS visitors
			FROM entries e
		)
		UPDATE entries SET visitors = running.visitors FROM running WHERE running.id = entries.id`)
	return err
}

// addColumn adds the column if the table lacks it, and reports whether it did.
func (s *Store) addColumn(table, column, def string) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?`, table, column).Scan(&n)
	if err != nil || n > 0 {
		return false, err
	}
	_, err = s.db.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", table, column, def))
	return err == nil, err
}

// Column lists in the order scanTally and scanEntry read them.
const (
	tallyCols = `id, name, created_at, capacity, closed_at`
	entryCols = `id, delta, total, visitors, who, device, undoes, op_id, at`
)

// scanner is a *sql.Row or *sql.Rows.
type scanner interface{ Scan(...any) error }

func scanTally(r scanner) (*Tally, error) {
	var t Tally
	err := r.Scan(&t.ID, &t.Name, &t.CreatedAt, &t.Capacity, &t.ClosedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errNotFound
	}
	return &t, err
}

func scanEntry(r scanner) (*Entry, error) {
	var e Entry
	err := r.Scan(&e.ID, &e.Delta, &e.Total, &e.Visitors, &e.Who, &e.Device, &e.Undoes, &e.OpID, &e.At)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errNotFound
	}
	return &e, err
}

func (s *Store) Tally(id string) (*Tally, error) {
	return scanTally(s.db.QueryRow(`SELECT `+tallyCols+` FROM tallies WHERE id = ?`, id))
}

// OwnerHash returns the hash of the tally's owner key, or "" for a tally from before owner keys.
func (s *Store) OwnerHash(id string) (string, error) {
	var h sql.NullString
	err := s.db.QueryRow(`SELECT owner_key_hash FROM tallies WHERE id = ?`, id).Scan(&h)
	return h.String, err
}

func (s *Store) CreateTally(id, name string, capacity *int64, ownerHash string) error {
	s.write.Lock()
	defer s.write.Unlock()
	_, err := s.db.Exec(`INSERT INTO tallies (id, name, created_at, capacity, owner_key_hash) VALUES (?, ?, ?, ?, ?)`,
		id, name, time.Now().UnixMilli(), capacity, ownerHash)
	return err
}

func (s *Store) UpdateTally(id, name string, capacity *int64) (*Tally, error) {
	s.write.Lock()
	defer s.write.Unlock()
	if _, err := s.db.Exec(`UPDATE tallies SET name = ?, capacity = ? WHERE id = ?`, name, capacity, id); err != nil {
		return nil, err
	}
	return s.Tally(id)
}

func (s *Store) SetOwnerHash(id, ownerHash string) error {
	s.write.Lock()
	defer s.write.Unlock()
	res, err := s.db.Exec(`UPDATE tallies SET owner_key_hash = ? WHERE id = ?`, ownerHash, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return errNotFound
	}
	return nil
}

// SetClosed closes the tally to counting, or reopens it.
func (s *Store) SetClosed(id string, closed bool) (*Tally, error) {
	s.write.Lock()
	defer s.write.Unlock()
	var at *int64
	if closed {
		now := time.Now().UnixMilli()
		at = &now
	}
	if _, err := s.db.Exec(`UPDATE tallies SET closed_at = ? WHERE id = ?`, at, id); err != nil {
		return nil, err
	}
	return s.Tally(id)
}

// DeleteTally removes the tally with its entries and log lines.
func (s *Store) DeleteTally(id string) error {
	s.write.Lock()
	defer s.write.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM entries WHERE tally_id = ?`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM log WHERE tally_id = ?`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM tallies WHERE id = ?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// EntryByOp finds the entry a tap's operation id recorded, so a retry returns it.
func (s *Store) EntryByOp(tallyID, opID string) (*Entry, error) {
	return scanEntry(s.db.QueryRow(`SELECT `+entryCols+` FROM entries WHERE tally_id = ? AND op_id = ?`, tallyID, opID))
}

func (s *Store) EntryByID(tallyID string, id int64) (*Entry, error) {
	return scanEntry(s.db.QueryRow(`SELECT `+entryCols+` FROM entries WHERE tally_id = ? AND id = ?`, tallyID, id))
}

// IsUndone reports whether a later entry undoes entry id.
func (s *Store) IsUndone(id int64) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM entries WHERE undoes = ?`, id).Scan(&n)
	return n > 0, err
}

// LastTotals returns the tally's current total and visitors, both 0 before its first entry.
// Callers hold s.write, so the figures can't change before InsertEntry uses them.
func (s *Store) LastTotals(tallyID string) (total, visitors int64, err error) {
	err = s.db.QueryRow(`SELECT total, visitors FROM entries WHERE tally_id = ? ORDER BY id DESC LIMIT 1`, tallyID).Scan(&total, &visitors)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, 0, nil
	}
	return total, visitors, err
}

// InsertEntry records a change with the running figures the caller worked out. Callers hold s.write.
func (s *Store) InsertEntry(tallyID string, delta, total, visitors int64, who, device string, undoes *int64, opID string) (*Entry, error) {
	return scanEntry(s.db.QueryRow(
		`INSERT INTO entries (tally_id, delta, total, visitors, who, device, undoes, op_id, at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING `+entryCols,
		tallyID, delta, total, visitors, who, device, undoes, opID, time.Now().UnixMilli()))
}

// entries runs a query for entries. Operation ids are left out: only the phone that sent a
// change gets its id back, in the reply to that request.
func (s *Store) entries(query string, args ...any) ([]Entry, error) {
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Entry{}
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			return nil, err
		}
		e.OpID = ""
		list = append(list, *e)
	}
	return list, rows.Err()
}

// Recent returns the newest entries first.
func (s *Store) Recent(tallyID string, limit int) ([]Entry, error) {
	return s.entries(`SELECT `+entryCols+` FROM entries WHERE tally_id = ? ORDER BY id DESC LIMIT ?`, tallyID, limit)
}

// After returns entries newer than an id, oldest first.
func (s *Store) After(tallyID string, afterID int64, limit int) ([]Entry, error) {
	return s.entries(`SELECT `+entryCols+` FROM entries WHERE tally_id = ? AND id > ? ORDER BY id LIMIT ?`, tallyID, afterID, limit)
}

// All returns every entry, oldest first, for the CSV export.
func (s *Store) All(tallyID string) ([]Entry, error) {
	return s.entries(`SELECT `+entryCols+` FROM entries WHERE tally_id = ? ORDER BY id`, tallyID)
}

func (s *Store) Count(tallyID string) (int64, error) {
	var n int64
	err := s.db.QueryRow(`SELECT COUNT(*) FROM entries WHERE tally_id = ?`, tallyID).Scan(&n)
	return n, err
}

// Summaries lists every tally, most recently used first.
func (s *Store) Summaries() ([]TallySummary, error) {
	rows, err := s.db.Query(`
		SELECT t.id, t.name, t.created_at, t.capacity, t.closed_at,
			COUNT(e.id), COUNT(DISTINCT e.who), MAX(e.at),
			COALESCE((SELECT total FROM entries WHERE tally_id = t.id ORDER BY id DESC LIMIT 1), 0),
			COALESCE((SELECT visitors FROM entries WHERE tally_id = t.id ORDER BY id DESC LIMIT 1), 0)
		FROM tallies t LEFT JOIN entries e ON e.tally_id = t.id
		GROUP BY t.id
		ORDER BY COALESCE(MAX(e.at), t.created_at) DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []TallySummary{}
	for rows.Next() {
		var t TallySummary
		if err := rows.Scan(&t.ID, &t.Name, &t.CreatedAt, &t.Capacity, &t.ClosedAt,
			&t.Changes, &t.People, &t.LastAt, &t.Total, &t.Visitors); err != nil {
			return nil, err
		}
		list = append(list, t)
	}
	return list, rows.Err()
}
