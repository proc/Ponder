package puzzles

import (
	"os"
	"path/filepath"
	"testing"
)

const sample = `PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags
00008,r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24,f2g3 e6e7 b2b1 b3c1 b1c1 h6c1,1913,75,94,6230,crushing hangingPiece long middlegame,https://lichess.org/787zsVup/black#48,
0000D,5rk1/1p3ppp/pq3b2/8/8/1P1Q1N2/P4PPP/3R2K1 w - - 2 27,d3d6 f8d8 d6d8 f6d8,1580,73,97,23154,advantage endgame short,https://lichess.org/F8M8OS71#53,
0009B,r2qr1k1/b1p2ppp/pp4n1/P1P1p3/4P1n1/B2P2Pb/3NBP1P/RN1QR1K1 b - - 1 16,b6c5 e2g4 h3g4 d1g4,1080,75,88,567,advantage middlegame short,https://lichess.org/4MWQCxQ6/black#32,Kings_Pawn_Game Kings_Pawn_Game_Leonardis_Variation
`

func TestPuzzleFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "p.csv")
	os.WriteFile(path, []byte(sample), 0o644)
	db, err := Open(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if db.Len() != 3 {
		t.Fatalf("%d puzzles", db.Len())
	}
	p, err := db.Random(1500, 2000, "endgame")
	if err != nil || p.ID != "0000D" || len(p.Moves) != 4 || p.Rating != 1580 {
		t.Fatalf("%+v %v", p, err)
	}
	p, err = db.Random(1000, 1100, "")
	if err != nil || p.ID != "0009B" || len(p.Openings) != 2 {
		t.Fatalf("%+v %v", p, err)
	}
	if _, err := db.Random(2500, 0, ""); err == nil {
		t.Fatal("no puzzle should be that hard")
	}
	if _, err := Open(path+".zst", nil); err == nil {
		t.Fatal("compressed files are refused")
	}
}
