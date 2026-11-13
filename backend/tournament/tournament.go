// Package tournament plays many games between two engines, for testing
// one against the other: openings in pairs with colours reversed, several
// games at once, with Elo and an SPRT (sequential probability ratio test)
// that stops as soon as the result is clear.
package tournament

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"board/backend/chess"
	"board/backend/game"
	"board/backend/pgn"
)

// SPRT tests H0: Elo = Elo0 against H1: Elo = Elo1 (logistic Elo, the
// first engine against the second).
type SPRT struct {
	Enabled bool    `json:"enabled"`
	Elo0    float64 `json:"elo0"`
	Elo1    float64 `json:"elo1"`
	Alpha   float64 `json:"alpha"`
	Beta    float64 `json:"beta"`
}

type Config struct {
	Engines      [2]EngineSpec `json:"engines"` // the first is the one tested
	TimeControl  TimeControl   `json:"timeControl"`
	Concurrency  int           `json:"concurrency"`
	Games        int           `json:"games"` // most games, made even; 0 with SPRT: until it decides
	Openings     OpeningConfig `json:"openings"`
	SPRT         SPRT          `json:"sprt"`
	Adjudication Adjudication  `json:"adjudication"`
	PGNPath      string        `json:"pgnPath"` // where games are saved, "" for nowhere
	Event        string        `json:"event"`
}

// LiveGame is a game being played.
type LiveGame struct {
	Worker  int    `json:"worker"`
	Number  int    `json:"number"`
	White   string `json:"white"`
	Black   string `json:"black"`
	Plies   int    `json:"plies"`
	Opening string `json:"opening"`
}

// GameRecord is a finished game.
type GameRecord struct {
	Number  int    `json:"number"`
	White   string `json:"white"`
	Black   string `json:"black"`
	Result  string `json:"result"`
	Reason  string `json:"reason"`
	Plies   int    `json:"plies"`
	Opening string `json:"opening"`
	pgn     string
}

// Status is sent to the UI as the "tournament" event.
type Status struct {
	State     string       `json:"state"` // idle, running, stopping, finished, error
	Message   string       `json:"message"`
	Verdict   string       `json:"verdict"` // H0, H1 (SPRT) or ""
	Names     [2]string    `json:"names"`
	TC        string       `json:"tc"`
	Workers   int          `json:"workers"`
	Total     int          `json:"total"` // planned games, 0: until the SPRT decides
	Openings  int          `json:"openings"`
	Stats     Stats        `json:"stats"`
	Games     int          `json:"games"`
	Score     float64      `json:"score"`
	Elo       float64      `json:"elo"`
	EloMargin float64      `json:"eloMargin"`
	LOS       float64      `json:"los"`
	DrawRatio float64      `json:"drawRatio"`
	SPRT      SPRT         `json:"sprt"`
	LLR       float64      `json:"llr"`
	Lower     float64      `json:"lower"`
	Upper     float64      `json:"upper"`
	Elapsed   float64      `json:"elapsed"` // seconds
	TimeLoss  [2]int       `json:"timeLosses"`
	Crashes   [2]int       `json:"crashes"`
	Live      []LiveGame   `json:"live"`
	Recent    []GameRecord `json:"recent"` // newest first
	PGNPath   string       `json:"pgnPath"`
	Watching  bool         `json:"watching"`
}

// Hooks connect the tournament to the app.
type Hooks struct {
	Emit func(event string, data any)
	Show func(game.ExternalView) // a game to show on the board, live
	Save func(path, pgn string) error
	// Done is called when a tournament ends (finished or stopped).
	Done func()
	// Info receives the watched game's engine output, for the engine windows.
	Info func(game.EngineInfo)
}

const keepRecent = 200

type Tournament struct {
	mu       sync.Mutex
	hooks    Hooks
	cfg      Config
	ops      []Opening
	cancel   context.CancelFunc
	done     chan struct{}
	st       Status
	started  time.Time
	nextPair int
	pairs    int // pairs to play, 0: no limit
	live     map[int]*LiveGame
	recent   []GameRecord
	games    int // games numbered so far
	watching bool
	watched  int // worker shown on the board
	lastEmit time.Time
	emitting bool
	// For the report.
	ended       time.Time
	reportGames []ReportGame
	pairPoints  []PairPoint
}

func New(h Hooks) *Tournament {
	return &Tournament{hooks: h, st: Status{State: "idle"}, live: map[int]*LiveGame{}}
}

// Running reports whether a tournament is being played.
func (t *Tournament) Running() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.st.State == "running" || t.st.State == "stopping"
}

func (t *Tournament) validate(c *Config) error {
	for i, e := range c.Engines {
		if e.Path == "" {
			return fmt.Errorf("choose engine %d", i+1)
		}
		if e.Name == "" {
			c.Engines[i].Name = fmt.Sprintf("Engine %d", i+1)
		}
	}
	if c.Engines[0].Name == c.Engines[1].Name {
		c.Engines[1].Name += " (2)"
	}
	tc := &c.TimeControl
	if tc.clocked() && tc.BaseMs <= 0 && tc.IncMs <= 0 {
		return errors.New("set a time control")
	}
	if tc.MarginMs <= 0 {
		tc.MarginMs = 100
	}
	if c.Concurrency < 1 {
		c.Concurrency = 1
	}
	if c.Concurrency > 128 {
		c.Concurrency = 128
	}
	if c.Games < 0 {
		c.Games = 0
	}
	if c.Games == 0 && !c.SPRT.Enabled {
		return errors.New("set the number of games, or turn on the SPRT to play until it decides")
	}
	if c.SPRT.Enabled {
		s := &c.SPRT
		if s.Alpha <= 0 || s.Alpha >= 0.5 || s.Beta <= 0 || s.Beta >= 0.5 {
			return errors.New("SPRT alpha and beta must be between 0 and 0.5")
		}
		if s.Elo1 <= s.Elo0 {
			return errors.New("SPRT elo1 must be above elo0")
		}
	}
	a := &c.Adjudication
	if a.DrawMoveNumber <= 0 {
		a.DrawMoveNumber = 40
	}
	if a.DrawMoves <= 0 {
		a.DrawMoves = 8
	}
	if a.ResignMoves <= 0 {
		a.ResignMoves = 3
	}
	if a.ResignScore <= 0 {
		a.ResignScore = 1000
	}
	if c.Openings.Seed == 0 {
		c.Openings.Seed = time.Now().UnixNano()
	}
	if c.Event == "" {
		c.Event = fmt.Sprintf("%s vs %s", c.Engines[0].Name, c.Engines[1].Name)
	}
	return nil
}

// Start begins a tournament. It fails while one is running.
func (t *Tournament) Start(c Config) error {
	if t.Running() {
		return errors.New("a tournament is already running")
	}
	if err := t.validate(&c); err != nil {
		return err
	}
	ops, err := loadOpenings(c.Openings)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.mu.Lock()
	t.cfg, t.ops, t.cancel, t.done = c, ops, cancel, make(chan struct{})
	t.started, t.nextPair, t.games = time.Now(), 0, 0
	t.pairs = (c.Games + 1) / 2
	t.live, t.recent = map[int]*LiveGame{}, nil
	t.reportGames, t.pairPoints, t.ended = nil, nil, time.Time{}
	t.st = Status{
		State: "running", Names: [2]string{c.Engines[0].Name, c.Engines[1].Name}, TC: c.TimeControl.String(),
		Workers: c.Concurrency, Total: t.pairs * 2, Openings: len(ops), SPRT: c.SPRT, PGNPath: c.PGNPath,
	}
	if c.SPRT.Enabled {
		t.st.Lower, t.st.Upper = Bounds(c.SPRT.Alpha, c.SPRT.Beta)
	}
	t.watched = 0
	done := t.done
	t.mu.Unlock()
	t.emit(true)

	var wg sync.WaitGroup
	for w := 0; w < c.Concurrency; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			t.work(ctx, w)
		}(w)
	}
	go func() {
		wg.Wait()
		t.mu.Lock()
		switch t.st.State {
		case "stopping":
			t.st.State = "finished"
			if t.st.Message == "" {
				t.st.Message = "Stopped"
			}
		case "running":
			t.st.State = "finished"
			if t.st.Message == "" {
				t.st.Message = fmt.Sprintf("All %d games played", t.st.Games)
			}
		}
		t.live = map[int]*LiveGame{}
		t.ended = time.Now()
		t.mu.Unlock()
		cancel()
		close(done)
		if t.hooks.Done != nil {
			t.hooks.Done()
		}
		t.mu.Lock()
		t.watching = false
		t.mu.Unlock()
		t.emit(true)
	}()
	return nil
}

// Stop ends the tournament; games in progress are abandoned (not counted).
func (t *Tournament) Stop() {
	t.mu.Lock()
	if t.st.State != "running" {
		t.mu.Unlock()
		return
	}
	t.st.State = "stopping"
	t.st.Message = "Stopped"
	cancel := t.cancel
	t.mu.Unlock()
	cancel()
	t.emit(true)
}

// Wait waits for a stopped or finished tournament's engines to close.
func (t *Tournament) Wait(d time.Duration) {
	t.mu.Lock()
	done := t.done
	t.mu.Unlock()
	if done == nil {
		return
	}
	select {
	case <-done:
	case <-time.After(d):
	}
}

// Watch shows the games of one worker on the board as they are played.
func (t *Tournament) Watch(on bool) {
	t.mu.Lock()
	t.watching = on
	t.mu.Unlock()
	t.emit(true)
}

func (t *Tournament) Watching() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.watching
}

// GamePGN is a finished game from the list, by number.
func (t *Tournament) GamePGN(number int) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, r := range t.recent {
		if r.Number == number {
			return r.pgn, nil
		}
	}
	return "", errors.New("that game is no longer in the list; open the tournament's PGN file")
}

func (t *Tournament) Status() Status {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.statusLocked()
}

func (t *Tournament) statusLocked() Status {
	s := t.st
	s.Watching = t.watching
	if !t.started.IsZero() {
		s.Elapsed = time.Since(t.started).Seconds()
	}
	s.Live = []LiveGame{}
	for w := 0; w < t.cfg.Concurrency; w++ {
		if g := t.live[w]; g != nil {
			s.Live = append(s.Live, *g)
		}
	}
	n := len(t.recent)
	if n > 50 {
		n = 50
	}
	s.Recent = make([]GameRecord, 0, n)
	for i := len(t.recent) - 1; i >= 0 && len(s.Recent) < n; i-- {
		s.Recent = append(s.Recent, t.recent[i])
	}
	return s
}

// emit sends the status, at most a few times a second unless forced.
func (t *Tournament) emit(force bool) {
	if t.hooks.Emit == nil {
		return
	}
	t.mu.Lock()
	if !force && time.Since(t.lastEmit) < 250*time.Millisecond {
		if !t.emitting {
			t.emitting = true
			time.AfterFunc(250*time.Millisecond, func() {
				t.mu.Lock()
				t.emitting = false
				t.mu.Unlock()
				t.emit(true)
			})
		}
		t.mu.Unlock()
		return
	}
	t.lastEmit = time.Now()
	s := t.statusLocked()
	t.mu.Unlock()
	t.hooks.Emit("tournament", s)
}

// takePair gives a worker the next pair to play, or false when done.
func (t *Tournament) takePair() (int, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.st.State != "running" || (t.pairs > 0 && t.nextPair >= t.pairs) {
		return 0, false
	}
	p := t.nextPair
	t.nextPair++
	return p, true
}

func (t *Tournament) work(ctx context.Context, w int) {
	players := [2]*player{{spec: t.cfg.Engines[0]}, {spec: t.cfg.Engines[1]}}
	defer func() {
		for _, p := range players {
			p.stop()
		}
	}()
	for ctx.Err() == nil {
		pair, ok := t.takePair()
		if !ok {
			return
		}
		op := t.ops[pair%len(t.ops)]
		var points float64 // the first engine's, in this pair
		complete := true
		for g := 0; g < 2; g++ {
			// Game 1: the first engine has white; game 2: the second.
			seats := [2]*player{players[0], players[1]}
			if g == 1 {
				seats = [2]*player{players[1], players[0]}
			}
			began := time.Now()
			res, number, err := t.playOne(ctx, w, op, seats, g == 1)
			if err != nil {
				complete = false
				break
			}
			p := map[string]float64{"1-0": 1, "0-1": 0, "1/2-1/2": 0.5}[res.Result]
			if g == 1 {
				p = 1 - p
			}
			points += p
			t.record(number, op, seats, res, g == 1, p)
			t.addReportGame(number, pair, op, seats, res, g == 1, p, time.Since(began))
		}
		if complete {
			t.recordPair(pair, points)
		}
	}
}

func (t *Tournament) playOne(ctx context.Context, w int, op Opening, seats [2]*player, swapped bool) (gameResult, int, error) {
	t.mu.Lock()
	t.games++
	number := t.games
	lg := &LiveGame{Worker: w + 1, Number: number, White: seats[0].spec.Name, Black: seats[1].spec.Name, Opening: op.Name}
	t.live[w] = lg
	t.mu.Unlock()
	t.emit(false)
	start, _ := chess.ParseFEN(op.FEN)
	update := func(u moveUpdate) {
		t.mu.Lock()
		lg.Plies = len(u.moves)
		show := t.watching && t.watched == w && t.hooks.Show != nil
		t.mu.Unlock()
		if show {
			t.show(number, op, seats, start, u, nil)
		}
		t.emit(false)
	}
	res, err := playGame(ctx, op, seats, t.cfg.TimeControl, t.cfg.Adjudication, update)
	t.mu.Lock()
	delete(t.live, w)
	show := t.watching && t.watched == w && t.hooks.Show != nil
	t.mu.Unlock()
	if err == nil && show {
		t.show(number, op, seats, start, moveUpdate{moves: res.Moves}, &res)
	}
	return res, number, err
}

// show puts a worker's game on the board.
func (t *Tournament) show(number int, op Opening, seats [2]*player, start chess.Position, u moveUpdate, res *gameResult) {
	pc := func(p *player) game.PlayerConfig { return game.PlayerConfig{Type: "engine", Name: p.spec.Name} }
	v := game.ExternalView{
		ID: fmt.Sprintf("tournament-%d", number), Label: fmt.Sprintf("Tournament · game %d · %s", number, t.cfg.TimeControl),
		Side: "white", Kind: "tournament", White: pc(seats[0]), Black: pc(seats[1]),
		StartFEN: start.FEN(), Moves: u.moves, At: u.turnAt,
	}
	if t.cfg.TimeControl.clocked() {
		v.WhiteMs, v.BlackMs = u.clocks[0], u.clocks[1]
		v.Running = u.running
	}
	if res != nil {
		v.Finished, v.Result, v.Reason = true, res.Result, res.Reason
		v.Running = false
	}
	t.hooks.Show(v)
	// The engine windows: the search that chose the last move.
	if t.hooks.Info != nil && res == nil && len(u.info.PV) > 0 && len(u.moves) > 0 {
		pos := start
		for _, m := range u.moves[:len(u.moves)-1] {
			mv, err := pos.ParseUCIMove(m)
			if err != nil {
				return
			}
			pos = pos.Make(mv)
		}
		in := u.info
		out := game.EngineInfo{
			Side: map[chess.Color]string{chess.White: "white", chess.Black: "black"}[u.side], Depth: in.Depth,
			HasEval: in.HasScore, CP: in.ScoreCP, IsMate: in.IsMate, Mate: in.Mate, Nodes: in.Nodes, NPS: in.NPS,
			Ply: len(u.moves) - 1,
		}
		if u.side == chess.Black {
			out.CP, out.Mate = -out.CP, -out.Mate
		}
		p := pos
		for i, s := range in.PV {
			if i == 12 {
				break
			}
			mv, err := p.ParseUCIMove(s)
			if err != nil {
				break
			}
			out.PV = append(out.PV, p.SAN(mv))
			p = p.Make(mv)
		}
		t.hooks.Info(out)
	}
}

// record counts a finished game; points are the first engine's.
func (t *Tournament) record(number int, op Opening, seats [2]*player, res gameResult, swapped bool, points float64) {
	text, _ := t.gamePGN(number, op, seats, res)
	t.mu.Lock()
	s := &t.st.Stats
	switch points {
	case 1:
		s.Wins++
	case 0:
		s.Losses++
	default:
		s.Draws++
	}
	loser := -1
	if res.Result == "1-0" {
		loser = 1
	} else if res.Result == "0-1" {
		loser = 0
	}
	if loser >= 0 {
		engine := loser
		if swapped {
			engine = 1 - loser
		}
		if res.TimeOut {
			t.st.TimeLoss[engine]++
		}
		if res.Crashed {
			t.st.Crashes[engine]++
		}
	}
	t.recent = append(t.recent, GameRecord{
		Number: number, White: seats[0].spec.Name, Black: seats[1].spec.Name,
		Result: res.Result, Reason: res.Reason, Plies: len(res.Moves), Opening: op.Name, pgn: text,
	})
	if len(t.recent) > keepRecent {
		t.recent = t.recent[len(t.recent)-keepRecent:]
	}
	t.updateLocked()
	path := t.cfg.PGNPath
	t.mu.Unlock()
	if path != "" && t.hooks.Save != nil && text != "" {
		if err := t.hooks.Save(path, text); err != nil {
			t.mu.Lock()
			t.st.Message = "Could not save games: " + err.Error()
			t.mu.Unlock()
		}
	}
	t.emit(false)
}

func (t *Tournament) recordPair(pair int, points float64) {
	t.mu.Lock()
	i := int(math.Round(points * 2))
	if i >= 0 && i <= 4 {
		t.st.Stats.Penta[i]++
	}
	t.updateLocked()
	t.pairPoints = append(t.pairPoints, PairPoint{
		Pair: pair + 1, Games: t.st.Games, Points: points, LLR: t.st.LLR, Elo: t.st.Elo, Margin: t.st.EloMargin,
		Score: t.st.Score, At: time.Since(t.started).Seconds(),
	})
	decided := false
	if c := t.cfg.SPRT; c.Enabled && t.st.State == "running" {
		switch {
		case t.st.LLR >= t.st.Upper:
			t.st.Verdict = "H1"
			t.st.Message = fmt.Sprintf("H1 accepted: %s is at least %g Elo stronger", t.st.Names[0], c.Elo1)
			decided = true
		case t.st.LLR <= t.st.Lower:
			t.st.Verdict = "H0"
			t.st.Message = fmt.Sprintf("H0 accepted: %s is not %g Elo stronger", t.st.Names[0], c.Elo1)
			if c.Elo0 != 0 {
				t.st.Message = fmt.Sprintf("H0 accepted: %s is at most %g Elo stronger", t.st.Names[0], c.Elo0)
			}
			decided = true
		}
	}
	var cancel context.CancelFunc
	if decided {
		t.st.State = "stopping"
		cancel = t.cancel
	}
	t.mu.Unlock()
	if cancel != nil {
		cancel() // games in progress no longer matter
	}
	t.emit(decided)
}

func (t *Tournament) updateLocked() {
	s := &t.st
	s.Games = s.Stats.Games()
	s.Score = s.Stats.Score()
	s.Elo, s.EloMargin, s.LOS = s.Stats.Elo()
	if s.Games > 0 {
		s.DrawRatio = float64(s.Stats.Draws) / float64(s.Games)
	}
	if t.cfg.SPRT.Enabled {
		s.LLR = s.Stats.LLR(t.cfg.SPRT.Elo0, t.cfg.SPRT.Elo1)
	}
}

func (t *Tournament) gamePGN(number int, op Opening, seats [2]*player, res gameResult) (string, error) {
	tags := []pgn.Tag{
		{Name: "Event", Value: t.cfg.Event}, {Name: "Site", Value: "Ponder"},
		{Name: "Date", Value: time.Now().Format("2006.01.02")}, {Name: "Round", Value: fmt.Sprint(number)},
		{Name: "White", Value: seats[0].spec.Name}, {Name: "Black", Value: seats[1].spec.Name},
		{Name: "Result", Value: res.Result}, {Name: "TimeControl", Value: t.cfg.TimeControl.PGN()},
		{Name: "Termination", Value: res.Reason},
	}
	return game.FormatPGN(tags, op.FEN, res.Moves, res.Result)
}

// Describe is a one-line summary, for logs.
func (s Status) Describe() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s vs %s: +%d -%d =%d", s.Names[0], s.Names[1], s.Stats.Wins, s.Stats.Losses, s.Stats.Draws)
	fmt.Fprintf(&b, ", Elo %.1f ± %.1f", s.Elo, s.EloMargin)
	if s.SPRT.Enabled {
		fmt.Fprintf(&b, ", LLR %.2f (%.2f, %.2f)", s.LLR, s.Lower, s.Upper)
	}
	return b.String()
}
