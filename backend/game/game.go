// Package game runs one chess game at a time between any mix of human and
// UCI engine players, including clocks and game-end detection.
package game

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"board/backend/chess"
	"board/backend/openings"
	"board/backend/pgn"
	"board/backend/uci"
)

type PlayerConfig struct {
	Type        string            `json:"type"` // "human", "engine", or "loaded" (from a PGN file)
	Name        string            `json:"name"`
	Rating      string            `json:"rating,omitempty"`
	EnginePath  string            `json:"enginePath,omitempty"`
	EngineArgs  []string          `json:"engineArgs,omitempty"`
	Options     map[string]string `json:"options,omitempty"`
	TimeControl TimeControl       `json:"timeControl"`
}

func (p PlayerConfig) isEngine() bool { return p.Type == "engine" }

type Config struct {
	White PlayerConfig `json:"white"`
	Black PlayerConfig `json:"black"`
	FEN   string       `json:"fen,omitempty"`
}

type MoveRecord struct {
	UCI     string `json:"uci"`
	SAN     string `json:"san"`
	FEN     string `json:"fen"`               // position after the move
	Opening string `json:"opening,omitempty"` // most specific book opening reached so far, e.g. "C42 Petrov's Defense"
}

// bookOpening is the book's name for pos, or else the name already reached.
func bookOpening(pos *chess.Position, sofar string) string {
	if o, ok := openings.Lookup(pos); ok {
		return o.String()
	}
	return sofar
}

type ClockState struct {
	Ms    int64 `json:"ms"`
	Timed bool  `json:"timed"`
}

// State is the full snapshot sent to the UI whenever anything changes.
type State struct {
	Active      bool                    `json:"active"`
	StartFEN    string                  `json:"startFen"`
	FEN         string                  `json:"fen"`
	Turn        string                  `json:"turn"`
	Moves       []MoveRecord            `json:"moves"`
	LegalMoves  []string                `json:"legalMoves"`
	Check       bool                    `json:"check"`
	Result      string                  `json:"result"` // "*", "1-0", "0-1", "1/2-1/2"
	Reason      string                  `json:"reason"`
	Players     map[string]PlayerConfig `json:"players"`
	Clocks      map[string]ClockState   `json:"clocks"`
	Running     string                  `json:"running"` // side whose clock is running, or ""
	HumanToMove bool                    `json:"humanToMove"`
	Opening     string                  `json:"opening"` // latest opening name reported by an engine
	Game        int                     `json:"game"`    // changes whenever a new game starts or is loaded
	Loaded      bool                    `json:"loaded"`  // the game was opened from a PGN file
	Source      string                  `json:"source"`  // file name of a loaded game
	Index       int                     `json:"index"`   // a loaded game's position in its file, else -1
	Tags        []pgn.Tag               `json:"tags"`    // a loaded game's PGN tags
	// The book's name for the starting position, when it starts mid-opening.
	StartOpening string `json:"startOpening,omitempty"`
	// A human can take back their last move.
	CanTakeback bool `json:"canTakeback"`
	// Set while the board shows a game played elsewhere (a Lichess bot game).
	External *ExternalInfo `json:"external,omitempty"`
	// The sides whose engine is being swapped or reloaded.
	Loading []string `json:"loading,omitempty"`
}

// ExternalInfo describes a game shown from elsewhere.
type ExternalInfo struct {
	ID    string `json:"id"`
	URL   string `json:"url"`
	Label string `json:"label"`
	Live  bool   `json:"live"` // still being played
	Side  string `json:"side"` // the side to show at the bottom
	// What it is: "bot" (your engine on Lichess), "play" (you, on Lichess),
	// "spectate" or "tournament".
	Kind string `json:"kind"`
	// You play Side's moves on the board (sent to Lichess).
	Playable bool `json:"playable,omitempty"`
	// How the players' ratings changed, once a rated game is over and
	// Lichess has worked it out.
	RatingDiff *RatingDiff `json:"ratingDiff,omitempty"`
	// The players' Lichess usernames ("" for the computer) and the game's
	// speed (bullet, blitz, …), to look the players up.
	Users *Users `json:"users,omitempty"`
	Speed string `json:"speed,omitempty"`
}

// Users are the two players' Lichess usernames.
type Users struct {
	White string `json:"white"`
	Black string `json:"black"`
}

// RatingDiff is the rating each side won or lost in a game.
type RatingDiff struct {
	White int `json:"white"`
	Black int `json:"black"`
}

// ExternalView is a game played elsewhere, shown on the board read-only.
type ExternalView struct {
	ID, URL, Label   string
	Side             string // "white" or "black": the side to show at the bottom
	Kind             string // bot, play, spectate, tournament
	Playable         bool   // the person moves Side's pieces on the board
	RatingDiff       *RatingDiff
	Users            *Users
	Speed            string
	White, Black     PlayerConfig
	StartFEN         string
	Moves            []string // UCI
	WhiteMs, BlackMs int64    // clocks at time At
	At               time.Time
	Running          bool // the side to move's clock is running
	Finished         bool
	Result, Reason   string
}

// EngineString is a free-text "info string" message from an engine.
type EngineString struct {
	Side    string `json:"side"`
	Text    string `json:"text"`
	Ply     int    `json:"ply"`
	Opening string `json:"opening,omitempty"` // set when the text names an opening
}

// EngineInfo is a search update, with the score from White's point of view.
type EngineInfo struct {
	Side    string `json:"side"`
	Depth   int    `json:"depth"`
	HasEval bool   `json:"hasEval"`
	CP      int    `json:"cp"`
	IsMate  bool   `json:"isMate"`
	Mate    int    `json:"mate"`
	// WDL: win/draw/loss chances in thousandths, White's first, when the
	// engine reports them.
	WDL   *[3]int  `json:"wdl,omitempty"`
	Nodes int64    `json:"nodes"`
	NPS   int64    `json:"nps"`
	PV    []string `json:"pv"`
	Ply   int      `json:"ply"`
	// Hashfull: how full the engine's hash table is, in thousandths, when
	// it says; HashMB: the table's size.
	Hashfull *int `json:"hashfull,omitempty"`
	HashMB   int  `json:"hashMB,omitempty"`
	// The move the engine means to play and the reply it expects (UCI), for
	// arrows on the board; Played once it has chosen the move.
	Best   string `json:"best,omitempty"`
	Ponder string `json:"ponder,omitempty"`
	Played bool   `json:"played,omitempty"`
	// Pondering: the engine is thinking on its opponent's time, about the
	// reply in Ponder; PV starts with that reply.
	Pondering bool `json:"pondering,omitempty"`
	// PonderHit: the opponent played the reply the engine was pondering on,
	// so this search had a head start.
	PonderHit bool `json:"ponderHit,omitempty"`
	// Stats: only the depth and the counts are new (a line of the search
	// without moves); the rest stays as it was.
	Stats bool `json:"stats,omitempty"`
}

type current struct {
	cfg       Config
	players   [2]PlayerConfig
	startFEN  string
	start     chess.Position
	pos       chess.Position
	moves     []MoveRecord
	seen      map[chess.Key]int
	clocks    [2]*Clock
	engines   [2]*uci.Engine
	turnStart time.Time
	flag      *time.Timer
	result    string
	reason    string
	started   time.Time
	lastInfo  [2]time.Time
	opening   string
	ended     bool      // the game has finished, been aborted or abandoned
	loaded    bool      // opened from a PGN file, for viewing only
	tags      []pgn.Tag // a loaded game's tags, kept for export
	source    string
	index     int // position of a loaded game in its file
	// Book opening of the starting position (usually none).
	startOpening string
	external     *ExternalInfo // a game played elsewhere, shown read-only
	extRunning   bool
	// Searches stopped by a takeback: their bestmove is to be ignored.
	ignoreBest [2]int
	// Option changes saved while the engine was searching: sent before
	// its next search.
	pendingOpts [2][]string
	// Which engine sits at each side: bumped when one is swapped or
	// reloaded, so what the one before still sends is ignored.
	seat [2]int
	// A side's engine is being started in place of another: its clock
	// waits and it is not asked for a move until it is ready.
	loading [2]bool
}

// bookSoFar is the book opening reached by the last move played.
func (g *current) bookSoFar() string {
	if n := len(g.moves); n > 0 {
		return g.moves[n-1].Opening
	}
	return g.startOpening
}

// over reports whether the game no longer accepts moves. An aborted game is
// over even though its result is still "*".
func (g *current) over() bool { return g.loaded || g.ended || g.external != nil }

// Manager owns the current game. All methods are safe for concurrent use.
type Manager struct {
	mu   sync.Mutex
	emit func(event string, data any)
	gen  int // bumped for every new game; stale callbacks are ignored
	g    *current
	// onFinish receives the PGN of every game played here that ends with
	// a result (not aborted or abandoned).
	onFinish func(pgn string)
	ann      *Annotations // while exporting
}

// OnFinish sets the function given the PGN of each finished game.
func (m *Manager) OnFinish(f func(pgn string)) {
	m.mu.Lock()
	m.onFinish = f
	m.mu.Unlock()
}

func NewManager(emit func(event string, data any)) *Manager {
	return &Manager{emit: emit}
}

var colorNames = [2]string{"white", "black"}

// NewGame ends any running game and starts a new one.
func (m *Manager) NewGame(cfg Config) error {
	players := [2]PlayerConfig{cfg.White, cfg.Black}
	for i := range players {
		p := &players[i]
		if p.Type != "human" && p.Type != "engine" {
			return fmt.Errorf("%s: unknown player type %q", colorNames[i], p.Type)
		}
		if err := p.TimeControl.Validate(p.isEngine()); err != nil {
			return fmt.Errorf("%s: %w", colorNames[i], err)
		}
		if p.isEngine() && p.EnginePath == "" {
			return fmt.Errorf("%s: no engine selected", colorNames[i])
		}
		if p.Name == "" {
			p.Name = map[bool]string{true: "Engine", false: "Human"}[p.isEngine()]
		}
	}
	fen := strings.TrimSpace(cfg.FEN)
	if fen == "" {
		fen = chess.StartFEN
	}
	pos, err := chess.ParseFEN(fen)
	if err != nil {
		return err
	}

	m.mu.Lock()
	m.endLocked("*", "Game abandoned")
	m.gen++
	gen := m.gen
	m.mu.Unlock()

	// Start engines outside the lock: their reader goroutines call back into us.
	var engines [2]*uci.Engine
	for i, p := range players {
		if !p.isEngine() {
			continue
		}
		e, err := m.startEngine(gen, chess.Color(i), 0, p)
		if err != nil {
			if engines[0] != nil {
				engines[0].Quit()
			}
			return fmt.Errorf("%s engine (%s): %w", colorNames[i], p.Name, err)
		}
		engines[i] = e
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.gen != gen { // superseded while engines were starting
		for _, e := range engines {
			if e != nil {
				e.Quit()
			}
		}
		return errors.New("superseded by another new game")
	}
	g := &current{
		cfg: cfg, players: players, startFEN: pos.FEN(), start: pos, pos: pos,
		seen:    map[chess.Key]int{pos.Key(): 1},
		clocks:  [2]*Clock{NewClock(players[0].TimeControl), NewClock(players[1].TimeControl)},
		engines: engines, result: "*", started: time.Now(),
		startOpening: bookOpening(&pos, ""),
	}
	m.g = g
	if !m.checkEndLocked() {
		m.startTurnLocked()
	}
	return nil
}

// startEngine starts the engine of a player, for the side and seat given,
// ready for the game: its options set and told a new game begins.
func (m *Manager) startEngine(gen int, side chess.Color, seat int, p PlayerConfig) (*uci.Engine, error) {
	e, err := uci.Start(p.EnginePath, p.EngineArgs, uci.Handlers{
		OnInfo:     func(in uci.Info) { m.onInfo(gen, side, seat, in) },
		OnBestMove: func(mv string) { m.onBestMove(gen, side, seat, mv) },
		OnString:   func(text string) { m.onString(gen, side, seat, text) },
		OnExit:     func() { m.onEngineExit(gen, side, seat) },
	})
	if err != nil {
		return nil, err
	}
	if err = e.ApplyOptions(uci.WithWDL(e.Options, p.Options)); err == nil {
		err = e.NewGame()
	}
	if err != nil {
		e.Quit()
		return nil, err
	}
	return e, nil
}

// fromSeat reports whether a message comes from the engine now at side in
// the game being played (not one swapped out, or of a game before).
func (m *Manager) fromSeat(gen int, side chess.Color, seat int) bool {
	return gen == m.gen && m.g != nil && m.g.seat[side] == seat
}

// ReplaceEngine swaps the engine playing side ("white" or "black") in the
// game being played for another (p, keeping the side's time control), or
// reloads it (p's engine the same as before, or p with no engine path: the
// engine exactly as it was started). The engine before is stopped
// at once; the clock of that side waits while the new one starts, and if
// it is that side's turn the new engine is asked for a move as soon as it
// is ready. If the new engine cannot be started, the one before is started
// again; if that fails too, the side forfeits.
func (m *Manager) ReplaceEngine(sideName string, p PlayerConfig) error {
	side := chess.White
	switch sideName {
	case "white":
	case "black":
		side = chess.Black
	default:
		return fmt.Errorf("unknown side %q", sideName)
	}
	m.mu.Lock()
	g := m.g
	if g == nil || g.over() {
		m.mu.Unlock()
		return errors.New("no game is being played")
	}
	if !g.players[side].isEngine() {
		m.mu.Unlock()
		return fmt.Errorf("%s is not played by an engine", colorNames[side])
	}
	if g.loading[side] {
		m.mu.Unlock()
		return fmt.Errorf("%s's engine is already being started", colorNames[side])
	}
	before := g.players[side]
	if p.EnginePath == "" { // reload it as it was
		p = before
	}
	p.Type, p.TimeControl, p.Rating = "engine", before.TimeControl, ""
	if p.Name == "" {
		p.Name = "Engine"
	}
	gen := m.gen
	g.seat[side]++
	seat := g.seat[side]
	old := g.engines[side]
	g.engines[side] = nil
	g.loading[side] = true
	g.pendingOpts[side] = nil
	g.ignoreBest[side] = 0
	if g.pos.Turn == side {
		m.pauseTurnLocked()
	}
	m.emitStateLocked()
	m.mu.Unlock()
	if old != nil {
		old.Quit()
	}

	e, err := m.startEngine(gen, side, seat, p)
	used := p
	if err != nil {
		e, used = nil, before
		if e2, err2 := m.startEngine(gen, side, seat, before); err2 == nil {
			e = e2
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if gen != m.gen || m.g != g || g.over() || g.seat[side] != seat {
		if e != nil {
			e.Quit()
		}
		if err == nil {
			err = errors.New("the game ended while the engine was starting")
		}
		return err
	}
	g.loading[side] = false
	if e == nil {
		m.endLocked(winResult(side.Other()),
			fmt.Sprintf("%s forfeits: engine could not be started", capName(side)))
		return err
	}
	g.engines[side] = e
	g.players[side] = used
	if side == chess.White {
		g.cfg.White = used
	} else {
		g.cfg.Black = used
	}
	if g.pos.Turn == side {
		m.startTurnLocked()
	} else {
		m.emitStateLocked()
	}
	if err != nil {
		return fmt.Errorf("%s (the engine before was started again)", err)
	}
	return nil
}

// pauseTurnLocked stops the running clock of the side to move, counting the
// time it has used so far, until the turn is started again.
func (m *Manager) pauseTurnLocked() {
	g := m.g
	if g.flag != nil {
		g.flag.Stop()
		g.flag = nil
	}
	if !g.turnStart.IsZero() {
		c := g.clocks[g.pos.Turn]
		if c.Timed() && c.tc.Kind != "movetime" {
			c.RemainingMs -= time.Since(g.turnStart).Milliseconds()
			if c.RemainingMs < 0 {
				c.RemainingMs = 0
			}
		}
		g.turnStart = time.Time{}
	}
}

// startTurnLocked starts the clock of the side to move and, if that side is
// an engine, asks it for a move.
func (m *Manager) startTurnLocked() {
	g := m.g
	side := g.pos.Turn
	if g.loading[side] {
		// Its engine is starting: the turn begins when it is ready.
		g.turnStart = time.Time{}
		m.emitStateLocked()
		return
	}
	clock := g.clocks[side]
	g.turnStart = time.Now()
	engine := g.engines[side]

	// Engines on a fixed move time manage it themselves and are not flagged.
	if clock.Timed() && (engine == nil || clock.tc.Kind == "clock") {
		gen, ply := m.gen, len(g.moves)
		g.flag = time.AfterFunc(time.Duration(clock.RemainingMs)*time.Millisecond, func() {
			m.onFlag(gen, ply)
		})
	}
	if engine != nil {
		for _, c := range g.pendingOpts[side] {
			engine.Send(c)
		}
		g.pendingOpts[side] = nil
		engine.Go(g.positionCmd(), g.goCmd(side))
	}
	m.emitStateLocked()
}

// SameEngine reports whether a running engine was started from path with
// args: how an engine of the app's list is found among those running.
func SameEngine(path string, args []string, p string, a []string) bool {
	if path != p || len(args) != len(a) {
		return false
	}
	for i := range args {
		if args[i] != a[i] {
			return false
		}
	}
	return true
}

// UpdateEngineOptions gives the engines of the current game started from
// path with args their newly saved options: at once when an engine is not
// searching, otherwise just before its next search (UCI engines take
// options only between searches). It returns how many engines it reached.
func (m *Manager) UpdateEngineOptions(path string, args []string, opts map[string]string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	g := m.g
	if g == nil || g.over() {
		return 0
	}
	n := 0
	for i, e := range g.engines {
		p := g.players[i]
		if e == nil || !SameEngine(path, args, p.EnginePath, p.EngineArgs) {
			continue
		}
		n++
		g.players[i].Options = opts
		cmds := uci.OptionCommands(e.OptionChanges(uci.WithWDL(e.Options, opts)))
		if len(cmds) == 0 {
			continue
		}
		side := chess.Color(i)
		if g.pos.Turn == side { // searching for its move
			g.pendingOpts[side] = append(g.pendingOpts[side], cmds...)
			continue
		}
		for _, c := range cmds {
			e.Send(c)
		}
	}
	return n
}

func (g *current) positionCmd() string {
	var b strings.Builder
	if g.startFEN == chess.StartFEN {
		b.WriteString("position startpos")
	} else {
		b.WriteString("position fen " + g.startFEN)
	}
	if len(g.moves) > 0 {
		b.WriteString(" moves")
		for _, mv := range g.moves {
			b.WriteString(" " + mv.UCI)
		}
	}
	return b.String()
}

func (g *current) goCmd(side chess.Color) string {
	own, opp := g.clocks[side], g.clocks[side.Other()]
	switch own.tc.Kind {
	case "movetime":
		return fmt.Sprintf("go movetime %d", own.tc.MoveTimeMs)
	case "depth":
		return fmt.Sprintf("go depth %d", own.tc.Depth)
	}
	// If the opponent has no comparable clock, report our own figures for it.
	t := [2]int64{own.RemainingMs, own.RemainingMs}
	inc := [2]int64{own.IncMs(), own.IncMs()}
	if opp.tc.Kind == "clock" {
		t[side.Other()], inc[side.Other()] = opp.RemainingMs, opp.IncMs()
	}
	cmd := fmt.Sprintf("go wtime %d btime %d winc %d binc %d", t[0], t[1], inc[0], inc[1])
	if mtg := own.MovesToGo(); mtg > 0 {
		cmd += fmt.Sprintf(" movestogo %d", mtg)
	}
	return cmd
}

// Move plays a move for the human whose turn it is.
func (m *Manager) Move(uciMove string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	g := m.g
	if g == nil || g.over() {
		return errors.New("no game in progress")
	}
	if g.players[g.pos.Turn].isEngine() {
		return errors.New("it is the engine's turn")
	}
	mv, err := g.pos.ParseUCIMove(uciMove)
	if err != nil {
		return err
	}
	m.applyLocked(mv)
	return nil
}

func (m *Manager) applyLocked(mv chess.Move) {
	g := m.g
	side := g.pos.Turn
	clock := g.clocks[side]
	elapsed := time.Since(g.turnStart).Milliseconds()
	if g.flag != nil {
		g.flag.Stop()
		// The move arrived after the flag fell but before the timer ran.
		if elapsed > clock.RemainingMs {
			m.flagLocked(side)
			return
		}
		g.flag = nil
	}
	g.turnStart = time.Time{}
	san := g.pos.SAN(mv)
	g.pos = g.pos.Make(mv)
	g.moves = append(g.moves, MoveRecord{UCI: mv.UCI(), SAN: san, FEN: g.pos.FEN(), Opening: bookOpening(&g.pos, g.bookSoFar())})
	g.seen[g.pos.Key()]++
	clock.MoveDone(elapsed)
	if !m.checkEndLocked() {
		m.startTurnLocked()
	}
}

// checkEndLocked ends the game if the position on the board decides it.
func (m *Manager) checkEndLocked() bool {
	g := m.g
	switch {
	case len(g.pos.LegalMoves()) == 0:
		if g.pos.InCheck() {
			winner := g.pos.Turn.Other()
			m.endLocked(winResult(winner), capName(winner)+" wins by checkmate")
		} else {
			m.endLocked("1/2-1/2", "Draw by stalemate")
		}
	case g.pos.InsufficientMaterial():
		m.endLocked("1/2-1/2", "Draw by insufficient material")
	case g.seen[g.pos.Key()] >= 3:
		m.endLocked("1/2-1/2", "Draw by threefold repetition")
	case g.pos.Halfmove >= 100:
		m.endLocked("1/2-1/2", "Draw by the fifty-move rule")
	default:
		return false
	}
	return true
}

func capName(c chess.Color) string {
	if c == chess.White {
		return "White"
	}
	return "Black"
}

func winResult(winner chess.Color) string {
	if winner == chess.White {
		return "1-0"
	}
	return "0-1"
}

func (m *Manager) flagLocked(loser chess.Color) {
	g := m.g
	g.clocks[loser].RemainingMs = 0
	g.turnStart = time.Time{}
	winner := loser.Other()
	if !g.pos.CanMate(winner) {
		m.endLocked("1/2-1/2", fmt.Sprintf("Draw: %s ran out of time but %s cannot mate", loser, winner))
		return
	}
	m.endLocked(winResult(winner), capName(winner)+" wins on time")
}

// endLocked finishes the current game (if one is running) and stops engines.
func (m *Manager) endLocked(result, reason string) {
	g := m.g
	if g == nil || g.over() {
		return
	}
	if g.flag != nil {
		g.flag.Stop()
		g.flag = nil
	}
	// Freeze the running clock at its current value.
	if !g.turnStart.IsZero() {
		c := g.clocks[g.pos.Turn]
		if c.Timed() {
			c.RemainingMs -= time.Since(g.turnStart).Milliseconds()
			if c.RemainingMs < 0 {
				c.RemainingMs = 0
			}
		}
	}
	g.result, g.reason, g.ended = result, reason, true
	for _, e := range g.engines {
		if e != nil {
			e.Quit()
		}
	}
	m.emitStateLocked()
	if f := m.onFinish; f != nil && result != "*" && len(g.moves) > 0 {
		if text, err := m.pgnLocked(); err == nil {
			go f(text)
		}
	}
}

func (m *Manager) onFlag(gen, ply int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	g := m.g
	if gen != m.gen || g == nil || g.over() || len(g.moves) != ply {
		return
	}
	g.flag = nil
	m.flagLocked(g.pos.Turn)
}

func (m *Manager) onBestMove(gen int, side chess.Color, seat int, s string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	g := m.g
	if !m.fromSeat(gen, side, seat) || g.over() {
		return
	}
	if g.ignoreBest[side] > 0 {
		g.ignoreBest[side]--
		return
	}
	if g.pos.Turn != side {
		return
	}
	mv, err := g.pos.ParseUCIMove(s)
	if err != nil {
		m.endLocked(winResult(side.Other()),
			fmt.Sprintf("%s forfeits: engine sent illegal move %q", capName(side), s))
		return
	}
	m.applyLocked(mv)
}

func (m *Manager) onEngineExit(gen int, side chess.Color, seat int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.fromSeat(gen, side, seat) {
		return
	}
	m.endLocked(winResult(side.Other()),
		fmt.Sprintf("%s forfeits: engine process exited", capName(side)))
}

func (m *Manager) onInfo(gen int, side chess.Color, seat int, in uci.Info) {
	m.mu.Lock()
	defer m.mu.Unlock()
	g := m.g
	if !m.fromSeat(gen, side, seat) || g.over() || g.pos.Turn != side || in.MultiPV > 1 {
		return
	}
	// Engines can send thousands of lines a second; the UI needs a few.
	now := time.Now()
	if len(in.PV) == 0 || now.Sub(g.lastInfo[side]) < 80*time.Millisecond {
		return
	}
	g.lastInfo[side] = now
	out := EngineInfo{
		Side: colorNames[side], Depth: in.Depth, HasEval: in.HasScore, CP: in.ScoreCP,
		IsMate: in.IsMate, Mate: in.Mate, Nodes: in.Nodes, NPS: in.NPS, Ply: len(g.moves),
	}
	out.SetHash(in)
	if side == chess.Black {
		out.CP, out.Mate = -out.CP, -out.Mate
	}
	if in.HasWDL {
		w := in.WDL
		if side == chess.Black {
			w[0], w[2] = w[2], w[0]
		}
		out.WDL = &w
	}
	p := g.pos
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
	m.emit("engineInfo", out)
}

// Engines and book plug-ins report openings in many forms, e.g.
//
//	Opening: Sicilian Defense            ECO: B20 Sicilian Defense
//	opening name Ruy Lopez               B90 Sicilian, Najdorf
//	Book: Italian Game (C50)
var (
	openingLabel = regexp.MustCompile(`(?i)^\s*(?:opening(?:\s+name)?|eco|book\s+opening|book)\s*[:=\-]?\s*(.+?)\s*$`)
	ecoPrefix    = regexp.MustCompile(`^[A-E][0-9]{2}\b[\s:,\-]*\S`)
)

// OpeningName returns the opening named in an info string, or "".
func OpeningName(text string) string {
	if m := openingLabel.FindStringSubmatch(text); m != nil {
		name := m[1]
		// "book move e2e4", "book hit" and the like are not names.
		if strings.HasPrefix(strings.ToLower(text), "book") && !strings.ContainsAny(name, " ") && len(name) <= 5 {
			return ""
		}
		lower := strings.ToLower(name)
		if strings.HasPrefix(lower, "move") || strings.HasPrefix(lower, "hit") || strings.HasPrefix(lower, "miss") {
			return ""
		}
		return name
	}
	if ecoPrefix.MatchString(text) {
		return strings.TrimSpace(text)
	}
	return ""
}

func (m *Manager) onString(gen int, side chess.Color, seat int, text string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	g := m.g
	if !m.fromSeat(gen, side, seat) || g.over() {
		return
	}
	if len(text) > 500 {
		text = text[:500] + "…"
	}
	msg := EngineString{Side: colorNames[side], Text: text, Ply: len(g.moves), Opening: OpeningName(text)}
	m.emit("engineString", msg)
	if msg.Opening != "" && msg.Opening != g.opening {
		g.opening = msg.Opening
		m.emitStateLocked()
	}
}

// Resign ends the game as a loss for side ("white"/"black"). With side empty,
// the single human resigns, or the side to move in a two-human game.
func (m *Manager) Resign(side string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	g := m.g
	if g == nil || g.over() {
		return errors.New("no game in progress")
	}
	var loser chess.Color
	switch {
	case side == "white":
		loser = chess.White
	case side == "black":
		loser = chess.Black
	case g.players[0].isEngine() && !g.players[1].isEngine():
		loser = chess.Black
	case g.players[1].isEngine() && !g.players[0].isEngine():
		loser = chess.White
	default:
		loser = g.pos.Turn
	}
	m.endLocked(winResult(loser.Other()), capName(loser)+" resigned")
	return nil
}

// Draw ends a game between two humans as a draw by agreement.
func (m *Manager) Draw() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	g := m.g
	if g == nil || g.over() {
		return errors.New("no game in progress")
	}
	if g.players[0].isEngine() || g.players[1].isEngine() {
		return errors.New("draws by agreement are only available between two humans")
	}
	m.endLocked("1/2-1/2", "Draw by agreement")
	return nil
}

// Abort stops the game without a result.
func (m *Manager) Abort() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.endLocked("*", "Game aborted")
}

// State returns the current snapshot.
func (m *Manager) State() State {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.stateLocked()
}

func (m *Manager) emitStateLocked() { m.emit("state", m.stateLocked()) }

func (m *Manager) stateLocked() State {
	g := m.g
	if g == nil {
		return State{StartFEN: chess.StartFEN, FEN: chess.StartFEN, Turn: "white", Result: "*",
			Moves: []MoveRecord{}, LegalMoves: []string{}, Index: -1}
	}
	s := State{
		Active: !g.over(), StartFEN: g.startFEN, FEN: g.pos.FEN(),
		Turn: colorNames[g.pos.Turn], Moves: g.moves, LegalMoves: []string{},
		Check: g.pos.InCheck(), Result: g.result, Reason: g.reason,
		Players: map[string]PlayerConfig{}, Clocks: map[string]ClockState{},
		Opening: g.opening, Game: m.gen, Loaded: g.loaded, Source: g.source, Index: -1,
		StartOpening: g.startOpening,
	}
	if g.loaded {
		s.Index, s.Tags = g.index, g.tags
	}
	if g.external != nil {
		ext := *g.external
		s.External = &ext
	}
	s.CanTakeback = m.takebackPliesLocked() > 0
	for i, l := range g.loading {
		if l && s.Active {
			s.Loading = append(s.Loading, colorNames[i])
		}
	}
	if s.Moves == nil {
		s.Moves = []MoveRecord{}
	}
	running := (s.Active || g.extRunning) && !g.turnStart.IsZero()
	for i, name := range colorNames {
		p := g.players[i]
		p.Options, p.EngineArgs = nil, nil
		s.Players[name] = p
		c := g.clocks[i]
		ms := c.RemainingMs
		if running && chess.Color(i) == g.pos.Turn && c.Timed() {
			ms -= time.Since(g.turnStart).Milliseconds()
			if ms < 0 {
				ms = 0
			}
			s.Running = name
		}
		s.Clocks[name] = ClockState{Ms: ms, Timed: c.Timed()}
	}
	if ext := g.external; ext != nil && ext.Playable && ext.Live {
		// Your Lichess game: you move on your turn, and may ask for a takeback.
		s.CanTakeback = len(g.moves) > 0
		if colorNames[g.pos.Turn] == ext.Side && g.result == "*" {
			s.HumanToMove = true
			for _, mv := range g.pos.LegalMoves() {
				s.LegalMoves = append(s.LegalMoves, mv.UCI())
			}
		}
	}
	if s.Active && !g.players[g.pos.Turn].isEngine() {
		s.HumanToMove = true
		for _, mv := range g.pos.LegalMoves() {
			s.LegalMoves = append(s.LegalMoves, mv.UCI())
		}
	}
	return s
}

// PGN exports the current game.
func (m *Manager) PGN() (string, error) {
	return m.AnnotatedPGN(nil)
}

// Annotations add analysis to an exported game, keyed by ply (1 for the
// first move): numeric glyphs, comments, and variations (PGN text, in
// parentheses) given after the move they replace.
type Annotations struct {
	NAGs       map[int][]int  `json:"nags"`
	Comments   map[int]string `json:"comments"`
	Variations map[int]string `json:"variations"`
	Before     string         `json:"before"` // a comment before the first move
	After      string         `json:"after"`  // a comment after the last move
	Annotator  string         `json:"annotator"`
}

// AnnotatedPGN is the game as PGN with the analysis given.
func (m *Manager) AnnotatedPGN(ann *Annotations) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ann = ann
	defer func() { m.ann = nil }()
	return m.pgnLocked()
}

func (m *Manager) pgnLocked() (string, error) {
	g := m.g
	if g == nil {
		return "", errors.New("no game to export")
	}
	var b strings.Builder
	tag := func(k, v string) {
		fmt.Fprintf(&b, "[%s \"%s\"]\n", k, strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(v))
	}
	if g.loaded {
		// A loaded game keeps the tags it came with.
		hasResult := false
		for _, t := range g.tags {
			if t.Name == "Result" {
				t.Value, hasResult = g.result, true
			}
			if t.Name == "Annotator" && m.ann != nil && m.ann.Annotator != "" {
				continue // written anew below
			}
			tag(t.Name, t.Value)
		}
		if !hasResult {
			tag("Result", g.result)
		}
		if m.ann != nil && m.ann.Annotator != "" {
			tag("Annotator", m.ann.Annotator)
		}
		writeMovetextAnnotated(&b, g, m.ann)
		return b.String(), nil
	}
	event, site := "Casual game", "?"
	if g.external != nil {
		event, site = g.external.Label, g.external.URL
	}
	tag("Event", event)
	tag("Site", site)
	tag("Date", g.started.Format("2006.01.02"))
	tag("Round", "-")
	tag("White", g.players[0].Name)
	tag("Black", g.players[1].Name)
	tag("Result", g.result)
	for i := range colorNames {
		if r := g.players[i].Rating; r != "" {
			tag(capName(chess.Color(i))+"Elo", r)
		}
	}
	wtc, btc := g.players[0].TimeControl.PGN(), g.players[1].TimeControl.PGN()
	if g.external != nil {
		// Lichess records the time control itself.
	} else if wtc == btc {
		tag("TimeControl", wtc)
	} else {
		tag("WhiteTimeControl", wtc)
		tag("BlackTimeControl", btc)
	}
	if g.startFEN != chess.StartFEN {
		tag("SetUp", "1")
		tag("FEN", g.startFEN)
	}
	// The book's name is standard; an engine's report is the fallback.
	if book := g.bookSoFar(); book != "" {
		eco, name, _ := strings.Cut(book, " ")
		tag("ECO", eco)
		tag("Opening", name)
	} else if g.opening != "" {
		tag("Opening", g.opening)
	}
	if g.reason != "" {
		tag("Termination", g.reason)
	}
	if m.ann != nil && m.ann.Annotator != "" {
		tag("Annotator", m.ann.Annotator)
	}
	writeMovetextAnnotated(&b, g, m.ann)
	return b.String(), nil
}

func writeMovetext(b *strings.Builder, g *current) { writeMovetextAnnotated(b, g, nil) }

func writeMovetextAnnotated(b *strings.Builder, g *current, ann *Annotations) {
	if ann == nil {
		ann = &Annotations{}
	}
	clean := strings.NewReplacer("{", "(", "}", ")")
	b.WriteString("\n")
	var tokens []string
	// A comment word by word, so long ones wrap with the moves.
	comment := func(text string) []string {
		return append(append([]string{"{"}, strings.Fields(clean.Replace(text))...), "}")
	}
	if ann.Before != "" {
		tokens = append(tokens, comment(ann.Before)...)
	}
	num, white := g.start.Fullmove, g.start.Turn == chess.White
	renumber := false // Black's move needs its number after a comment or variation
	for i, mv := range g.moves {
		ply := i + 1
		if white {
			tokens = append(tokens, fmt.Sprintf("%d.", num))
		} else if i == 0 || renumber {
			tokens = append(tokens, fmt.Sprintf("%d...", num))
		}
		renumber = false
		tokens = append(tokens, mv.SAN)
		for _, n := range ann.NAGs[ply] {
			if n > 0 {
				tokens = append(tokens, fmt.Sprintf("$%d", n))
			}
		}
		if c := ann.Comments[ply]; c != "" {
			tokens = append(tokens, comment(c)...)
			renumber = true
		}
		if v := ann.Variations[ply]; v != "" {
			tokens = append(tokens, strings.Fields(v)...)
			renumber = true
		}
		if !white {
			num++
		}
		white = !white
	}
	if ann.After != "" {
		tokens = append(tokens, comment(ann.After)...)
	}
	tokens = append(tokens, g.result)
	line := 0
	for _, t := range tokens {
		if line > 0 && line+1+len(t) > 80 {
			b.WriteString("\n")
			line = 0
		} else if line > 0 {
			b.WriteString(" ")
			line++
		}
		b.WriteString(t)
		line += len(t)
	}
	b.WriteString("\n")
}

// Shutdown ends the game and stops all engines.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.endLocked("*", "Game abandoned")
	m.gen++
}

// LoadGame ends any running game and shows a game read from a PGN file;
// index is its position in the file. The loaded game can be browsed and
// exported but not played on.
func (m *Manager) LoadGame(pg pgn.Game, source string, index int) error {
	start, moves, err := pg.Replay()
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.endLocked("*", "Game abandoned")
	m.gen++

	player := func(color, fallback string) PlayerConfig {
		name := strings.TrimSpace(pg.Tag(color))
		if name == "" || name == "?" {
			name = fallback
		}
		rating := pg.Tag(color + "Elo")
		if rating == "?" || rating == "-" || rating == "0" {
			rating = ""
		}
		return PlayerConfig{Type: "loaded", Name: name, Rating: rating, TimeControl: TimeControl{Kind: "none"}}
	}
	g := &current{
		players:  [2]PlayerConfig{player("White", "White"), player("Black", "Black")},
		startFEN: start.FEN(), start: start, pos: start,
		seen:   map[chess.Key]int{},
		clocks: [2]*Clock{NewClock(TimeControl{Kind: "none"}), NewClock(TimeControl{Kind: "none"})},
		loaded: true, tags: pg.Tags, source: source, index: index, started: time.Now(),
		startOpening: bookOpening(&start, ""),
	}
	for _, mv := range moves {
		san := g.pos.SAN(mv)
		g.pos = g.pos.Make(mv)
		g.moves = append(g.moves, MoveRecord{UCI: mv.UCI(), SAN: san, FEN: g.pos.FEN(), Opening: bookOpening(&g.pos, g.bookSoFar())})
	}

	g.result = pg.Tag("Result")
	if !validResult(g.result) {
		g.result = pg.Result
	}
	if !validResult(g.result) {
		g.result = "*"
	}
	g.reason = loadedReason(g, pg.Tag("Termination"))

	// "B20 Sicilian Defense: Alapin Variation"
	opening := strings.TrimSpace(pg.Tag("Opening"))
	if v := strings.TrimSpace(pg.Tag("Variation")); v != "" && opening != "" {
		opening += ": " + v
	}
	if eco := strings.TrimSpace(pg.Tag("ECO")); eco != "" && eco != "?" {
		opening = strings.TrimSpace(eco + " " + opening)
	}
	if opening != "?" {
		g.opening = opening
	}

	m.g = g
	m.emitStateLocked()
	return nil
}

func validResult(r string) bool {
	return r == "1-0" || r == "0-1" || r == "1/2-1/2" || r == "*"
}

// loadedReason describes how a loaded game ended.
func loadedReason(g *current, termination string) string {
	if len(g.pos.LegalMoves()) == 0 {
		if g.pos.InCheck() {
			return capName(g.pos.Turn.Other()) + " wins by checkmate"
		}
		return "Draw by stalemate"
	}
	switch t := strings.TrimSpace(termination); strings.ToLower(t) {
	case "", "normal", "unterminated", "?":
	default:
		return t
	}
	switch g.result {
	case "1-0":
		return "White won"
	case "0-1":
		return "Black won"
	case "1/2-1/2":
		return "Draw"
	}
	return "Unfinished game"
}

// ShowExternal shows a game played elsewhere. Updates to the game already
// shown keep the same game number, so the UI keeps its place.
func (m *Manager) ShowExternal(v ExternalView) error {
	start, err := chess.ParseFEN(v.StartFEN)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	same := m.g != nil && m.g.external != nil && m.g.external.ID == v.ID
	if !same {
		m.endLocked("*", "Game abandoned")
		m.gen++
	}
	g := &current{
		players:  [2]PlayerConfig{v.White, v.Black},
		startFEN: start.FEN(), start: start, pos: start,
		seen:         map[chess.Key]int{},
		clocks:       [2]*Clock{NewClock(TimeControl{Kind: "none"}), NewClock(TimeControl{Kind: "none"})},
		started:      time.Now(),
		startOpening: bookOpening(&start, ""),
		external:     &ExternalInfo{ID: v.ID, URL: v.URL, Label: v.Label, Live: !v.Finished, Side: v.Side, Kind: v.Kind, Playable: v.Playable && !v.Finished, RatingDiff: v.RatingDiff, Users: v.Users, Speed: v.Speed},
		index:        -1,
	}
	if same {
		g.started = m.g.started
	}
	g.seen[start.Key()]++
	for _, s := range v.Moves {
		mv, err := g.pos.ParseUCIMove(s)
		if err != nil {
			break
		}
		san := g.pos.SAN(mv)
		g.pos = g.pos.Make(mv)
		g.moves = append(g.moves, MoveRecord{UCI: mv.UCI(), SAN: san, FEN: g.pos.FEN(), Opening: bookOpening(&g.pos, g.bookSoFar())})
		g.seen[g.pos.Key()]++
	}
	if v.WhiteMs > 0 || v.BlackMs > 0 {
		for i, ms := range [2]int64{v.WhiteMs, v.BlackMs} {
			g.clocks[i] = &Clock{tc: TimeControl{Kind: "external"}, RemainingMs: ms}
		}
	}
	g.result, g.reason = "*", ""
	if v.Finished {
		g.result, g.reason = v.Result, v.Reason
		if !validResult(g.result) {
			g.result = "*"
		}
		// A server may say only that the game was drawn: the position says why.
		if g.result == "1/2-1/2" && (g.reason == "" || g.reason == "Draw") {
			g.reason = drawReason(g)
		}
	} else if v.Running {
		g.extRunning, g.turnStart = true, v.At
	}
	m.g = g
	m.emitStateLocked()
	return nil
}

// drawReason says why a drawn game whose moves are all known was drawn,
// from its last position: a draw nothing on the board explains was agreed.
func drawReason(g *current) string {
	switch {
	case len(g.pos.LegalMoves()) == 0:
		return "Draw by stalemate"
	case g.pos.InsufficientMaterial():
		return "Draw by insufficient material"
	case g.seen[g.pos.Key()] >= 3:
		return "Draw by threefold repetition"
	case g.pos.Halfmove >= 100:
		return "Draw by the fifty-move rule"
	}
	return "Draw by agreement"
}

// Reindex gives the loaded game from source its new place in the file
// after the file changed (f maps the old index to the new one, -1 when the
// game is no longer in the file).
func (m *Manager) Reindex(source string, f func(int) int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	g := m.g
	if g == nil || !g.loaded || g.source != source || g.index < 0 {
		return
	}
	if n := f(g.index); n != g.index {
		g.index = n
		m.emitStateLocked()
	}
}

// ExternalID is the id of the external game shown, or "".
func (m *Manager) ExternalID() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.g == nil || m.g.external == nil {
		return ""
	}
	return m.g.external.ID
}

// ExternalKind is the kind of the external game shown and whether it is
// still live, or "" when the board shows something else.
func (m *Manager) ExternalKind() (id, kind string, live bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.g == nil || m.g.external == nil {
		return "", "", false
	}
	return m.g.external.ID, m.g.external.Kind, m.g.external.Live
}

// FreeFor reports whether a game played elsewhere, of kind (as
// ExternalView.Kind), may take the board by itself without putting away
// anything of the user's: the board shows nothing yet, or a game of that
// kind. A game played or set up here, a game opened from a file, or any
// other game followed keeps the board.
func (m *Manager) FreeFor(kind string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.g == nil || (m.g.external != nil && m.g.external.Kind == kind)
}

// Busy reports whether a local game is being played.
func (m *Manager) Busy() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.g != nil && !m.g.over()
}

// FreezeExternal stops following the external game shown, if any: its
// clocks stop and it is no longer marked live.
func (m *Manager) FreezeExternal(reason string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	g := m.g
	if g == nil || g.external == nil || !g.external.Live {
		return
	}
	if g.extRunning && !g.turnStart.IsZero() {
		c := g.clocks[g.pos.Turn]
		c.RemainingMs = max(0, c.RemainingMs-time.Since(g.turnStart).Milliseconds())
	}
	g.extRunning, g.turnStart = false, time.Time{}
	g.external.Live = false
	if g.result == "*" && g.reason == "" {
		g.reason = reason
	}
	m.emitStateLocked()
}

// CanTakeback reports whether Takeback would do anything now.
func (m *Manager) CanTakeback() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.takebackPliesLocked() > 0
}

// takebackPliesLocked is how many moves a takeback undoes: back to the last
// position where a human was to move.
func (m *Manager) takebackPliesLocked() int {
	g := m.g
	if g == nil || g.over() || len(g.moves) == 0 {
		return 0
	}
	turn := g.pos.Turn
	for n := 1; n <= len(g.moves) && n <= 2; n++ {
		// After undoing n moves, this side is to move.
		side := turn
		if n%2 == 1 {
			side = turn.Other()
		}
		if !g.players[side].isEngine() {
			return n
		}
	}
	return 0
}

// Takeback undoes moves back to the human's last turn: one move in a
// human game, or the human's move and the engine's reply. An engine that
// is thinking is stopped. The clocks keep the time used.
func (m *Manager) Takeback() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := m.takebackPliesLocked()
	if n == 0 {
		return errors.New("there is no move of yours to take back")
	}
	g := m.g
	if g.flag != nil {
		g.flag.Stop()
		g.flag = nil
	}
	// Time spent on the current turn still counts.
	if !g.turnStart.IsZero() {
		c := g.clocks[g.pos.Turn]
		if c.Timed() && c.tc.Kind != "movetime" {
			c.RemainingMs -= time.Since(g.turnStart).Milliseconds()
		}
		g.turnStart = time.Time{}
	}
	if e := g.engines[g.pos.Turn]; e != nil {
		g.ignoreBest[g.pos.Turn]++
		e.Stop()
	}
	g.moves = g.moves[:len(g.moves)-n]
	g.pos = g.start
	g.seen = map[chess.Key]int{g.pos.Key(): 1}
	for _, mv := range g.moves {
		parsed, err := g.pos.ParseUCIMove(mv.UCI)
		if err != nil {
			return err
		}
		g.pos = g.pos.Make(parsed)
		g.seen[g.pos.Key()]++
	}
	m.startTurnLocked()
	return nil
}

// SetHash takes the hash table's size and fullness from in.
func (o *EngineInfo) SetHash(in uci.Info) {
	o.HashMB = in.HashMB
	if in.HasHashfull {
		n := in.Hashfull
		o.Hashfull = &n
	}
}
