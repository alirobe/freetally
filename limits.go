package main

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// Rate limits. A venue's phones usually share one public IP, so counting is limited
// per phone and per tally rather than per IP. All limits sit well above real use.

type bucket struct {
	tokens float64
	at     time.Time
}

// Buckets is a token bucket per key: each refills at perSecond and holds up to burst.
type Buckets struct {
	mu        sync.Mutex
	perSecond float64
	burst     float64
	m         map[string]*bucket
}

func newBuckets(perSecond, burst float64) *Buckets {
	return &Buckets{perSecond: perSecond, burst: burst, m: map[string]*bucket{}}
}

// Take spends a token from key's bucket, reporting false when it's empty.
func (b *Buckets) Take(key string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	k := b.m[key]
	if k == nil {
		k = &bucket{tokens: b.burst, at: now}
		b.m[key] = k
	}
	k.tokens = min(b.burst, k.tokens+now.Sub(k.at).Seconds()*b.perSecond)
	k.at = now
	if k.tokens < 1 {
		return false
	}
	k.tokens--
	return true
}

// Sweep forgets keys idle long enough to have refilled, so memory stays flat.
func (b *Buckets) Sweep() {
	b.mu.Lock()
	defer b.mu.Unlock()
	cutoff := time.Now().Add(-5 * time.Minute)
	for key, k := range b.m {
		if k.at.Before(cutoff) {
			delete(b.m, key)
		}
	}
}

// Limits holds the server's rate limits.
type Limits struct {
	phone, tally, create *Buckets
}

func newLimits() *Limits {
	return &Limits{
		phone:  newBuckets(10, 20),      // fast thumbs manage 6-8 taps a second
		tally:  newBuckets(200, 400),    // 50 people tapping flat out, with room to spare
		create: newBuckets(30.0/60, 30), // 30 new tallies a minute per address
	}
}

// Sweep forgets idle keys in every limit.
func (l *Limits) Sweep() {
	l.phone.Sweep()
	l.tally.Sweep()
	l.create.Sweep()
}

// clientAddr is the address that per-address limits count against. Any client can send any header,
// so one is only believed when CLIENT_IP_HEADER names it, which says a proxy in front sets it on
// every request. An IPv6 address is cut to its /64, since one home or phone holds the whole block.
func (a *App) clientAddr(r *http.Request) string {
	ip := ""
	if a.ipHeader != "" {
		v := r.Header.Get(a.ipHeader)
		if a.ipHeader == "X-Forwarded-For" {
			// Each proxy appends the address it saw, so only the last entry came from ours.
			v = v[strings.LastIndex(v, ",")+1:]
		}
		ip = strings.TrimSpace(v)
	}
	if ip == "" {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		ip = host
	}
	if addr, err := netip.ParseAddr(ip); err == nil && addr.Is6() && !addr.Is4In6() {
		prefix, _ := addr.Prefix(64)
		return prefix.String()
	}
	return ip
}
