package main

import (
	"log/slog"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// Stats are counted as they happen and logged as one line a minute, only when something
// happened. No names or addresses are logged.
type Stats struct {
	taps, newTallies, limited, droppedPages, rejectedStreams, serverErrors atomic.Int64

	mu             sync.Mutex
	limitedByTally map[string]int64
}

// limitedOn counts a refused tap against its tally too, logged as one line a minute per tally.
func (s *Stats) limitedOn(tallyID string) {
	s.limited.Add(1)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.limitedByTally == nil {
		s.limitedByTally = map[string]int64{}
	}
	s.limitedByTally[tallyID]++
}

// logEvery logs and resets the counts each interval until stop closes.
func (s *Stats) logEvery(interval time.Duration, hub *Hub, stop <-chan struct{}) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
		}
		taps, created, limited := s.taps.Swap(0), s.newTallies.Swap(0), s.limited.Swap(0)
		dropped, rejected, errs := s.droppedPages.Swap(0), s.rejectedStreams.Swap(0), s.serverErrors.Swap(0)
		s.mu.Lock()
		byTally := s.limitedByTally
		s.limitedByTally = nil
		s.mu.Unlock()
		for id, n := range byTally {
			slog.Info("taps refused", "tally", id, "count", n)
		}
		pages, tallies := hub.OpenPages()
		if taps+created+limited+dropped+rejected+errs == 0 && pages == 0 {
			continue
		}
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		slog.Info("activity",
			"taps", taps, "newTallies", created, "openPages", pages, "liveTallies", tallies,
			"rateLimited", limited, "droppedPages", dropped, "rejectedPages", rejected, "serverErrors", errs,
			"heapMB", m.HeapAlloc>>20, "goroutines", runtime.NumGoroutine())
	}
}
