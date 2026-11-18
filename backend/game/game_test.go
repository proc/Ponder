package game

import (
	"board/backend/chess"
	"board/backend/pgn"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var enginePath string

func TestMain(m *testing.M) {
	dir, _ := os.MkdirTemp("", "engine")
	enginePath = filepath.Join(dir, "randomengine")
	if out, err := exec.Command("go", "build", "-o", enginePath, "../cmd/randomengine").CombinedOutput(); err != nil {
		panic(string(out))
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

type recorder struct {
	mu      sync.Mutex
	last    State
	infos   int
	strings []EngineString
	done    chan struct{}
	once    sync.Once
}

func newRecorder() *recorder { return &recorder{done: make(chan struct{})} }

func (r *recorder) emit(event string, data any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch v := data.(type) {
	case State:
		r.last = v
		if v.Result != "*" || v.Reason != "" {
			r.once.Do(func() { close(r.done) })
		}
	case EngineInfo:
		r.infos++
	case EngineString:
		r.strings = append(r.strings, v)
	}
}

func (r *recorder) wait(t *testing.T, d time.Duration) State {
	t.Helper()
	select {
	case <-r.done:
	case <-time.After(d):
		t.Fatal("game did not finish")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.last
}

func clock(stages ...Stage) TimeControl { return TimeControl{Kind: "clock", Stages: stages} }

func engine(tc TimeControl) PlayerConfig {
	return PlayerConfig{Type: "engine", Name: "Random", EnginePath: enginePath,
		Options: map[string]string{"Delay": "0"}, TimeControl: tc}
}

func human(tc TimeControl) PlayerConfig {
	return PlayerConfig{Type: "human", Name: "Human", TimeControl: tc}
}

func TestEngineVsEngine(t *testing.T) {
	r := newRecorder()
	m := NewManager(r.emit)
	defer m.Shutdown()
	// Different controls per side: multi-stage clock vs fixed move time.
	err := m.NewGame(Config{
		White: engine(clock(Stage{Moves: 20, BaseMs: 30000, IncMs: 100}, Stage{BaseMs: 30000, IncMs: 100})),
		Black: engine(TimeControl{Kind: "movetime", MoveTimeMs: 20}),
	})
	if err != nil {
		t.Fatal(err)
	}
	s := r.wait(t, 60*time.Second)
	if s.Result == "*" || len(s.Moves) == 0 {
		t.Fatalf("unexpected end: %q %q after %d moves", s.Result, s.Reason, len(s.Moves))
	}
	if strings.Contains(s.Reason, "forfeit") || strings.Contains(s.Reason, "time") {
		t.Fatalf("game should end on the board, got %q", s.Reason)
	}
	if r.infos == 0 {
		t.Error("no engine info was relayed")
	}
	pgn, _ := m.PGN()
	if !strings.Contains(pgn, `[WhiteTimeControl "20/30+0.1:30+0.1"]`) || !strings.Contains(pgn, "1. ") {
		t.Errorf("bad PGN:\n%s", pgn)
	}
	t.Logf("%s (%d plies)", s.Reason, len(s.Moves))
}

func TestHumanVsHuman(t *testing.T) {
	r := newRecorder()
	m := NewManager(r.emit)
	defer m.Shutdown()
	tc := clock(Stage{BaseMs: 60000, IncMs: 1000})
	if err := m.NewGame(Config{White: human(tc), Black: human(tc)}); err != nil {
		t.Fatal(err)
	}
	if err := m.Move("e2e5"); err == nil {
		t.Fatal("illegal move accepted")
	}
	for _, mv := range []string{"f2f3", "e7e5", "g2g4", "d8h4"} {
		if err := m.Move(mv); err != nil {
			t.Fatal(err)
		}
	}
	s := r.wait(t, time.Second)
	if s.Result != "0-1" || s.Reason != "Black wins by checkmate" || s.Moves[3].SAN != "Qh4#" {
		t.Fatalf("got %q %q %+v", s.Result, s.Reason, s.Moves)
	}
	// Each side moved twice with a 1 s increment and nearly no thinking time.
	if w := s.Clocks["white"].Ms; w < 61900 || w > 62000 {
		t.Errorf("white clock = %d", w)
	}
}

func TestHumanVsEngineAndFlag(t *testing.T) {
	r := newRecorder()
	m := NewManager(r.emit)
	defer m.Shutdown()
	err := m.NewGame(Config{
		White: human(TimeControl{Kind: "movetime", MoveTimeMs: 300}),
		Black: engine(TimeControl{Kind: "depth", Depth: 1}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Move("e2e4"); err != nil {
		t.Fatal(err)
	}
	// The engine replies, then the human lets the 300 ms per move run out.
	s := r.wait(t, 5*time.Second)
	if s.Result != "0-1" || s.Reason != "Black wins on time" || len(s.Moves) != 2 {
		t.Fatalf("got %q %q after %d plies", s.Result, s.Reason, len(s.Moves))
	}
}

func TestAbort(t *testing.T) {
	r := newRecorder()
	m := NewManager(r.emit)
	defer m.Shutdown()
	err := m.NewGame(Config{
		White: human(TimeControl{Kind: "none"}),
		Black: engine(TimeControl{Kind: "depth", Depth: 1}),
	})
	if err != nil {
		t.Fatal(err)
	}
	m.Abort()
	s := m.State()
	if s.Active || s.Result != "*" || s.Reason != "Game aborted" || len(s.LegalMoves) != 0 {
		t.Fatalf("after abort: active=%v result=%q reason=%q", s.Active, s.Result, s.Reason)
	}
	if err := m.Move("e2e4"); err == nil {
		t.Error("an aborted game accepted a move")
	}
	if err := m.Resign("white"); err == nil {
		t.Error("an aborted game accepted a resignation")
	}
}

func TestStagesAndValidation(t *testing.T) {
	c := NewClock(clock(Stage{Moves: 2, BaseMs: 1000, IncMs: 10}, Stage{BaseMs: 500}))
	c.MoveDone(100)
	if c.RemainingMs != 910 || c.MovesToGo() != 1 {
		t.Fatalf("after move 1: %d ms, %d to go", c.RemainingMs, c.MovesToGo())
	}
	c.MoveDone(100)
	if c.RemainingMs != 1320 || c.MovesToGo() != 0 || c.IncMs() != 0 {
		t.Fatalf("after move 2: %d ms, %d to go", c.RemainingMs, c.MovesToGo())
	}
	m := NewManager(func(string, any) {})
	if err := m.NewGame(Config{White: human(TimeControl{Kind: "depth", Depth: 3}), Black: human(TimeControl{Kind: "none"})}); err == nil {
		t.Error("depth limit accepted for a human")
	}
	if err := m.NewGame(Config{White: human(TimeControl{Kind: "none"}), Black: engine(TimeControl{Kind: "none"})}); err == nil {
		t.Error("untimed engine accepted")
	}
}

func TestOpeningName(t *testing.T) {
	cases := map[string]string{
		"Opening: Sicilian Defense":          "Sicilian Defense",
		"opening name Ruy Lopez":             "Ruy Lopez",
		"ECO: B20 Sicilian Defense":          "B20 Sicilian Defense",
		"Book: Italian Game (C50)":           "Italian Game (C50)",
		"B90 Sicilian, Najdorf":              "B90 Sicilian, Najdorf",
		"book move e2e4":                     "",
		"book hit":                           "",
		"NNUE evaluation using nn-1234.nnue": "",
		"Available processors: 0-7":          "",
	}
	for in, want := range cases {
		if got := OpeningName(in); got != want {
			t.Errorf("OpeningName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestEngineReportsOpening(t *testing.T) {
	r := newRecorder()
	m := NewManager(r.emit)
	defer m.Shutdown()
	err := m.NewGame(Config{
		White: human(TimeControl{Kind: "none"}),
		Black: engine(TimeControl{Kind: "depth", Depth: 1}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Move("e2e4"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && len(m.State().Moves) < 2 {
		time.Sleep(20 * time.Millisecond)
	}
	s := m.State()
	r.mu.Lock()
	got := append([]EngineString(nil), r.strings...)
	r.mu.Unlock()
	if len(got) == 0 || got[0].Side != "black" || got[0].Text != "Opening: B00 King's Pawn Opening" || got[0].Ply != 1 {
		t.Fatalf("engine strings: %+v", got)
	}
	if s.Opening != "B00 King's Pawn Opening" {
		t.Errorf("state opening = %q", s.Opening)
	}
	m.Abort()
	// The book names 1.e4 itself, and its name is the one exported.
	if s.Moves[0].Opening != "B00 King's Pawn Game" {
		t.Errorf("book opening after 1.e4 = %q", s.Moves[0].Opening)
	}
	// The export carries the book opening reached by the last move (the
	// engine's reply varies: 1...b6 is the Owen Defense, for example).
	last := m.State().Moves
	eco, name, _ := strings.Cut(last[len(last)-1].Opening, " ")
	if pgn, _ := m.PGN(); eco == "" || !strings.Contains(pgn, "[ECO \""+eco+"\"]\n[Opening \""+name+"\"]") {
		t.Errorf("PGN missing opening %q:\n%s", last[len(last)-1].Opening, pgn)
	}
}

func TestLoadGame(t *testing.T) {
	const text = `[Event "Paris Opera"]
[White "Morphy, Paul"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]
[WhiteElo "?"]
[ECO "C41"]
[Opening "Philidor Defense"]

1.e4 e5 2.Nf3 d6 3.d4 Bg4 {weak} 4.dxe5 Bxf3 5.Qxf3 dxe5 6.Bc4 Nf6 7.Qb3 Qe7
8.Nc3 c6 9.Bg5 b5 10.Nxb5 cxb5 11.Bxb5+ Nbd7 12.O-O-O Rd8 13.Rxd7 Rxd7
14.Rd1 Qe6 15.Bxd7+ Nxd7 16.Qb8+ Nxb8 17.Rd8# 1-0`
	games, err := pgn.Parse(text)
	if err != nil {
		t.Fatal(err)
	}
	r := newRecorder()
	m := NewManager(r.emit)
	defer m.Shutdown()
	if err := m.LoadGame(games[0], "morphy.pgn", 0); err != nil {
		t.Fatal(err)
	}
	s := m.State()
	if !s.Loaded || s.Active || s.Source != "morphy.pgn" || len(s.Moves) != 33 || s.Result != "1-0" ||
		s.Reason != "White wins by checkmate" || s.Opening != "C41 Philidor Defense" ||
		s.Players["white"].Name != "Morphy, Paul" || s.Players["white"].Rating != "" || s.Moves[32].SAN != "Rd8#" {
		t.Fatalf("state: %+v", s)
	}
	if err := m.Move("a2a3"); err == nil {
		t.Error("a loaded game accepted a move")
	}
	if err := m.Resign(""); err == nil {
		t.Error("a loaded game accepted a resignation")
	}
	m.Abort()
	if m.State().Reason != "White wins by checkmate" {
		t.Error("abort changed a loaded game")
	}
	out, _ := m.PGN()
	if !strings.HasPrefix(out, "[Event \"Paris Opera\"]\n[White \"Morphy, Paul\"]") || !strings.Contains(out, "17. Rd8# 1-0") {
		t.Errorf("export:\n%s", out)
	}
	// The export reads back as the same game.
	again, _ := pgn.Parse(out)
	if len(again) != 1 || strings.Join(again[0].Moves, " ") != strings.Join(games[0].Moves, " ") {
		t.Errorf("round trip changed the moves")
	}
	// Starting a new game after viewing one works as normal.
	tc := TimeControl{Kind: "none"}
	if err := m.NewGame(Config{White: human(tc), Black: human(tc)}); err != nil {
		t.Fatal(err)
	}
	if s2 := m.State(); s2.Loaded || !s2.Active || s2.Game == s.Game || len(s2.Moves) != 0 {
		t.Errorf("new game after load: %+v", s2)
	}
}

func TestFormatPGN(t *testing.T) {
	text, err := FormatPGN([]pgn.Tag{{Name: "Event", Value: "Rated blitz game"}, {Name: "White", Value: `A "B"`}},
		chess.StartFEN, []string{"f2f3", "e7e5", "g2g4", "d8h4"}, "0-1")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`[White "A \"B\""]`, `[Result "0-1"]`, `[Opening "Barnes Opening: Fool's Mate"]`, "1. f3 e5 2. g4 Qh4# 0-1"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in\n%s", want, text)
		}
	}
}

func TestTakebackAgainstEngine(t *testing.T) {
	path := enginePath
	states := make(chan State, 100)
	m := NewManager(func(ev string, d any) {
		if s, ok := d.(State); ok {
			select {
			case states <- s:
			default:
			}
		}
	})
	defer m.Shutdown()
	tc := TimeControl{Kind: "none"}
	err := m.NewGame(Config{
		White: PlayerConfig{Type: "human", Name: "Me", TimeControl: tc},
		Black: PlayerConfig{Type: "engine", Name: "Random", EnginePath: path, TimeControl: TimeControl{Kind: "movetime", MoveTimeMs: 50}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if m.CanTakeback() {
		t.Fatal("nothing to take back yet")
	}
	waitTurn := func(n int) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if s := m.State(); len(s.Moves) == n {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("game did not reach %d moves: %d", n, len(m.State().Moves))
	}
	if err := m.Move("e2e4"); err != nil {
		t.Fatal(err)
	}
	waitTurn(2) // the engine replied
	if err := m.Move("d2d4"); err != nil {
		t.Fatal(err)
	}
	waitTurn(4)
	if err := m.Takeback(); err != nil {
		t.Fatal(err)
	}
	s := m.State()
	if len(s.Moves) != 2 || s.Turn != "white" || !s.Active {
		t.Fatalf("after takeback: %d moves, %s to move", len(s.Moves), s.Turn)
	}
	// The engine must not move for us: wait a moment and check.
	time.Sleep(300 * time.Millisecond)
	if n := len(m.State().Moves); n != 2 {
		t.Fatalf("moves changed to %d", n)
	}
	if err := m.Move("g1f3"); err != nil {
		t.Fatal(err)
	}
	waitTurn(4)
}

func TestAnnotatedPGN(t *testing.T) {
	m := NewManager(func(string, any) {})
	defer m.Shutdown()
	tc := TimeControl{Kind: "none"}
	if err := m.NewGame(Config{White: PlayerConfig{Type: "human", TimeControl: tc}, Black: PlayerConfig{Type: "human", TimeControl: tc}}); err != nil {
		t.Fatal(err)
	}
	for _, mv := range []string{"e2e4", "e7e5", "d1h5", "b8c6"} {
		if err := m.Move(mv); err != nil {
			t.Fatal(err)
		}
	}
	text, err := m.AnnotatedPGN(&Annotations{
		NAGs:       map[int][]int{3: {6}},
		Comments:   map[int]string{1: "[%eval 0.30]", 3: "[%eval -0.20] Inaccuracy. Nf3 was best."},
		Variations: map[int]string{3: "(2. Nf3 Nc6)"},
		After:      "Analysis: 3. Bc4",
		Annotator:  "Test",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := "1. e4 { [%eval 0.30] } 1... e5 2. Qh5 $6 { [%eval -0.20] Inaccuracy. Nf3 was best. } (2. Nf3 Nc6) 2... Nc6 { Analysis: 3. Bc4 } *"
	if !strings.Contains(strings.ReplaceAll(text, "\n", " "), want) || !strings.Contains(text, `[Annotator "Test"]`) {
		t.Fatalf("got\n%s\nwant movetext\n%s", text, want)
	}
	// The plain export is unchanged.
	if plain, _ := m.PGN(); strings.Contains(plain, "{") {
		t.Fatalf("plain PGN has comments:\n%s", plain)
	}
}

func TestPlayableExternal(t *testing.T) {
	m := NewManager(func(string, any) {})
	v := ExternalView{ID: "g1", Kind: "play", Playable: true, Side: "black", StartFEN: chess.StartFEN,
		White: PlayerConfig{Type: "lichess", Name: "Rival"}, Black: PlayerConfig{Type: "human", Name: "Me"}}
	if err := m.ShowExternal(v); err != nil {
		t.Fatal(err)
	}
	if s := m.State(); s.HumanToMove || s.CanTakeback || !s.External.Playable {
		t.Fatalf("White to move: humanToMove %v canTakeback %v", s.HumanToMove, s.CanTakeback)
	}
	v.Moves = []string{"e2e4"}
	m.ShowExternal(v)
	s := m.State()
	if !s.HumanToMove || len(s.LegalMoves) != 20 || !s.CanTakeback {
		t.Fatalf("Black to move: humanToMove %v legal %d canTakeback %v", s.HumanToMove, len(s.LegalMoves), s.CanTakeback)
	}
	v.Finished, v.Result, v.Reason = true, "1-0", "White wins by resignation"
	m.ShowExternal(v)
	if s := m.State(); s.HumanToMove || s.CanTakeback || s.External.Playable {
		t.Fatal("a finished game is still playable")
	}
	if id, kind, live := m.ExternalKind(); id != "g1" || kind != "play" || live {
		t.Fatalf("ExternalKind %q %q %v", id, kind, live)
	}
}

// A server that says only "Draw" leaves the reason to the position.
func TestExternalDrawReason(t *testing.T) {
	shuffle := []string{"g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"}
	for _, tc := range []struct {
		name, fen string
		moves     []string
		reason    string
		want      string
	}{
		{"repetition", chess.StartFEN, shuffle, "Draw", "Draw by threefold repetition"},
		{"agreed", chess.StartFEN, []string{"e2e4", "e7e5"}, "Draw", "Draw by agreement"},
		{"bare kings", "8/8/4k3/8/8/3K4/8/8 w - - 0 1", []string{"d3d4"}, "", "Draw by insufficient material"},
		{"stalemate", "7k/5Q2/8/8/8/8/8/K7 w - - 0 1", []string{"f7g6"}, "Draw", "Draw by stalemate"},
		{"fifty moves", "8/8/4k3/8/8/3K4/R7/8 w - - 99 80", []string{"a2a3"}, "Draw", "Draw by the fifty-move rule"},
		{"said already", chess.StartFEN, shuffle, "Draw on time", "Draw on time"},
	} {
		m := NewManager(func(string, any) {})
		v := ExternalView{ID: tc.name, Kind: "spectate", Side: "white", StartFEN: tc.fen, Moves: tc.moves,
			White: PlayerConfig{Type: "remote", Name: "A"}, Black: PlayerConfig{Type: "remote", Name: "B"},
			Finished: true, Result: "1/2-1/2", Reason: tc.reason}
		if err := m.ShowExternal(v); err != nil {
			t.Fatal(err)
		}
		if got := m.State().Reason; got != tc.want {
			t.Errorf("%s: reason %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestReplaceEngine(t *testing.T) {
	m := NewManager(func(string, any) {})
	defer m.Shutdown()
	slow := PlayerConfig{Type: "engine", Name: "Slow", EnginePath: enginePath,
		Options: map[string]string{"Delay": "3000"}, TimeControl: TimeControl{Kind: "movetime", MoveTimeMs: 10000}}
	if err := m.NewGame(Config{White: human(TimeControl{Kind: "none"}), Black: slow}); err != nil {
		t.Fatal(err)
	}
	waitMoves := func(n int, within time.Duration) State {
		t.Helper()
		deadline := time.Now().Add(within)
		for time.Now().Before(deadline) {
			if s := m.State(); len(s.Moves) >= n {
				return s
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("game did not reach %d moves: %d", n, len(m.State().Moves))
		return State{}
	}
	if err := m.ReplaceEngine("white", slow); err == nil {
		t.Fatal("white is human: no engine to replace")
	}
	if err := m.Move("e2e4"); err != nil {
		t.Fatal(err)
	}
	// The slow engine is thinking: swapped for a quick one, which moves at once.
	start := time.Now()
	fast := PlayerConfig{Name: "Fast", EnginePath: enginePath, Options: map[string]string{"Delay": "0"}}
	if err := m.ReplaceEngine("black", fast); err != nil {
		t.Fatal(err)
	}
	s := waitMoves(2, 2*time.Second)
	if time.Since(start) > 2*time.Second || s.Players["black"].Name != "Fast" || s.Players["black"].TimeControl.Kind != "movetime" {
		t.Fatalf("after swap: %+v", s.Players["black"])
	}
	if len(s.Loading) != 0 || !s.Active {
		t.Fatalf("still loading: %v", s.Loading)
	}
	// Reloaded on the human's turn: it waits, then answers the next move.
	if err := m.ReplaceEngine("black", fast); err != nil {
		t.Fatal(err)
	}
	if err := m.Move("d2d4"); err != nil {
		t.Fatal(err)
	}
	waitMoves(4, 2*time.Second)
	// An engine that cannot start: the one before is started again.
	if err := m.ReplaceEngine("black", PlayerConfig{Name: "Missing", EnginePath: "/no/such/engine"}); err == nil {
		t.Fatal("a missing engine should be an error")
	}
	s = m.State()
	if !s.Active || s.Players["black"].Name != "Fast" {
		t.Fatalf("after a failed swap: active %v, black %q", s.Active, s.Players["black"].Name)
	}
	if err := m.Move("g1f3"); err != nil {
		t.Fatal(err)
	}
	waitMoves(6, 2*time.Second)
	// The slow engine, long gone, never moved for black.
	time.Sleep(3500 * time.Millisecond)
	if s := m.State(); len(s.Moves) != 6 || !s.Active {
		t.Fatalf("moves %d, active %v, %q", len(s.Moves), s.Active, s.Reason)
	}
}
