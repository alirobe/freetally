package main

import (
	"encoding/json"
	"testing"
)

func TestCleanText(t *testing.T) {
	zeroWidth, rtlOverride, bom := string(rune(0x200b)), string(rune(0x202e)), string(rune(0xfeff))
	for _, c := range []struct {
		in    string
		limit int
		want  string
	}{
		{"  Sam  ", 40, "Sam"},
		{"a \n\t b", 40, "a b"},
		{"Sam" + zeroWidth + "my", 40, "Sammy"},
		{rtlOverride + "evil" + bom, 40, "evil"},
		{"bell\x07", 40, "bell"},
		{"abcdef", 3, "abc"},
		{"ééé", 2, "éé"},
		{"ab cd", 3, "ab"},
		{zeroWidth + " " + zeroWidth, 40, ""},
	} {
		if got := cleanText(c.in, c.limit); got != c.want {
			t.Errorf("cleanText(%q, %d) = %q, want %q", c.in, c.limit, got, c.want)
		}
	}
}

func TestWholeNumber(t *testing.T) {
	for _, c := range []struct {
		raw  string
		want int64
		ok   bool
	}{
		{`5`, 5, true},
		{`-1`, -1, true},
		{`"7"`, 7, true},
		{`" -3 "`, -3, true},
		{`1e3`, 1000, true},
		{`1000000`, 1000000, true},
		{`-1000000`, -1000000, true},
		{`1000001`, 0, false},
		{`1.5`, 0, false},
		{`0`, 0, false},
		{`null`, 0, false},
		{`true`, 0, false},
		{`"abc"`, 0, false},
		{``, 0, false},
	} {
		got, err := wholeNumber(json.RawMessage(c.raw), "Amount")
		if (err == nil) != c.ok || got != c.want {
			t.Errorf("wholeNumber(%s) = %d, %v; want %d, ok=%v", c.raw, got, err, c.want, c.ok)
		}
	}
}

func TestJSONText(t *testing.T) {
	for raw, want := range map[string]string{
		`"Sam"`: "Sam",
		`12`:    "12",
		`null`:  "",
		`{}`:    "",
		``:      "",
	} {
		if got := jsonText(json.RawMessage(raw)); got != want {
			t.Errorf("jsonText(%s) = %q, want %q", raw, got, want)
		}
	}
}
