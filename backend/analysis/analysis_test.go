package analysis

import (
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

var enginePath, slowEnginePath string

func TestMain(m *testing.M) {
	dir, _ := os.MkdirTemp("", "engine")
	enginePath = filepath.Join(dir, "basicengine")
	if out, err := exec.Command("go", "build", "-o", enginePath, "../cmd/basicengine").CombinedOutput(); err != nil {
		panic(string(out))
	}
	slowEnginePath = filepath.Join(dir, "slowengine")
	if out, err := exec.Command("go", "build", "-o", slowEnginePath, "./testdata/slowengine").CombinedOutput(); err != nil {
		panic(string(out))
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

type recorder struct {
	mu      sync.Mutex
	updates []Update
}

func (r *recorder) emit(_ string, data any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.updates = append(r.updates, data.(Update))
}

// waitFor returns the first update for fen that satisfies ok.
func (r *recorder) waitFor(t *testing.T, fen string, ok func(Update) bool) Update {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		for _, u := range r.updates {
			if u.FEN == fen && ok(u) {
				r.mu.Unlock()
				return u
			}
		}
		r.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no matching update for %s", fen)
	return Update{}
}

func TestAnalysis(t *testing.T) {
	r := &recorder{}
	a := New(r.emit)
	defer a.Stop()
	if err := a.Start(Config{Path: enginePath, Lines: 3}); err != nil {
		t.Fatal(err)
	}

	start := "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
	if err := a.SetPosition(start); err != nil {
		t.Fatal(err)
	}
	u := r.waitFor(t, start, func(u Update) bool { return len(u.Lines) == 3 && u.Depth >= 3 })
	if u.Engine != "Ponder Basic" || u.State != "running" || u.Lines[0].MultiPV != 1 || len(u.Lines[0].SAN) == 0 {
		t.Fatalf("start position: %+v", u)
	}

	// Switching positions mid-search: the new one is analysed, and no lines
	// for the old position arrive labelled with the new one.
	mate := "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1" // Ra8#
	if err := a.SetPosition(mate); err != nil {
		t.Fatal(err)
	}
	u = r.waitFor(t, mate, func(u Update) bool { return len(u.Lines) > 0 })
	if !u.Lines[0].IsMate || u.Lines[0].Mate != 1 || u.Lines[0].SAN[0] != "Ra8#" {
		t.Fatalf("mate in one: %+v", u.Lines[0])
	}

	// Black to move and a queen up: the score is negative (White's view).
	black := "3qk3/8/8/8/8/8/8/4K3 b - - 0 1"
	a.SetPosition(black)
	u = r.waitFor(t, black, func(u Update) bool { return len(u.Lines) > 0 && u.Depth >= 2 })
	if u.Lines[0].CP > -500 {
		t.Errorf("black a queen up scored %d", u.Lines[0].CP)
	}
	r.mu.Lock()
	for _, up := range r.updates {
		if up.FEN == black {
			for _, l := range up.Lines {
				if l.SAN[0] == "Ra8#" {
					t.Error("a line from the previous position was reported for the new one")
				}
			}
		}
	}
	r.mu.Unlock()

	// Checkmate on the board: nothing to analyse.
	mated := "R5k1/5ppp/8/8/8/8/8/6K1 b - - 1 1"
	a.SetPosition(mated)
	u = r.waitFor(t, mated, func(u Update) bool { return u.State == "over" })
	if u.Message != "Checkmate" {
		t.Errorf("mated position: %+v", u)
	}

	// Pause, then resume on the same position.
	a.SetPosition("")
	a.SetPosition(start)
	r.mu.Lock()
	r.updates = nil
	r.mu.Unlock()
	r.waitFor(t, start, func(u Update) bool { return len(u.Lines) == 3 })

	// Asking again for the position being analysed resends the current lines.
	r.mu.Lock()
	r.updates = nil
	r.mu.Unlock()
	a.SetPosition(start)
	r.waitFor(t, start, func(u Update) bool { return len(u.Lines) == 3 })

	// Restarting with the same settings keeps the engine; different settings replace it.
	if err := a.Start(Config{Path: enginePath, Lines: 3}); err != nil {
		t.Fatal(err)
	}
	if err := a.Start(Config{Path: enginePath, Lines: 1}); err != nil {
		t.Fatal(err)
	}
	r.mu.Lock()
	r.updates = nil
	r.mu.Unlock()
	a.SetPosition(start)
	r.waitFor(t, start, func(u Update) bool { return len(u.Lines) == 1 && u.Depth >= 3 })
}

// An engine that takes 3 s to answer "stop" must still be moved from one
// position to the next correctly: the next search starts only after its
// bestmove, and each position gets its own lines.
func TestSlowStoppingEngine(t *testing.T) {
	t.Setenv("STOP_DELAY_MS", "3000")
	r := &recorder{}
	a := New(r.emit)
	defer a.Stop()
	if err := a.Start(Config{Path: slowEnginePath, Lines: 1}); err != nil {
		t.Fatal(err)
	}
	positions := []string{
		"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
		"rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
		"rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
	}
	for i, fen := range positions {
		if err := a.SetPosition(fen); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(8 * time.Second)
		found := false
		for !found && time.Now().Before(deadline) {
			r.mu.Lock()
			for _, u := range r.updates {
				if u.FEN == fen && len(u.Lines) > 0 && u.Depth >= 2 {
					found = true
				}
			}
			r.mu.Unlock()
			time.Sleep(50 * time.Millisecond)
		}
		if !found {
			t.Fatalf("position %d: no lines arrived (the engine was given a new position before it stopped)", i)
		}
	}
}

// An engine that never answers "stop" is killed and replaced, and the new
// one analyses the latest position.
func TestStuckEngineIsRestarted(t *testing.T) {
	t.Setenv("STOP_DELAY_MS", "600000")
	old := stopTimeout
	stopTimeout = time.Second
	defer func() { stopTimeout = old }()

	r := &recorder{}
	a := New(r.emit)
	defer a.Stop()
	if err := a.Start(Config{Path: slowEnginePath, Lines: 1}); err != nil {
		t.Fatal(err)
	}
	first := a.eng
	start := "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
	a.SetPosition(start)
	r.waitFor(t, start, func(u Update) bool { return len(u.Lines) > 0 })

	next := "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
	a.SetPosition(next)
	r.waitFor(t, next, func(u Update) bool { return len(u.Lines) > 0 && u.Depth >= 2 })
	select {
	case <-first.Done():
	case <-time.After(2 * time.Second):
		t.Error("the stuck engine process was not ended")
	}
	r.mu.Lock()
	restarted := false
	for _, u := range r.updates {
		if u.State == "error" && u.Message != "" {
			restarted = true
		}
	}
	r.mu.Unlock()
	if !restarted {
		t.Error("no message about restarting the engine")
	}
}
