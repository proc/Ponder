package pgn

import (
	"strings"
	"testing"

	"board/backend/chess"
)

const twoGames = `[Event "Casual"]
[White "Morphy, Paul"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]
[Annotator "A \"quoted\" name"]

1.e4 e5 2.Nf3 d6 3.d4 Bg4 {This is a weak move} 4.dxe5 Bxf3 5.Qxf3 dxe5
6.Bc4 Nf6 7.Qb3 Qe7 8.Nc3 c6 9.Bg5 b5 (9...Qb4 10.Qxb4) 10.Nxb5 cxb5
11.Bxb5+ Nbd7 12.O-O-O Rd8 13.Rxd7 Rxd7 14.Rd1 Qe6 15.Bxd7+ Nxd7
16.Qb8+! Nxb8 17.Rd8# 1-0
[Event "Second"]
[White "A"]
[Black "B"]
[FEN "4k3/P7/8/8/8/8/8/4K3 w - - 0 1"]
[SetUp "1"]
; a line comment
1. a8Q+ Kd7 2. 0-0?? $4 *
`

func TestParse(t *testing.T) {
	games, err := Parse(twoGames)
	if err != nil {
		t.Fatal(err)
	}
	if len(games) != 2 {
		t.Fatalf("got %d games", len(games))
	}
	g := games[0]
	if g.Tag("White") != "Morphy, Paul" || g.Tag("Annotator") != `A "quoted" name` || g.Result != "1-0" {
		t.Errorf("tags: %+v result %q", g.Tags, g.Result)
	}
	if len(g.Moves) != 33 || g.Moves[0] != "e4" || g.Moves[20] != "Bxb5" || g.Moves[32] != "Rd8" {
		t.Errorf("moves (%d): %v", len(g.Moves), g.Moves)
	}
	start, moves, err := g.Replay()
	if err != nil {
		t.Fatal(err)
	}
	pos := start
	for _, m := range moves {
		pos = pos.Make(m)
	}
	if !pos.InCheck() || len(pos.LegalMoves()) != 0 {
		t.Error("Morphy's game should end in checkmate")
	}

	// The second game: FEN start, promotion without "=", then illegal castling.
	_, moves, err = games[1].Replay()
	if err == nil || !strings.Contains(err.Error(), "move 2.0-0") || len(moves) != 2 {
		t.Errorf("expected an error at move 2, got %v after %d moves", err, len(moves))
	}
}

func TestParseMoveVariants(t *testing.T) {
	pos, _ := chess.ParseFEN("r3k2r/8/8/8/8/5N2/8/R3K1NR w KQkq - 0 1")
	for tok, want := range map[string]string{
		"Ngf3": "", "Nge2": "g1e2", "Ng1e2": "g1e2", "N1e2": "g1e2", "0-0-0": "e1c1",
		"O-O": "", "Nfd4": "f3d4", "Nd4": "f3d4", "Ra1-d1": "a1d1", "g1h3": "g1h3", "Ne2": "g1e2", "Nf3": "", "e2e4": "",
	} {
		m, err := ParseMove(&pos, tok)
		got := ""
		if err == nil {
			got = m.UCI()
		}
		if got != want {
			t.Errorf("ParseMove(%q) = %q (%v), want %q", tok, got, err, want)
		}
	}
	promo, _ := chess.ParseFEN("8/P6k/8/8/8/8/8/K7 w - - 0 1")
	for tok, want := range map[string]string{"a8=Q": "a7a8q", "a8N": "a7a8n", "a8(R)": "a7a8r", "a8": "a7a8q", "a7a8b": "a7a8b"} {
		if m, err := ParseMove(&promo, tok); err != nil || m.UCI() != want {
			t.Errorf("ParseMove(%q) = %v %v, want %s", tok, m.UCI(), err, want)
		}
	}
}
