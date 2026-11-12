package pgn

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOpenAndRead(t *testing.T) {
	// BOM, CRLF line ends, a comment holding a line that starts with "[",
	// games with no tags separated only by results, and a broken game.
	text := "\ufeff" + strings.ReplaceAll(`[Event "One"]
[White "A"]
[Black "B"]
[Result "1-0"]

1. e4 {a comment
[that looks like a tag]} e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0

1. d4 d5 *
1. c4 1/2-1/2

[Event "Two"]
[White "C"]
[Black "D"]

1. Nf3 *
[Event "Three"]
1. e4 {never closed
`, "\n", "\r\n")
	path := filepath.Join(t.TempDir(), "games.pgn")
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	var calls int
	c, err := Open(path, func(done, total int64) { calls++ })
	if err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for i := 0; i < c.Len(); i++ {
		e := c.Entry(i)
		got = append(got, fmt.Sprintf("%d %s/%s/%s/%d/%s", e.Index, e.Event, e.White, e.Result, e.Plies, e.Err))
	}
	want := []string{"0 One/A/1-0/7/", "1 //*/2/", "2 //1/2-1/2/1/", "3 Two/C/*/1/", "4 Three///1/unreadable game: unclosed { comment"}
	if strings.Join(got, "|") != strings.Join(want, "|") || calls == 0 {
		t.Fatalf("entries:\n got %q\nwant %q", got, want)
	}
	if n, found := c.Find([]string{"TWO"}, 0); n != 1 || found[0].Index != 3 {
		t.Errorf("Find(TWO) = %d %+v", n, found)
	}
	if n, found := c.Find(nil, 2); n != 5 || len(found) != 2 {
		t.Errorf("Find(nil, 2) = %d, %d rows", n, len(found))
	}
	for i, wantFirst := range []string{"e4", "d4", "c4", "Nf3"} {
		g, err := c.Read(i)
		if err != nil || len(g.Moves) == 0 || g.Moves[0] != wantFirst {
			t.Errorf("Read(%d) = %v, %v", i, g.Moves, err)
		}
		if _, _, err := g.Replay(); err != nil {
			t.Errorf("Replay(%d): %v", i, err)
		}
	}
	if _, err := c.Read(4); err == nil {
		t.Error("broken game read without error")
	}
	// A changed file is noticed rather than misread.
	os.WriteFile(path, []byte(text+"\r\n"), 0o644)
	if _, err := c.Read(0); err == nil || !strings.Contains(err.Error(), "changed") {
		t.Errorf("changed file: %v", err)
	}
}
