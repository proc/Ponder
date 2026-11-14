package tournament

import (
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"board/backend/uci"
)

var randomEngine, basicEngine string

func TestMain(m *testing.M) {
	dir, _ := os.MkdirTemp("", "tournament-test")
	randomEngine = filepath.Join(dir, "randomengine")
	basicEngine = filepath.Join(dir, "basicengine")
	for path, pkg := range map[string]string{randomEngine: "../cmd/randomengine", basicEngine: "../cmd/basicengine"} {
		if out, err := exec.Command("go", "build", "-o", path, pkg).CombinedOutput(); err != nil {
			panic(string(out))
		}
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

func TestStats(t *testing.T) {
	even := Stats{Wins: 10, Losses: 10, Draws: 20, Penta: [5]int{2, 4, 8, 4, 2}}
	if elo, _, los := even.Elo(); math.Abs(elo) > 1e-9 || math.Abs(los-0.5) > 1e-9 {
		t.Fatalf("even: elo %v los %v", elo, los)
	}
	if llr := even.LLR(0, 10); llr >= 0 {
		t.Fatalf("even score should favour H0: LLR %v", llr)
	}
	strong := Stats{Wins: 60, Losses: 20, Draws: 20, Penta: [5]int{2, 5, 10, 18, 15}}
	elo, margin, los := strong.Elo()
	if elo < 100 || elo > 200 || margin <= 0 || los < 0.99 {
		t.Fatalf("strong: elo %v ± %v los %v", elo, margin, los)
	}
	if llr := strong.LLR(0, 10); llr <= 0 {
		t.Fatalf("strong score should favour H1: LLR %v", llr)
	}
	lo, hi := Bounds(0.05, 0.05)
	if math.Abs(lo+2.944) > 0.01 || math.Abs(hi-2.944) > 0.01 {
		t.Fatalf("bounds %v %v", lo, hi)
	}
}

type recorder struct {
	mu    sync.Mutex
	last  Status
	saved []string
}

func newT(r *recorder) *Tournament {
	return New(Hooks{
		Emit: func(ev string, d any) {
			r.mu.Lock()
			r.last = d.(Status)
			r.mu.Unlock()
		},
		Save: func(path, text string) error {
			r.mu.Lock()
			r.saved = append(r.saved, text)
			r.mu.Unlock()
			return nil
		},
	})
}

func waitDone(t *testing.T, tr *Tournament, d time.Duration) Status {
	t.Helper()
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		if s := tr.Status(); s.State == "finished" {
			tr.Wait(5 * time.Second)
			return s
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("not finished: %+v", tr.Status().Describe())
	return Status{}
}

func TestFixedNumberOfGames(t *testing.T) {
	r := &recorder{}
	tr := newT(r)
	err := tr.Start(Config{
		Engines:     []EngineSpec{{Name: "A", Path: randomEngine}, {Name: "B", Path: randomEngine}},
		TimeControl: TimeControl{BaseMs: 2000, IncMs: 20},
		Concurrency: 4, Games: 20,
		Openings:     OpeningConfig{Source: "book", Plies: 6},
		Adjudication: Adjudication{MaxMoves: 60},
		PGNPath:      "games.pgn",
	})
	if err != nil {
		t.Fatal(err)
	}
	s := waitDone(t, tr, 60*time.Second)
	if s.Games != 20 || s.Stats.Pairs() != 10 || s.Total != 20 {
		t.Fatalf("games %d pairs %d total %d: %s", s.Games, s.Stats.Pairs(), s.Total, s.Describe())
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.saved) != 20 || !strings.Contains(r.saved[0], "[Event \"A vs B\"]") || !strings.Contains(r.saved[0], "[TimeControl \"2+0.02\"]") {
		t.Fatalf("%d saved; first:\n%s", len(r.saved), r.saved[0])
	}
	// Search statistics: both engines' moves are counted, and the games.
	if len(s.Search) != 2 || s.Search[0].Name != "A" || s.Search[0].Moves == 0 || s.Search[1].Moves == 0 || s.AvgPlies <= 6 {
		t.Fatalf("search statistics %+v, average plies %v", s.Search, s.AvgPlies)
	}
	// Pairs: the same opening with colours reversed.
	if len(s.Recent) != 20 {
		t.Fatalf("recent %d", len(s.Recent))
	}
	if _, err := tr.GamePGN(s.Recent[0].Number); err != nil {
		t.Fatal(err)
	}
}

func TestSPRTStopsWhenDecided(t *testing.T) {
	r := &recorder{}
	tr := newT(r)
	err := tr.Start(Config{
		Engines:      []EngineSpec{{Name: "Basic", Path: basicEngine}, {Name: "Random", Path: randomEngine}},
		TimeControl:  TimeControl{MoveTimeMs: 20, MarginMs: 500},
		Concurrency:  4,
		Openings:     OpeningConfig{Source: "book", Plies: 4},
		SPRT:         SPRT{Enabled: true, Elo0: 0, Elo1: 100, Alpha: 0.05, Beta: 0.05},
		Adjudication: Adjudication{Resign: true, ResignMoves: 2, ResignScore: 600, Draw: true, MaxMoves: 150},
	})
	if err != nil {
		t.Fatal(err)
	}
	s := waitDone(t, tr, 120*time.Second)
	if s.Verdict != "H1" || s.LLR < s.Upper || s.Elo < 100 {
		t.Fatalf("want H1: %s, %q", s.Describe(), s.Message)
	}
	t.Log(s.Describe(), " ", s.Message)
}

func TestStop(t *testing.T) {
	r := &recorder{}
	tr := newT(r)
	err := tr.Start(Config{
		Engines:     []EngineSpec{{Name: "A", Path: basicEngine}, {Name: "B", Path: basicEngine}},
		TimeControl: TimeControl{BaseMs: 60000},
		Concurrency: 2, Games: 100, Openings: OpeningConfig{Source: "start"},
	})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)
	if s := tr.Status(); len(s.Live) != 2 {
		t.Fatalf("live games %d", len(s.Live))
	}
	tr.Stop()
	s := waitDone(t, tr, 10*time.Second)
	if s.Games != 0 || s.Message != "Stopped" {
		t.Fatalf("%+v", s)
	}
	if err := tr.Start(Config{}); err == nil {
		t.Fatal("an empty config should be refused")
	}
}

func TestOpeningsFromFiles(t *testing.T) {
	dir := t.TempDir()
	epd := filepath.Join(dir, "o.epd")
	os.WriteFile(epd, []byte("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - id \"e4\";\n\nbad line\n"), 0o644)
	ops, err := loadOpenings(OpeningConfig{Source: "file", Path: epd})
	if err != nil || len(ops) != 1 || ops[0].Name != "e4" {
		t.Fatalf("epd: %v %+v", err, ops)
	}
	p := filepath.Join(dir, "o.pgn")
	os.WriteFile(p, []byte("[Event \"x\"]\n\n1. d4 d5 2. c4 e6 3. Nc3 *\n\n[Event \"y\"]\n\n1. e4 c5 *\n"), 0o644)
	ops, err = loadOpenings(OpeningConfig{Source: "file", Path: p, Plies: 4, Order: "sequential"})
	if err != nil || len(ops) != 2 || strings.Join(ops[0].Moves, " ") != "d2d4 d7d5 c2c4 e7e6" || len(ops[1].Moves) != 2 {
		t.Fatalf("pgn: %v %+v", err, ops)
	}
	if ops := bookOpenings(8); len(ops) < 1000 {
		t.Fatalf("book: %d", len(ops))
	}
}

func TestLLRDoesNotStopOnAFewPairs(t *testing.T) {
	for pairs := 1; pairs <= 3; pairs++ {
		s := Stats{Wins: 2 * pairs, Penta: [5]int{0, 0, 0, 0, pairs}}
		if llr := s.LLR(0, 5); llr >= 2.94 {
			t.Fatalf("%d pairs, all won: LLR %v already accepts H1", pairs, llr)
		}
	}
}

// logged wraps an engine in a script that records every line it is sent, a
// file per process, and returns the script and the folder of records.
func logged(t *testing.T, engine string) (script, dir string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("needs a shell")
	}
	dir = t.TempDir()
	script = filepath.Join(dir, "engine.sh")
	body := "#!/bin/sh\ntee \"" + dir + "/sent.$$\" | \"" + engine + "\"\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return script, dir
}

// Every engine process of an SPRT match is given the engine's options as it
// is loaded: after uci, before its first game, each worker's copy alike.
func TestOptionsAreSetInAnSPRTMatch(t *testing.T) {
	basic, basicDir := logged(t, basicEngine)
	random, randomDir := logged(t, randomEngine)
	tr := newT(&recorder{})
	err := tr.Start(Config{
		Engines: []EngineSpec{
			{Name: "Basic", Path: basic, Options: map[string]string{"multipv": "2"}},
			{Name: "Random", Path: random, Options: map[string]string{"Delay": "0", "Extra": "on"}},
		},
		TimeControl:  TimeControl{MoveTimeMs: 20, MarginMs: 500},
		Concurrency:  3,
		Openings:     OpeningConfig{Source: "book", Plies: 4},
		SPRT:         SPRT{Enabled: true, Elo0: 0, Elo1: 100, Alpha: 0.05, Beta: 0.05},
		Adjudication: Adjudication{Resign: true, ResignMoves: 2, ResignScore: 600, Draw: true, MaxMoves: 150},
	})
	if err != nil {
		t.Fatal(err)
	}
	if s := waitDone(t, tr, 120*time.Second); s.Verdict == "" {
		t.Fatalf("no verdict: %s", s.Describe())
	}
	check := func(dir string, want ...string) {
		t.Helper()
		files, _ := filepath.Glob(filepath.Join(dir, "sent.*"))
		if len(files) < 3 {
			t.Errorf("%d engine processes recorded in %s, want one per worker", len(files), dir)
		}
		for _, f := range files {
			text, _ := os.ReadFile(f)
			head := "uci\n" + strings.Join(want, "\n") + "\nisready\nucinewgame\n"
			if !strings.HasPrefix(string(text), head) {
				lines := strings.SplitN(string(text), "\n", 8)
				t.Errorf("%s began %q, want %q", filepath.Base(f), strings.Join(lines[:len(lines)-1], "\n"), head)
			}
		}
	}
	check(basicDir, "setoption name MultiPV value 2")
	check(randomDir, "setoption name Delay value 0", "setoption name Extra value on")
	// The results say what each engine ran with, and so do the games.
	st := tr.Status()
	want := []EngineOptions{
		{Name: "Basic", Confirmed: true, Options: []uci.OptionSetting{{Name: "MultiPV", Value: "2"}}},
		{Name: "Random", Confirmed: true, Options: []uci.OptionSetting{{Name: "Delay", Value: "0"}, {Name: "Extra", Value: "on"}}},
	}
	if !reflect.DeepEqual(st.EngineOptions, want) {
		t.Errorf("engine options %+v", st.EngineOptions)
	}
	text, err := tr.GamePGN(st.Recent[0].Number)
	if err != nil || !strings.Contains(text, `Options "MultiPV=2"]`) || !strings.Contains(text, `Options "Delay=0; Extra=on"]`) {
		t.Errorf("the game's PGN:\n%s (%v)", text, err)
	}
}

// A paused tournament finishes the pairs it is playing, starts no more,
// and carries on to the end when resumed.
func TestPauseAndResume(t *testing.T) {
	tr := newT(&recorder{})
	err := tr.Start(Config{
		Engines:     []EngineSpec{{Name: "A", Path: randomEngine}, {Name: "B", Path: randomEngine}},
		TimeControl: TimeControl{MoveTimeMs: 10, MarginMs: 500},
		Concurrency: 2, Games: 16,
		Openings:     OpeningConfig{Source: "book", Plies: 4},
		Adjudication: Adjudication{MaxMoves: 30},
	})
	if err != nil {
		t.Fatal(err)
	}
	wait := func(what string, ok func(Status) bool) Status {
		t.Helper()
		for end := time.Now().Add(60 * time.Second); time.Now().Before(end); time.Sleep(5 * time.Millisecond) {
			if s := tr.Status(); ok(s) {
				return s
			}
		}
		t.Fatalf("timed out waiting for %s: %s", what, tr.Status().Describe())
		return Status{}
	}
	wait("two games", func(s Status) bool { return s.Games >= 2 })
	if err := tr.Pause(); err != nil {
		t.Fatal(err)
	}
	s := wait("the games in progress to end", func(s Status) bool { return s.Paused && len(s.Live) == 0 })
	if s.State != "running" || s.Games%2 != 0 || s.Games >= 16 {
		t.Fatalf("paused with %d games, state %s", s.Games, s.State)
	}
	held, elapsed := s.Games, s.Elapsed
	time.Sleep(600 * time.Millisecond)
	s = tr.Status()
	if s.Games != held || len(s.Live) != 0 || !s.Paused {
		t.Fatalf("while paused: %d games (was %d), %d playing", s.Games, held, len(s.Live))
	}
	if s.Elapsed-elapsed > 0.2 {
		t.Errorf("the clock ran %.2fs while paused", s.Elapsed-elapsed)
	}
	if err := tr.Resume(); err != nil {
		t.Fatal(err)
	}
	s = waitDone(t, tr, 60*time.Second)
	if s.Games != 16 || s.Paused {
		t.Fatalf("after resuming: %d games, paused %v", s.Games, s.Paused)
	}
	if tr.Pause() == nil {
		t.Error("a finished tournament was paused")
	}
}
