package tournament

import (
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
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
		Engines:     [2]EngineSpec{{Name: "A", Path: randomEngine}, {Name: "B", Path: randomEngine}},
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
		Engines:      [2]EngineSpec{{Name: "Basic", Path: basicEngine}, {Name: "Random", Path: randomEngine}},
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
		Engines:     [2]EngineSpec{{Name: "A", Path: basicEngine}, {Name: "B", Path: basicEngine}},
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
