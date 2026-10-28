package main

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// maxDelta is the largest change, either way, one entry can make.
const maxDelta = 1_000_000

// invisible reports characters that can make two names look identical:
// control characters, zero-width characters and text-direction overrides.
func invisible(r rune) bool {
	return r < 0x20 || r == 0x7f ||
		(r >= 0x200b && r <= 0x200f) ||
		(r >= 0x202a && r <= 0x202e) ||
		(r >= 0x2060 && r <= 0x2069) ||
		r == 0xfeff
}

// cleanText drops invisible characters, collapses runs of white space to one space, trims the
// ends and cuts the result to limit characters.
func cleanText(s string, limit int) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		if unicode.IsSpace(r) {
			space = true
			continue
		}
		if invisible(r) {
			continue
		}
		if space && b.Len() > 0 {
			b.WriteByte(' ')
		}
		space = false
		b.WriteRune(r)
	}
	out := []rune(b.String())
	if len(out) > limit {
		out = out[:limit]
	}
	return strings.TrimSpace(string(out))
}

// jsonText reads a JSON value the way the pages send it: a string, a number, or nothing.
func jsonText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		return n.String()
	}
	return ""
}

// isNull reports whether a field was missing or null.
func isNull(raw json.RawMessage) bool {
	return len(raw) == 0 || string(raw) == "null"
}

// wholeNumber accepts a JSON number, or a string holding one, as form inputs send.
func wholeNumber(raw json.RawMessage, label string) (int64, error) {
	bad := &httpError{400, fmt.Sprintf("%s must be a whole number, at most 1,000,000 either way", label)}
	var f float64
	if err := json.Unmarshal(raw, &f); err != nil {
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return 0, bad
		}
		if f, err = strconv.ParseFloat(strings.TrimSpace(s), 64); err != nil {
			return 0, bad
		}
	}
	if f != math.Trunc(f) || f == 0 || math.Abs(f) > maxDelta {
		return 0, bad
	}
	return int64(f), nil
}

var (
	opIDPattern    = regexp.MustCompile(`^[A-Za-z0-9-]{8,64}$`)
	devicePattern  = regexp.MustCompile(`^[a-f0-9]{0,32}$`)
	tallyIDPattern = regexp.MustCompile(`^[a-z0-9]+$`)
)
