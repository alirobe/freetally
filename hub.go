package main

import (
	"encoding/json"
	"strconv"
	"sync"
	"time"
)

// Live updates. Pages from before batching ("legacy") get each entry as it happens. Current
// pages get entries in batches, sent when the first of these happens:
//   - batchSize changes are waiting
//   - the door goes quiet for batchQuiet
//   - the oldest waiting change is batchMaxWait old, so a slow trickle still shows
//   - the tally is near capacity, when a stale count could let someone in over the limit
const (
	batchSize          = 20
	maxStreamsPerTally = 500
	// Each open page costs memory, so these keep a flood of them from taking the server down.
	// One address can still fill a tally, since a venue's phones usually share one.
	maxStreams        = 2000
	maxStreamsPerAddr = 500
	subscriberBuffer  = 64
)

// subscriber is one open page's live stream.
type subscriber struct {
	// Encoded events waiting to be written. Closed when the tally is deleted.
	frames chan []byte
	legacy bool
	addr   string
	// Closed when the page has fallen behind and should be cut off.
	gone chan struct{}
	once sync.Once
}

// drop cuts the page off. It's safe to call more than once.
func (s *subscriber) drop() { s.once.Do(func() { close(s.gone) }) }

// room is one tally's open pages and the entries waiting for the next batch.
type room struct {
	subs    map[*subscriber]struct{}
	pending []Entry
	firstAt time.Time
	timer   *time.Timer
	// Bumped whenever the timer is replaced, so a timer that fired just as it was stopped does nothing.
	timerGen int
}

// Hub passes each tally's changes to the pages that have it open.
type Hub struct {
	mu    sync.Mutex
	rooms map[string]*room
	// Open streams in all, and by client address.
	streams      int
	byAddr       map[string]int
	batchQuiet   time.Duration
	batchMaxWait time.Duration
	stats        *Stats
}

func newHub(quiet, maxWait time.Duration, stats *Stats) *Hub {
	return &Hub{rooms: map[string]*room{}, byAddr: map[string]int{}, batchQuiet: quiet, batchMaxWait: maxWait, stats: stats}
}

var (
	errTooManyStreams     = &httpError{503, "Too many people have this tally open"}
	errServerFull         = &httpError{503, "Too many pages are open right now"}
	errTooManyFromNetwork = &httpError{429, "Too many pages are open from this network"}
)

// Subscribe also reports how many pages have the tally open, this one included.
func (h *Hub) Subscribe(tallyID, addr string, legacy bool) (*subscriber, int, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[tallyID]
	pages := 0
	if r != nil {
		pages = len(r.subs)
	}
	var err error
	switch {
	case pages >= maxStreamsPerTally:
		err = errTooManyStreams
	case h.streams >= maxStreams:
		err = errServerFull
	case h.byAddr[addr] >= maxStreamsPerAddr:
		err = errTooManyFromNetwork
	}
	if err != nil {
		h.stats.rejectedStreams.Add(1)
		return nil, pages, err
	}
	if r == nil {
		r = &room{subs: map[*subscriber]struct{}{}}
		h.rooms[tallyID] = r
	}
	s := &subscriber{frames: make(chan []byte, subscriberBuffer), legacy: legacy, addr: addr, gone: make(chan struct{})}
	r.subs[s] = struct{}{}
	h.streams++
	h.byAddr[addr]++
	return s, len(r.subs), nil
}

func (h *Hub) Unsubscribe(tallyID string, s *subscriber) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.streams--
	if h.byAddr[s.addr]--; h.byAddr[s.addr] <= 0 {
		delete(h.byAddr, s.addr)
	}
	if r := h.rooms[tallyID]; r != nil {
		delete(r.subs, s)
		h.removeIfIdle(tallyID, r)
	}
}

// removeIfIdle forgets a room with no pages and nothing waiting. Callers hold h.mu.
func (h *Hub) removeIfIdle(tallyID string, r *room) {
	if len(r.subs) == 0 && len(r.pending) == 0 {
		if r.timer != nil {
			r.timer.Stop()
		}
		delete(h.rooms, tallyID)
	}
}

// send queues a frame without blocking. A page whose queue is full has stopped reading
// (a phone asleep with the page open); dropping it lets it reconnect and catch up.
func (h *Hub) send(s *subscriber, frame []byte) {
	select {
	case s.frames <- frame:
	default:
		h.stats.droppedPages.Add(1)
		s.drop()
	}
}

// frame encodes one Server-Sent Events message. Empty event or id fields are left out.
func frame(event, id string, data any) []byte {
	body, _ := json.Marshal(data)
	b := make([]byte, 0, len(body)+40)
	if id != "" {
		b = append(b, "id: "...)
		b = append(b, id...)
		b = append(b, '\n')
	}
	if event != "" {
		b = append(b, "event: "...)
		b = append(b, event...)
		b = append(b, '\n')
	}
	b = append(b, "data: "...)
	b = append(b, body...)
	return append(b, '\n', '\n')
}

// Publish passes a new entry to the tally's pages: at once to legacy pages, and into the next
// batch for current ones. urgent sends the batch straight away.
func (h *Hub) Publish(tallyID string, e Entry, urgent bool) {
	e.OpID = ""
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[tallyID]
	if r == nil {
		return
	}
	var legacyFrame []byte
	hasCurrent := false
	for s := range r.subs {
		if !s.legacy {
			hasCurrent = true
			continue
		}
		if legacyFrame == nil {
			legacyFrame = frame("", "", e)
		}
		h.send(s, legacyFrame)
	}
	if !hasCurrent {
		return
	}
	if len(r.pending) == 0 {
		r.firstAt = time.Now()
	}
	r.pending = append(r.pending, e)
	if urgent || len(r.pending) >= batchSize {
		h.flush(tallyID, r)
		return
	}
	wait := min(h.batchQuiet, time.Until(r.firstAt.Add(h.batchMaxWait)))
	if r.timer != nil {
		r.timer.Stop()
	}
	r.timerGen++
	gen := r.timerGen
	r.timer = time.AfterFunc(wait, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.rooms[tallyID] == r && r.timerGen == gen {
			h.flush(tallyID, r)
		}
	})
}

// flush sends waiting entries as one event, encoded once for every page. Callers hold h.mu.
func (h *Hub) flush(tallyID string, r *room) {
	if r.timer != nil {
		r.timer.Stop()
		r.timer = nil
	}
	r.timerGen++
	if len(r.pending) == 0 {
		return
	}
	last := r.pending[len(r.pending)-1].ID
	f := frame("entries", strconv.FormatInt(last, 10), r.pending)
	r.pending = nil
	for s := range r.subs {
		if !s.legacy {
			h.send(s, f)
		}
	}
	h.removeIfIdle(tallyID, r)
}

// TallyChanged tells every page about a new name, capacity or closing. Waiting entries go first.
func (h *Hub) TallyChanged(t *Tally) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[t.ID]
	if r == nil {
		return
	}
	h.flush(t.ID, r)
	f := frame("tally", "", t)
	for s := range r.subs {
		h.send(s, f)
	}
}

// Deleted tells the tally's pages it's gone and ends their streams.
func (h *Hub) Deleted(tallyID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[tallyID]
	if r == nil {
		return
	}
	if r.timer != nil {
		r.timer.Stop()
	}
	f := frame("deleted", "", struct{}{})
	for s := range r.subs {
		h.send(s, f)
		// Closing after the frame lets the page read it, then the stream ends.
		close(s.frames)
	}
	delete(h.rooms, tallyID)
}

// OpenPages counts open pages, and the tallies they're on.
func (h *Hub) OpenPages() (pages, tallies int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, r := range h.rooms {
		if len(r.subs) > 0 {
			tallies++
			pages += len(r.subs)
		}
	}
	return
}
