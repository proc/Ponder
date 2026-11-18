// Package analysis runs an engine of the user's choice on whatever position
// the board is showing, in infinite mode, and reports its best lines.
package analysis

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"board/backend/chess"
	"board/backend/uci"
)

// Config chooses the engine and how many lines (MultiPV) it reports.
type Config struct {
	Name    string            `json:"name"`
	Path    string            `json:"path"`
	Args    []string          `json:"args"`
	Options map[string]string `json:"options"`
	Lines   int               `json:"lines"`
}

func (c Config) key() string {
	opts := make([]string, 0, len(c.Options))
	for k, v := range c.Options {
		opts = append(opts, k+"="+v)
	}
	sort.Strings(opts)
	return fmt.Sprintf("%s|%q|%v|%d", c.Path, c.Args, opts, c.Lines)
}

// Line is one of the engine's candidate lines. Scores are from White's
// point of view.
type Line struct {
	MultiPV int  `json:"multipv"`
	Depth   int  `json:"depth"`
	CP      int  `json:"cp"`
	IsMate  bool `json:"isMate"`
	Mate    int  `json:"mate"`
	// WDL: the engine's win/draw/loss chances in thousandths, White's
	// first; absent when the engine does not report them.
	WDL *[3]int  `json:"wdl,omitempty"`
	SAN []string `json:"san"`
	UCI []string `json:"uci"`
}

// Update is sent to the UI as the "analysis" event.
type Update struct {
	FEN     string `json:"fen"`
	Engine  string `json:"engine"`
	State   string `json:"state"` // "running", "idle", "over" (no legal moves), "error"
	Message string `json:"message,omitempty"`
	Depth   int    `json:"depth"`
	Nodes   int64  `json:"nodes"`
	NPS     int64  `json:"nps"`
	TimeMs  int64  `json:"timeMs"`
	// Hashfull: how full the hash table is, in thousandths, when the
	// engine says; HashMB: its size.
	Hashfull *int   `json:"hashfull,omitempty"`
	HashMB   int    `json:"hashMB,omitempty"`
	Lines    []Line `json:"lines"`
}

const (
	emitEvery = 120 * time.Millisecond
	maxPV     = 24
)

// How long an engine may take to answer "stop" before it is considered
// stuck and restarted. Until it answers, no new search is sent: an engine
// given a position while still searching can hang. (A variable for tests.)
var stopTimeout = 10 * time.Second

// Analyzer owns at most one analysis engine. Its methods are safe for
// concurrent use.
type Analyzer struct {
	mu   sync.Mutex
	emit func(event string, data any)

	eng   *uci.Engine
	cfg   Config
	gen   int // bumped whenever the engine changes; stale callbacks are ignored
	multi bool

	searching bool
	stopping  bool    // stop sent, waiting for bestmove
	pending   *string // position to search once the current search has stopped
	fen       string
	pos       chess.Position
	lines     map[int]Line
	upd       Update
	lastEmit  time.Time
	flush     *time.Timer
	stopTimer *time.Timer
}

func New(emit func(event string, data any)) *Analyzer {
	return &Analyzer{emit: emit}
}

// Start launches the analysis engine, or keeps the running one if the
// configuration is unchanged.
func (a *Analyzer) Start(cfg Config) error {
	if cfg.Path == "" {
		return errors.New("no analysis engine chosen")
	}
	if cfg.Lines < 1 {
		cfg.Lines = 1
	}
	if cfg.Lines > 10 {
		cfg.Lines = 10
	}
	a.mu.Lock()
	if a.eng != nil && a.cfg.key() == cfg.key() {
		a.mu.Unlock()
		return nil
	}
	a.stopLocked()
	a.gen++
	gen := a.gen
	a.mu.Unlock()

	eng, err := uci.Start(cfg.Path, cfg.Args, uci.Handlers{
		OnInfo:     func(in uci.Info) { a.onInfo(gen, in) },
		OnBestMove: func(string) { a.onBestMove(gen) },
		OnExit:     func() { a.onExit(gen) },
	})
	if err != nil {
		return fmt.Errorf("analysis engine: %w", err)
	}
	multi := false
	for _, o := range eng.Options {
		if strings.EqualFold(o.Name, "MultiPV") {
			multi = true
		}
	}
	if err := eng.ApplyOptions(uci.WithWDL(eng.Options, cfg.Options), "MultiPV"); err != nil {
		eng.Quit()
		return fmt.Errorf("analysis engine: %w", err)
	}
	if multi {
		eng.SetOption("MultiPV", fmt.Sprint(cfg.Lines))
	}
	if err := eng.IsReady(); err != nil {
		eng.Quit()
		return fmt.Errorf("analysis engine: %w", err)
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	if a.gen != gen { // stopped or restarted meanwhile
		eng.Quit()
		return nil
	}
	if cfg.Name == "" {
		cfg.Name = eng.Name
	}
	a.eng, a.cfg, a.multi = eng, cfg, multi
	a.searching, a.stopping, a.pending, a.fen = false, false, nil, ""
	return nil
}

// SetPosition analyses the position in fen, interrupting any other search.
// An empty fen pauses the analysis.
func (a *Analyzer) SetPosition(fen string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.eng == nil {
		return errors.New("analysis is not running")
	}
	if fen == "" {
		a.pending = nil
		a.halt()
		a.fen = ""
		a.send(Update{Engine: a.cfg.Name, State: "idle", Lines: []Line{}})
		return nil
	}
	pos, err := chess.ParseFEN(fen)
	if err != nil {
		return err
	}
	fen = pos.FEN()
	if a.searching && !a.stopping && fen == a.fen {
		// Already on it; send what there is, since the caller may have
		// cleared its copy.
		a.emitNow()
		return nil
	}
	if len(pos.LegalMoves()) == 0 {
		a.pending = nil
		a.halt()
		a.fen = fen
		msg := "Stalemate"
		if pos.InCheck() {
			msg = "Checkmate"
		}
		a.send(Update{FEN: fen, Engine: a.cfg.Name, State: "over", Message: msg, Lines: []Line{}})
		return nil
	}
	if a.searching {
		a.pending = &fen
		a.halt()
		return nil
	}
	a.startLocked(fen, pos)
	return nil
}

// Stop ends the analysis and closes the engine.
func (a *Analyzer) Stop() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.stopLocked()
	a.gen++
}

func (a *Analyzer) stopLocked() {
	if a.flush != nil {
		a.flush.Stop()
	}
	if a.stopTimer != nil {
		a.stopTimer.Stop()
	}
	if a.eng != nil {
		a.eng.Quit()
		a.eng = nil
	}
	a.searching, a.stopping, a.pending, a.fen = false, false, nil, ""
}

// halt asks the engine to end its search; onBestMove continues from there,
// once the engine has sent bestmove.
func (a *Analyzer) halt() {
	if !a.searching || a.stopping {
		return
	}
	a.stopping = true
	a.eng.Stop()
	gen := a.gen
	a.stopTimer = time.AfterFunc(stopTimeout, func() { a.stuck(gen) })
}

// stuck handles an engine that did not answer "stop": it is killed and a
// fresh one started, which then takes the latest position.
func (a *Analyzer) stuck(gen int) {
	a.mu.Lock()
	if gen != a.gen || !a.stopping || a.eng == nil {
		a.mu.Unlock()
		return
	}
	cfg, eng := a.cfg, a.eng
	next := a.pending
	a.eng = nil
	a.gen++
	a.searching, a.stopping, a.pending, a.fen = false, false, nil, ""
	a.send(Update{Engine: cfg.Name, State: "error", Message: "The engine did not stop when asked; restarting it", Lines: []Line{}})
	a.mu.Unlock()
	eng.Kill()
	go func() {
		if err := a.Start(cfg); err != nil {
			a.mu.Lock()
			a.send(Update{Engine: cfg.Name, State: "error", Message: err.Error(), Lines: []Line{}})
			a.mu.Unlock()
			return
		}
		if next != nil {
			a.SetPosition(*next)
		}
	}()
}

func (a *Analyzer) startLocked(fen string, pos chess.Position) {
	a.fen, a.pos = fen, pos
	a.lines = map[int]Line{}
	a.upd = Update{FEN: fen, Engine: a.cfg.Name, State: "running", Lines: []Line{}}
	a.searching, a.stopping = true, false
	a.eng.Go("position fen "+fen, "go infinite")
	a.send(a.upd)
}

func (a *Analyzer) onBestMove(gen int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	// Without an outstanding search this bestmove is stray; ignore it.
	if gen != a.gen || !a.searching {
		return
	}
	if a.stopTimer != nil {
		a.stopTimer.Stop()
	}
	a.searching, a.stopping = false, false
	if a.pending != nil {
		fen := *a.pending
		a.pending = nil
		pos, _ := chess.ParseFEN(fen)
		a.startLocked(fen, pos)
	}
}

func (a *Analyzer) onExit(gen int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if gen != a.gen {
		return
	}
	a.eng = nil
	a.searching, a.stopping, a.pending = false, false, nil
	a.send(Update{FEN: a.fen, Engine: a.cfg.Name, State: "error", Message: "The analysis engine stopped", Lines: []Line{}})
}

func (a *Analyzer) onInfo(gen int, in uci.Info) {
	a.mu.Lock()
	defer a.mu.Unlock()
	// Ignore output from a search that is being stopped: it is for the old position.
	if gen != a.gen || !a.searching || a.stopping || len(in.PV) == 0 || in.MultiPV > a.cfg.Lines {
		return
	}
	line := Line{MultiPV: in.MultiPV, Depth: in.Depth, CP: in.ScoreCP, IsMate: in.IsMate, Mate: in.Mate}
	if a.pos.Turn == chess.Black { // engines score from the side to move
		line.CP, line.Mate = -line.CP, -line.Mate
	}
	if in.HasWDL {
		w := in.WDL
		if a.pos.Turn == chess.Black {
			w[0], w[2] = w[2], w[0]
		}
		line.WDL = &w
	}
	p := a.pos
	for i, s := range in.PV {
		if i == maxPV {
			break
		}
		mv, err := p.ParseUCIMove(s)
		if err != nil {
			break
		}
		line.SAN = append(line.SAN, p.SAN(mv))
		line.UCI = append(line.UCI, mv.UCI())
		p = p.Make(mv)
	}
	if len(line.SAN) == 0 {
		return
	}
	a.lines[line.MultiPV] = line
	if line.MultiPV == 1 {
		a.upd.Depth = in.Depth
	}
	if in.Nodes > 0 {
		a.upd.Nodes = in.Nodes
	}
	if in.NPS > 0 {
		a.upd.NPS = in.NPS
	}
	if in.TimeMs > 0 {
		a.upd.TimeMs = in.TimeMs
	}
	if in.HasHashfull {
		n := in.Hashfull
		a.upd.Hashfull = &n
	}
	a.upd.HashMB = in.HashMB
	a.emitLines()
}

// emitLines sends the current lines, at most every emitEvery; the last
// change always gets through.
func (a *Analyzer) emitLines() {
	if wait := emitEvery - time.Since(a.lastEmit); wait > 0 {
		if a.flush == nil || !a.flush.Reset(wait) {
			gen := a.gen
			a.flush = time.AfterFunc(wait, func() {
				a.mu.Lock()
				defer a.mu.Unlock()
				if gen == a.gen && a.searching && !a.stopping {
					a.emitNow()
				}
			})
		}
		return
	}
	a.emitNow()
}

func (a *Analyzer) emitNow() {
	lines := make([]Line, 0, len(a.lines))
	for _, l := range a.lines {
		lines = append(lines, l)
	}
	sort.Slice(lines, func(i, j int) bool { return lines[i].MultiPV < lines[j].MultiPV })
	u := a.upd
	u.Lines = lines
	a.send(u)
}

func (a *Analyzer) send(u Update) {
	a.lastEmit = time.Now()
	a.emit("analysis", u)
}
