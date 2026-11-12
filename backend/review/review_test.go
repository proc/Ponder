package review

import (
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestReview(t *testing.T) {
	dir := t.TempDir()
	eng := filepath.Join(dir, "basicengine")
	if out, err := exec.Command("go", "build", "-o", eng, "../cmd/basicengine").CombinedOutput(); err != nil {
		t.Fatal(string(out))
	}
	done := make(chan Progress, 100)
	r := New(func(ev string, d any) {
		p := d.(Progress)
		if p.State != "running" {
			done <- p
		}
	})
	// Scholar's mate: 1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6?? 4. Qxf7#.
	moves := []string{"e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"}
	err := r.Start(Request{Key: "k", Engine: Engine{Name: "Basic", Path: eng}, StartFEN: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", Moves: moves, MoveTimeMs: 150})
	if err != nil {
		t.Fatal(err)
	}
	var p Progress
	select {
	case p = <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("timeout")
	}
	if p.State != "done" || p.Result == nil {
		t.Fatalf("%+v", p)
	}
	res := p.Result
	if len(res.Positions) != 8 || len(res.Judgments) != 7 {
		t.Fatalf("%d positions %d judgments", len(res.Positions), len(res.Judgments))
	}
	if res.Positions[7].Final != "checkmate" || res.Positions[7].CP != 10000 {
		t.Fatalf("final %+v", res.Positions[7])
	}
	nf6 := res.Judgments[5]
	if nf6.Kind != "blunder" || nf6.Glyph != "??" || nf6.Best == "" {
		t.Fatalf("Nf6 should be a blunder with a better move: %+v", nf6)
	}
	if res.Black.Blunders < 1 || res.White.Accuracy <= res.Black.Accuracy {
		t.Fatalf("white %+v black %+v", res.White, res.Black)
	}
	t.Logf("white %+v black %+v; Nf6: %+v", res.White, res.Black, nf6)
}
