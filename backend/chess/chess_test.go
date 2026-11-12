package chess

import "testing"

func perft(p Position, depth int) int {
	if depth == 0 {
		return 1
	}
	n := 0
	for _, m := range p.LegalMoves() {
		n += perft(p.Make(m), depth-1)
	}
	return n
}

func TestPerft(t *testing.T) {
	cases := []struct {
		fen   string
		depth int
		nodes int
	}{
		{StartFEN, 4, 197281},
		{"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", 3, 97862},
		{"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", 5, 674624},
		{"r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", 4, 422333},
		{"rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", 3, 62379},
		{"r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10", 3, 89890},
	}
	for _, c := range cases {
		p, err := ParseFEN(c.fen)
		if err != nil {
			t.Fatal(err)
		}
		if got := p.FEN(); got != c.fen {
			t.Errorf("FEN round trip: got %q want %q", got, c.fen)
		}
		if got := perft(p, c.depth); got != c.nodes {
			t.Errorf("perft(%q, %d) = %d, want %d", c.fen, c.depth, got, c.nodes)
		}
	}
}

func TestSAN(t *testing.T) {
	cases := []struct{ fen, uci, san string }{
		{StartFEN, "g1f3", "Nf3"},
		{"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", "e1g1", "O-O"},
		{"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", "d5e6", "dxe6"},
		{"4k3/8/8/8/8/8/4K3/R6R w - - 0 1", "a1d1", "Rad1"},
		{"4k3/8/8/R7/8/8/8/R3K3 w - - 0 1", "a1a3", "R1a3"},
		{"6k1/P7/8/8/8/8/8/4K3 w - - 0 1", "a7a8q", "a8=Q+"},
		{"6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1", "a1a8", "Ra8#"},
	}
	for _, c := range cases {
		p, _ := ParseFEN(c.fen)
		m, err := p.ParseUCIMove(c.uci)
		if err != nil {
			t.Fatal(err)
		}
		if got := p.SAN(m); got != c.san {
			t.Errorf("SAN(%s) = %s, want %s", c.uci, got, c.san)
		}
	}
}

func TestMaterial(t *testing.T) {
	cases := []struct {
		fen  string
		dead bool
	}{
		{"4k3/8/8/8/8/8/8/4K3 w - - 0 1", true},
		{"4k3/8/8/8/8/8/8/4KN2 w - - 0 1", true},
		{"4k3/8/8/8/8/8/8/2B1KB2 w - - 0 1", false},
		{"4kb2/8/8/8/8/8/8/4KB2 w - - 0 1", false},
		{"4k1b1/8/8/8/8/8/8/4KB2 w - - 0 1", true},
		{"4k3/8/8/8/8/8/P7/4K3 w - - 0 1", false},
	}
	for _, c := range cases {
		p, _ := ParseFEN(c.fen)
		if got := p.InsufficientMaterial(); got != c.dead {
			t.Errorf("InsufficientMaterial(%q) = %v, want %v", c.fen, got, c.dead)
		}
	}
}
