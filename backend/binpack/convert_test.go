package binpack

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const samplePGN = `[Event "Evals"]
[Result "1-0"]

1. e4 { [%eval 0.3] } 1... e5 { [%eval #-2] } 2. Nf3 2... Nc6 { [%eval -1.5] } 3. Bb5 1-0

[Event "Engine"]
[Result "0-1"]

1. d4 {+0.25/12 0.1s} d5 {-M3/20 0.2s} 2. c4 {book} 0-1

[Event "Unfinished"]
[Result "*"]

1. e4 e5 *
`

func convert(t *testing.T, req Request) ([]Entry, Stats) {
	t.Helper()
	dir := t.TempDir()
	req.From, req.To = filepath.Join(dir, "in.pgn"), filepath.Join(dir, "out.binpack")
	if err := os.WriteFile(req.From, []byte(samplePGN), 0o644); err != nil {
		t.Fatal(err)
	}
	if req.PawnValue == 0 {
		req.PawnValue = 100
	}
	var st Stats
	if err := Convert(context.Background(), req, func(_, _ int64, s Stats) { st = s }); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(req.To)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var es []Entry
	r := NewReader(f)
	for {
		e, err := r.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		es = append(es, e)
	}
	return es, st
}

func TestConvertPGNScores(t *testing.T) {
	es, st := convert(t, Request{Scores: "pgn", Missing: "skip"})
	if st.Games != 2 || st.Unfinished != 1 {
		t.Errorf("games %d, unfinished %d; want 2 and 1", st.Games, st.Unfinished)
	}
	got := map[string]Entry{}
	for _, e := range es {
		got[e.Move.UCI()] = e
	}
	check := func(move string, score int16, result int8) {
		t.Helper()
		e, ok := got[move]
		if !ok {
			t.Errorf("no entry for %s", move)
			return
		}
		if e.Score != score || e.Result != result {
			t.Errorf("%s: score %d result %d; want %d and %d", move, e.Score, e.Result, score, result)
		}
	}
	check("e7e5", -30, -1)
	check("g1f3", -(32000 - 4), 1) // [%eval #-2]: Black mates in 2, White to move
	check("f1b5", -150, 1)         // [%eval -1.5] after 2...Nc6, White to move
	check("d2d4", 25, -1)
	check("d7d5", -(32000 - 6), 1) // -M3: Black, who moves, is mated in 3
	if _, ok := got["e2e4"]; ok {
		t.Error("1.e4 has no score and should be left out")
	}
	if _, ok := got["b8c6"]; ok {
		t.Error("2...Nc6 has no score and should be left out")
	}
	if len(es) != 5 {
		t.Errorf("%d entries, want 5", len(es))
	}
}

func TestConvertMissingZero(t *testing.T) {
	es, st := convert(t, Request{Scores: "pgn", Missing: "zero", SkipPlies: 1})
	// Game 1: 5 moves less the first; game 2: 3 less the first.
	if len(es) != 6 || st.Unscored != 0 {
		t.Fatalf("%d entries, %d unscored; want 6 and 0", len(es), st.Unscored)
	}
}

func TestConvertSkipNoisy(t *testing.T) {
	const pgnText = "[Result \"1/2-1/2\"]\n\n1. e4 d5 2. exd5 Qxd5 3. Nc3 Qe5+ 4. Be2 1/2-1/2\n"
	dir := t.TempDir()
	req := Request{Scores: "pgn", Missing: "zero", SkipNoisy: true, PawnValue: 208,
		From: filepath.Join(dir, "in.pgn"), To: filepath.Join(dir, "out.binpack")}
	os.WriteFile(req.From, []byte(pgnText), 0o644)
	if err := Convert(context.Background(), req, func(int64, int64, Stats) {}); err != nil {
		t.Fatal(err)
	}
	f, _ := os.Open(req.To)
	defer f.Close()
	r := NewReader(f)
	var moves []string
	for {
		e, err := r.Next()
		if err != nil {
			break
		}
		moves = append(moves, e.Move.UCI())
	}
	// Left out: 2.exd5 and 2...Qxd5 (captures), 4.Be2 (in check).
	want := "e2e4 d7d5 b1c3 d5e5"
	if got := join(moves); got != want {
		t.Errorf("moves %q, want %q", got, want)
	}
}

func join(s []string) string { return strings.Join(s, " ") }
