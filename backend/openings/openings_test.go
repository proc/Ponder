package openings

import (
	"testing"
	"time"

	"board/backend/chess"
	"board/backend/pgn"
)

// name follows a game and returns the most specific opening reached.
func name(t *testing.T, moves string) string {
	t.Helper()
	pos, _ := chess.ParseFEN(chess.StartFEN)
	games, _ := pgn.Parse(moves)
	last := ""
	for _, tok := range games[0].Moves {
		m, err := pgn.ParseMove(&pos, tok)
		if err != nil {
			t.Fatalf("%s: %v", tok, err)
		}
		pos = pos.Make(m)
		if o, ok := Lookup(&pos); ok {
			last = o.String()
		}
	}
	return last
}

func TestBook(t *testing.T) {
	start := time.Now()
	n := Size()
	t.Logf("%d positions loaded in %v", n, time.Since(start))
	if n < 3000 {
		t.Fatalf("only %d positions in the book", n)
	}
	cases := map[string]string{
		"1. e4": "B00 King's Pawn Game",
		"1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6": "B90 Sicilian Defense: Najdorf Variation",
		"1. e4 e5 2. Nf3 Nc6 3. Bb5 a6":                       "C70 Ruy Lopez: Morphy Defense",
		// Transposition: the Queen's Gambit Declined reached from the English.
		"1. c4 e6 2. d4 d5": "D30 Queen's Gambit Declined",
		// Moves past the book keep the last name reached.
		"1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 11. Nbd2 Bb7 12. Bc2 Re8 13. Nf1 Bf8 14. Ng3 g6 15. a4 c5": "C95 Ruy Lopez: Closed, Breyer Defense, Zaitsev Hybrid",
	}
	for moves, want := range cases {
		if got := name(t, moves); got != want {
			t.Errorf("%s\n got %q\nwant %q", moves, got, want)
		}
	}
}

func TestNext(t *testing.T) {
	start, _ := chess.ParseFEN(chess.StartFEN)
	moves := Next(&start)
	if len(moves) < 10 || moves[0].Lines < moves[len(moves)-1].Lines {
		t.Fatalf("%d moves from the start: %+v", len(moves), moves)
	}
	found := false
	for _, m := range moves {
		if m.SAN == "e4" && m.Name != "" {
			found = true
		}
	}
	if !found {
		t.Fatalf("1. e4 with its name not found: %+v", moves[:5])
	}
}
