package epdtest

import (
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func basicEngine(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "basicengine")
	out, err := exec.Command("go", "build", "-o", bin, "board/backend/cmd/basicengine").CombinedOutput()
	if err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	return bin
}

func TestRun(t *testing.T) {
	if testing.Short() {
		t.Skip()
	}
	bin := basicEngine(t)
	var mu sync.Mutex
	var events []Progress
	done := make(chan Progress, 1)
	r := NewRunner(func(ev string, data any) {
		p := data.(Progress)
		mu.Lock()
		events = append(events, p)
		mu.Unlock()
		if p.State != "running" {
			done <- p
		}
	})
	positions := []Position{
		// Mate in one: Qxf7#.
		{Index: 0, ID: "mate", FEN: "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 0 1", BM: []string{"Qxf7#"}},
		// A hanging queen.
		{Index: 1, ID: "queen", FEN: "4k3/8/8/3q4/8/8/3R4/4K3 w - - 0 1", BM: []string{"Rxd5"}},
		// Avoid a move.
		{Index: 2, ID: "avoid", FEN: "4k3/8/8/8/8/8/3R4/4K3 w - - 0 1", AM: []string{"Rd8+"}},
		// A bad solution (not legal) is reported, not fatal.
		{Index: 3, ID: "bad", FEN: "4k3/8/8/8/8/8/3R4/4K3 w - - 0 1", BM: []string{"Qh5"}},
	}
	if err := r.Start(Request{Key: "k", Engine: Engine{Path: bin}, Positions: positions, MoveTimeMs: 300, Concurrency: 2}); err != nil {
		t.Fatal(err)
	}
	var final Progress
	select {
	case final = <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("timed out")
	}
	if final.State != "done" || final.Done != 4 || final.Total != 4 {
		t.Fatalf("final %+v", final)
	}
	got := map[string]Result{}
	mu.Lock()
	for _, e := range events {
		if e.Result != nil {
			got[e.Result.ID] = *e.Result
		}
	}
	mu.Unlock()
	if r := got["mate"]; !r.Solved || r.Move != "Qxf7#" || r.FoundMs < 0 || r.Depth == 0 {
		t.Errorf("mate: %+v", r)
	}
	if r := got["queen"]; !r.Solved || r.Move != "Rxd5" {
		t.Errorf("queen: %+v", r)
	}
	if r := got["bad"]; r.Error == "" || r.Solved {
		t.Errorf("bad: %+v", r)
	}
	if final.Solved < 2 {
		t.Errorf("solved %d", final.Solved)
	}
}

func TestStop(t *testing.T) {
	if testing.Short() {
		t.Skip()
	}
	bin := basicEngine(t)
	done := make(chan Progress, 4)
	r := NewRunner(func(ev string, data any) {
		if p := data.(Progress); p.State != "running" {
			done <- p
		}
	})
	var ps []Position
	for i := 0; i < 20; i++ {
		ps = append(ps, Position{Index: i, ID: "p", FEN: "4k3/8/8/3q4/8/8/3R4/4K3 w - - 0 1", BM: []string{"Rxd5"}})
	}
	r.Start(Request{Key: "s", Engine: Engine{Path: bin}, Positions: ps, MoveTimeMs: 500})
	time.Sleep(700 * time.Millisecond)
	r.Stop()
	select {
	case p := <-done:
		if p.State != "stopped" || p.Done >= 20 {
			t.Fatalf("%+v", p)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("did not stop")
	}
}
