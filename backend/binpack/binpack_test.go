package binpack

import (
	"bytes"
	"io"
	"math/rand"
	"testing"

	"board/backend/chess"
)

// randomGames plays random legal games, preferring promotions, castling and
// en passant now and then so every kind of move shows up.
func randomGames(n int, seed int64) [][]Entry {
	rng := rand.New(rand.NewSource(seed))
	var games [][]Entry
	for g := 0; g < n; g++ {
		pos, _ := chess.ParseFEN(chess.StartFEN)
		var es []Entry
		for ply := 0; ply < 300; ply++ {
			moves := pos.LegalMoves()
			if len(moves) == 0 || pos.Halfmove >= 100 {
				break
			}
			m := moves[rng.Intn(len(moves))]
			for _, c := range moves {
				special := c.Promo != 0 || isCastle(&pos, c) ||
					(pos.Board[c.From].Type() == chess.Pawn && c.To == pos.EP)
				if special && rng.Intn(2) == 0 {
					m = c
				}
			}
			score := int16(rng.Intn(4000) - 2000)
			if rng.Intn(20) == 0 {
				score = int16(rng.Intn(65536) - 32768)
			}
			es = append(es, Entry{Pos: pos, Move: m, Score: score})
			pos = pos.Make(m)
		}
		result := int8(rng.Intn(3) - 1)
		for i := range es {
			if es[i].Pos.Turn == chess.White {
				es[i].Result = result
			} else {
				es[i].Result = -result
			}
		}
		games = append(games, es)
	}
	return games
}

func TestRoundTrip(t *testing.T) {
	games := randomGames(300, 1)
	var buf bytes.Buffer
	w := NewWriter(&buf)
	var all []Entry
	for gi, g := range games {
		for i, e := range g {
			// Leave a position out now and then, breaking the chain.
			if gi%7 == 0 && i == 10 {
				continue
			}
			if err := w.Add(e); err != nil {
				t.Fatal(err)
			}
			all = append(all, e)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	t.Logf("%d entries, %d bytes (%.2f a position)", len(all), buf.Len(), float64(buf.Len())/float64(len(all)))
	r := NewReader(&buf)
	for i, want := range all {
		got, err := r.Next()
		if err != nil {
			t.Fatalf("entry %d: %v", i, err)
		}
		if got.Move != want.Move || got.Score != want.Score || got.Result != want.Result || got.Ply() != want.Ply() {
			t.Fatalf("entry %d: got %+v %d %d ply %d, want %+v %d %d ply %d", i,
				got.Move, got.Score, got.Result, got.Ply(), want.Move, want.Score, want.Result, want.Ply())
		}
		if got.Pos.Board != want.Pos.Board || got.Pos.Turn != want.Pos.Turn ||
			castling(&got.Pos) != castling(&want.Pos) || epSquare(&got.Pos) != epSquare(&want.Pos) ||
			got.Pos.Halfmove != want.Pos.Halfmove {
			t.Fatalf("entry %d: position %s, want %s", i, got.Pos.FEN(), want.Pos.FEN())
		}
	}
	if _, err := r.Next(); err != io.EOF {
		t.Fatalf("after the last entry: %v", err)
	}
}

func TestSignedToUnsigned(t *testing.T) {
	for _, v := range []int16{0, 1, -1, 2, -2, 32767, -32768, 1234, -1234} {
		if got := unsignedToSigned(signedToUnsigned(v)); got != v {
			t.Errorf("%d came back as %d", v, got)
		}
	}
	if signedToUnsigned(1) != 2 || signedToUnsigned(-1) != 1 {
		t.Errorf("1 -> %d, -1 -> %d; want 2 and 1", signedToUnsigned(1), signedToUnsigned(-1))
	}
}

func TestChunks(t *testing.T) {
	// Enough positions for several chunks.
	games := randomGames(3000, 2)
	var buf bytes.Buffer
	w := NewWriter(&buf)
	n := 0
	for _, g := range games {
		for _, e := range g {
			w.Add(e)
			n++
		}
	}
	w.Close()
	chunks := bytes.Count(buf.Bytes(), []byte("BINP"))
	if chunks < 2 {
		t.Fatalf("%d chunks for %d bytes", chunks, buf.Len())
	}
	r := NewReader(&buf)
	got := 0
	for {
		if _, err := r.Next(); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		got++
	}
	if got != n {
		t.Fatalf("read %d entries, wrote %d", got, n)
	}
}
