// Package review is the computer analysis of a finished game, as on
// Lichess: an engine evaluates every position, then each move is judged by
// how much it lowered its side's winning chances.
package review

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"board/backend/chess"
	"board/backend/uci"
)

// Engine is the engine that analyses.
type Engine struct {
	Name    string            `json:"name"`
	Path    string            `json:"path"`
	Args    []string          `json:"args"`
	Options map[string]string `json:"options"`
}

// Request is a game to analyse.
type Request struct {
	Key        string   `json:"key"` // chosen by the caller, sent back with progress
	Engine     Engine   `json:"engine"`
	StartFEN   string   `json:"startFen"`
	Moves      []string `json:"moves"` // UCI
	MoveTimeMs int      `json:"moveTimeMs"`
	// Swarm is how many engines work on the game at once, each on its own
	// positions (1 when not set; at most MaxSwarm). Each runs with the
	// engine's own options, Threads included.
	Swarm int `json:"swarm,omitempty"`
	// Resume holds the positions an analysis stopped early got through:
	// the new one starts after them and reports them with its own.
	Resume []Position `json:"resume,omitempty"`
}

// Position is the engine's view of one position: before any move (ply 0)
// and after each move.
type Position struct {
	// Evaluation from White's side: centipawns, or mate in Mate moves
	// (positive: White mates).
	CP    int      `json:"cp"`
	Mate  int      `json:"mate,omitempty"`
	Depth int      `json:"depth"`
	Best  string   `json:"best,omitempty"`    // best move here, UCI
	BestS string   `json:"bestSan,omitempty"` // and as SAN
	PV    []string `json:"pv,omitempty"`      // SAN, a few moves
	Final string   `json:"final,omitempty"`   // checkmate or stalemate on the board
}

// Judgment of a move, as on Lichess.
type Judgment struct {
	Ply      int     `json:"ply"`    // 1 for the first move
	Kind     string  `json:"kind"`   // inaccuracy, mistake, blunder, or ""
	Glyph    string  `json:"glyph"`  // ?!, ?, ??
	Loss     float64 `json:"loss"`   // winning chances lost, 0…2
	CPLoss   int     `json:"cpLoss"` // centipawns lost (capped at 1000)
	Accuracy float64 `json:"accuracy"`
	Best     string  `json:"best,omitempty"` // the better move (SAN), when judged
}

// Side sums up one player's moves.
type Side struct {
	Inaccuracies int     `json:"inaccuracies"`
	Mistakes     int     `json:"mistakes"`
	Blunders     int     `json:"blunders"`
	ACPL         float64 `json:"acpl"`
	Accuracy     float64 `json:"accuracy"`
	Moves        int     `json:"moves"`
}

// Result is a finished analysis.
type Result struct {
	Key       string     `json:"key"`
	Engine    string     `json:"engine"`
	Positions []Position `json:"positions"`
	Judgments []Judgment `json:"judgments"`
	White     Side       `json:"white"`
	Black     Side       `json:"black"`
}

// Progress is sent while the analysis runs.
type Progress struct {
	Key   string `json:"key"`
	State string `json:"state"` // running, done, stopped, error
	Done  int    `json:"done"`
	Total int    `json:"total"`
	Error string `json:"error,omitempty"`
	// Reused: positions of the game that need no search, analysed before
	// with this engine and at least as much time; Searched: how many of the
	// rest have been searched so far.
	Reused   int `json:"reused"`
	Searched int `json:"searched"`
	// While running: the position just analysed, its index (ply; 0 is
	// the start) and the judgments of the moves next to it that both of
	// whose positions are now known, so each move can be shown as soon as
	// it is judged. Positions come in any order when a swarm of engines
	// works on the game. The final Result judges every move the same way.
	Ply           *int       `json:"ply,omitempty"`
	Position      *Position  `json:"position,omitempty"`
	MoveJudgments []Judgment `json:"moveJudgments,omitempty"` // not "judgments": the Result's
	*Result
}

// Reviewer runs one analysis at a time.
type Reviewer struct {
	mu     sync.Mutex
	emit   func(string, any)
	cancel context.CancelFunc
	key    string
	cache  *Cache
}

func New(emit func(string, any)) *Reviewer { return &Reviewer{emit: emit, cache: newCache()} }

// UseCacheFile keeps the positions analysed in file, across runs of the
// app; without it they are kept while it runs.
func (r *Reviewer) UseCacheFile(file string) { r.cache.Load(file) }

// SearchFENs are the positions of a game that its analysis searches: all
// but one that ends it on the board. None for a game with no moves.
func SearchFENs(start chess.Position, moves []chess.Move) []string {
	if len(moves) == 0 {
		return nil
	}
	var fens []string
	pos := start
	for i := 0; i <= len(moves); i++ {
		if i > 0 {
			pos = pos.Make(moves[i-1])
		}
		if len(pos.LegalMoves()) > 0 {
			fens = append(fens, pos.FEN())
		}
	}
	return fens
}

// AnalysedBy is the name of an engine that has analysed every one of the
// positions (SearchFENs of a game), with any time a move, or "" if none
// has: the game's computer analysis is complete with it.
func (r *Reviewer) AnalysedBy(fens []string) string { return r.cache.Covered(fens) }

// Running is the key of the analysis running, or "".
func (r *Reviewer) Running() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.key
}

// Start analyses a game in the background, replacing any analysis running.
func (r *Reviewer) Start(req Request) error {
	if req.Engine.Path == "" {
		return errors.New("choose an analysis engine in Settings → Analysis")
	}
	if len(req.Moves) == 0 {
		return errors.New("the game has no moves to analyse")
	}
	if req.MoveTimeMs <= 0 {
		req.MoveTimeMs = 500
	}
	if len(req.Resume) > len(req.Moves) {
		req.Resume = nil // nothing left to do: analyse it again
	}
	start, err := chess.ParseFEN(req.StartFEN)
	if err != nil {
		return err
	}
	// Check the moves before starting.
	pos := start
	for _, m := range req.Moves {
		mv, err := pos.ParseUCIMove(m)
		if err != nil {
			return fmt.Errorf("move %s: %w", m, err)
		}
		pos = pos.Make(mv)
	}
	r.Stop()
	ctx, cancel := context.WithCancel(context.Background())
	r.mu.Lock()
	r.cancel, r.key = cancel, req.Key
	r.mu.Unlock()
	go func() {
		var reused, searched int
		res, err := run(ctx, req, start, r.cache, func(done, re, se, ply int, p *Position, js []Judgment) {
			reused, searched = re, se
			ev := Progress{Key: req.Key, State: "running", Done: done, Total: len(req.Moves) + 1, Reused: re, Searched: se, Position: p, MoveJudgments: js}
			if p != nil {
				ev.Ply = &ply
			}
			r.emit("review", ev)
		})
		r.cache.Save() // what was searched, even if it stopped

		r.mu.Lock()
		if r.key == req.Key {
			r.key, r.cancel = "", nil
		}
		r.mu.Unlock()
		switch {
		case ctx.Err() != nil:
			// Stopped early: what was analysed so far still counts.
			p := Progress{Key: req.Key, State: "stopped", Done: len(res.Positions), Total: len(req.Moves) + 1, Reused: reused, Searched: searched}
			if len(res.Positions) >= 2 {
				p.Result = &res
			}
			r.emit("review", p)
		case err != nil:
			r.emit("review", Progress{Key: req.Key, State: "error", Error: err.Error()})
		default:
			r.emit("review", Progress{Key: req.Key, State: "done", Done: len(req.Moves) + 1, Total: len(req.Moves) + 1, Reused: reused, Searched: searched, Result: &res})
		}
	}()
	return nil
}

// Stop ends the analysis running.
func (r *Reviewer) Stop() {
	r.mu.Lock()
	cancel := r.cancel
	r.cancel, r.key = nil, ""
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// progress reports how many positions are done and, for each new one, its
// index (ply) and the position, with the judgments of the moves it lets be
// judged: the one leading to it and the one leaving it, whichever have both
// their positions now. With a swarm, positions come in any order. reused is
// how many of the game's positions need no search (kept from a stopped
// analysis or in the cache); searched, how many have been searched so far.
type progressFunc func(done, reused, searched, ply int, p *Position, js []Judgment)

// MaxSwarm is the most engines one analysis runs at once.
const MaxSwarm = 32

func run(ctx context.Context, req Request, start chess.Position, cache *Cache, progress progressFunc) (Result, error) {
	n := len(req.Moves) + 1
	// The positions of the game, and which are known already.
	fens := make([]string, 0, n)
	positions := make([]chess.Position, 0, n)
	pos := start
	for ply := 0; ply < n; ply++ {
		if ply > 0 {
			mv, _ := pos.ParseUCIMove(req.Moves[ply-1])
			pos = pos.Make(mv)
		}
		positions = append(positions, pos)
		fens = append(fens, pos.FEN())
	}
	ek := engineKey(req.Engine)
	got := make([]*Position, n)
	var reused, searched, done int
	var todo []int // to search, in order
	for ply := range positions {
		switch {
		case ply < len(req.Resume):
			p := req.Resume[ply]
			got[ply] = &p
			reused++
			done++
		case len(positions[ply].LegalMoves()) == 0:
			// Nothing to search: the game is over on the board. Reported
			// in order with the rest, below.
		default:
			if p, ok := cache.Get(ek, fens[ply], req.MoveTimeMs); ok {
				got[ply] = &p
				reused++
			} else {
				todo = append(todo, ply)
			}
		}
	}
	if len(req.Resume) > 0 {
		progress(done, reused, searched, -1, nil, nil)
	}
	judgeAt := func(ply int) (Judgment, bool) { // the move leading to ply
		if ply < 1 || ply >= n || got[ply-1] == nil || got[ply] == nil {
			return Judgment{}, false
		}
		j, _ := judgeMove(*got[ply-1], *got[ply], req.Moves[ply-1], ply, whiteMoves(start, ply))
		return j, true
	}
	// A position now known: kept, and reported.
	set := func(ply int, p Position) {
		got[ply] = &p
		done++
		var js []Judgment
		for _, k := range []int{ply, ply + 1} {
			if j, ok := judgeAt(k); ok {
				js = append(js, j)
			}
		}
		progress(done, reused, searched, ply, &p, js)
	}
	// What needs no engine first, in order: what was known, and the end of
	// the game on the board.
	for ply := len(req.Resume); ply < n; ply++ {
		pos := positions[ply]
		switch {
		case got[ply] != nil:
			p := *got[ply]
			got[ply] = nil
			set(ply, p)
		case len(pos.LegalMoves()) == 0:
			var p Position
			if pos.InCheck() {
				p.Final = "checkmate"
				p.CP = 10000
				if pos.Turn == chess.White {
					p.CP = -10000
				}
			} else {
				p.Final = "stalemate"
			}
			set(ply, p)
		}
	}

	// The rest, by a swarm of engines: each takes the next position not
	// yet taken, so what is done stays close to a run from the start.
	finish := func() Result {
		res := Result{Key: req.Key, Engine: req.Engine.Name}
		for _, p := range got {
			if p == nil {
				break // stopped: the moves up to the first gap are judged
			}
			res.Positions = append(res.Positions, *p)
		}
		if k := len(res.Positions); k == n {
			judge(&res, start, req.Moves)
		} else if k >= 2 {
			judge(&res, start, req.Moves[:k-1])
		}
		return res
	}
	if len(todo) == 0 {
		return finish(), ctx.Err()
	}
	swarm := req.Swarm
	if swarm < 1 {
		swarm = 1
	}
	if swarm > MaxSwarm {
		swarm = MaxSwarm
	}
	if swarm > len(todo) {
		swarm = len(todo)
	}
	wctx, cancel := context.WithCancel(ctx)
	defer cancel()
	type found struct {
		ply int
		p   Position
		err error
	}
	queue := make(chan int, len(todo))
	for _, ply := range todo {
		queue <- ply
	}
	close(queue)
	results := make(chan found)
	var wg sync.WaitGroup
	startFEN := start.FEN()
	for w := 0; w < swarm; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s, err := startSearcher(req.Engine)
			if err != nil {
				select {
				case results <- found{err: err}:
				case <-wctx.Done():
				}
				return
			}
			defer s.quit()
			for ply := range queue {
				if wctx.Err() != nil {
					return
				}
				p, err := s.search(wctx, startFEN, req.Moves[:ply], positions[ply], req.MoveTimeMs)
				if err != nil && wctx.Err() != nil {
					return
				}
				select {
				case results <- found{ply: ply, p: p, err: err}:
				case <-wctx.Done():
					return
				}
				if err != nil {
					return
				}
			}
		}()
	}
	go func() { wg.Wait(); close(results) }()
	var failed error
	for f := range results {
		if f.err != nil {
			if failed == nil {
				failed = f.err
			}
			cancel()
			continue
		}
		cache.Put(ek, req.Engine.Name, fens[f.ply], req.MoveTimeMs, f.p)
		searched++
		set(f.ply, f.p)
	}
	if ctx.Err() != nil {
		return finish(), ctx.Err()
	}
	if failed != nil {
		return Result{}, failed
	}
	return finish(), nil
}

// searcher is one engine of an analysis, searching one position at a time.
type searcher struct {
	eng  *uci.Engine
	best chan string
	mu   sync.Mutex
	last uci.Info
	dead chan struct{}
}

func startSearcher(e Engine) (*searcher, error) {
	s := &searcher{best: make(chan string, 4), dead: make(chan struct{})}
	var once sync.Once
	eng, err := uci.Start(e.Path, e.Args, uci.Handlers{
		OnInfo: func(in uci.Info) {
			if in.MultiPV > 1 {
				return
			}
			s.mu.Lock()
			if in.HasScore || len(s.last.PV) == 0 {
				s.last = in
			} else if len(in.PV) > 0 {
				s.last.PV, s.last.Depth = in.PV, in.Depth
			}
			s.mu.Unlock()
		},
		OnBestMove: func(m string) {
			select {
			case s.best <- m:
			default:
			}
		},
		OnExit: func() { once.Do(func() { close(s.dead) }) },
	})
	if err != nil {
		return nil, err
	}
	s.eng = eng
	if err := eng.ApplyOptions(e.Options, "MultiPV"); err != nil {
		eng.Quit()
		return nil, err
	}
	if err := eng.NewGame(); err != nil {
		eng.Quit()
		return nil, err
	}
	return s, nil
}

func (s *searcher) quit() { s.eng.Quit() }

// search analyses the position after moves from startFEN.
func (s *searcher) search(ctx context.Context, startFEN string, moves []string, pos chess.Position, moveTimeMs int) (Position, error) {
	var p Position
	s.mu.Lock()
	s.last = uci.Info{}
	s.mu.Unlock()
	cmd := "position fen " + startFEN
	if len(moves) > 0 {
		cmd += " moves " + strings.Join(moves, " ")
	}
	s.eng.Go(cmd, fmt.Sprintf("go movetime %d", moveTimeMs))
	limit := time.Duration(moveTimeMs)*time.Millisecond + 10*time.Second
	var bm string
	select {
	case bm = <-s.best:
	case <-s.dead:
		return p, errors.New("the engine stopped unexpectedly")
	case <-time.After(limit):
		s.eng.Stop()
		select {
		case bm = <-s.best:
		case <-time.After(2 * time.Second):
			return p, errors.New("the engine did not answer")
		}
	case <-ctx.Done():
		s.eng.Stop()
		return p, ctx.Err()
	}
	s.mu.Lock()
	in := s.last
	s.mu.Unlock()
	if in.HasScore {
		sign := 1
		if pos.Turn == chess.Black {
			sign = -1
		}
		if in.IsMate {
			p.Mate = in.Mate * sign
			p.CP = sign * (10000 - abs(in.Mate))
			if in.Mate < 0 {
				p.CP = -p.CP
			}
		} else {
			p.CP = in.ScoreCP * sign
		}
	}
	p.Depth = in.Depth
	if mv, err := pos.ParseUCIMove(bm); err == nil {
		p.Best, p.BestS = mv.UCI(), pos.SAN(mv)
	}
	q := pos
	for i, m := range in.PV {
		if i == 8 {
			break
		}
		mv, err := q.ParseUCIMove(m)
		if err != nil {
			break
		}
		p.PV = append(p.PV, q.SAN(mv))
		q = q.Make(mv)
	}
	return p, nil
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// winningChances maps an evaluation (White's side) to −1…1, Lichess's
// curve.
func winningChances(p Position) float64 {
	cp := float64(p.CP)
	if p.Mate != 0 || p.Final == "checkmate" {
		if p.CP > 0 {
			return 1
		}
		return -1
	}
	cp = math.Max(-1000, math.Min(1000, cp))
	return 2/(1+math.Exp(-0.00368208*cp)) - 1
}

func winPercent(p Position) float64 { return 50 + 50*winningChances(p) }

// judgeMove judges the move (UCI) played at ply, from the positions before
// and after it: it needs only those two, so a move can be judged as soon as
// the position after it is analysed.
// white: White made the move. Also returns the centipawns lost, unrounded.
func judgeMove(before, after Position, move string, ply int, white bool) (Judgment, float64) {
	mover := 1.0
	if !white {
		mover = -1
	}
	// Losses from the mover's side.
	loss := mover * (winningChances(before) - winningChances(after))
	cpBefore := math.Max(-1000, math.Min(1000, float64(before.CP))) * mover
	cpAfter := math.Max(-1000, math.Min(1000, float64(after.CP))) * mover
	cpLoss := math.Max(0, cpBefore-cpAfter)
	winLoss := math.Max(0, mover*(winPercent(before)-winPercent(after)))
	a := 103.1668*math.Exp(-0.04354*winLoss) - 3.1669 + 1
	a = math.Max(0, math.Min(100, a))
	j := Judgment{Ply: ply, Loss: math.Max(0, loss), CPLoss: int(cpLoss), Accuracy: a}
	switch {
	case loss >= 0.3:
		j.Kind, j.Glyph = "blunder", "??"
	case loss >= 0.2:
		j.Kind, j.Glyph = "mistake", "?"
	case loss >= 0.1:
		j.Kind, j.Glyph = "inaccuracy", "?!"
	}
	// The move played was the best one: nothing to suggest.
	if j.Kind != "" && before.Best != "" && before.Best != move {
		j.Best = before.BestS
	} else if j.Kind != "" && before.Best == move {
		j.Kind, j.Glyph = "", ""
	}
	return j, cpLoss
}

// whiteMoves: White makes the move at ply (1 for the first move).
func whiteMoves(start chess.Position, ply int) bool {
	return (ply%2 == 1) == (start.Turn == chess.White)
}

// judge classifies each move by the winning chances it gave away, and sums
// up accuracy and average centipawn loss per side, as Lichess does.
func judge(res *Result, start chess.Position, moves []string) {
	n := len(moves)
	if len(res.Positions) != n+1 {
		return
	}
	wins := make([]float64, n+1)
	for i, p := range res.Positions {
		wins[i] = winPercent(p)
	}
	type acc struct {
		cpl      float64
		accs     []float64
		weights  []float64
		judgment [3]int
	}
	var sides [2]acc // 0 white, 1 black
	// Volatility weights: the standard deviation of win% in a window.
	window := int(math.Max(2, math.Min(8, float64(n)/10)))
	weightAt := func(i int) float64 {
		lo := i - window
		if lo < 0 {
			lo = 0
		}
		hi := lo + window
		if hi > n {
			hi = n
			if hi-window >= 0 {
				lo = hi - window
			}
		}
		var sum, sq float64
		cnt := float64(hi - lo + 1)
		for j := lo; j <= hi; j++ {
			sum += wins[j]
		}
		mean := sum / cnt
		for j := lo; j <= hi; j++ {
			sq += (wins[j] - mean) * (wins[j] - mean)
		}
		return math.Max(0.5, math.Min(12, math.Sqrt(sq/cnt)))
	}
	for i := 1; i <= n; i++ {
		white := whiteMoves(start, i)
		s := &sides[0]
		if !white {
			s = &sides[1]
		}
		j, cpLoss := judgeMove(res.Positions[i-1], res.Positions[i], moves[i-1], i, white)
		switch j.Kind {
		case "blunder":
			s.judgment[2]++
		case "mistake":
			s.judgment[1]++
		case "inaccuracy":
			s.judgment[0]++
		}
		res.Judgments = append(res.Judgments, j)
		s.cpl += cpLoss
		s.accs = append(s.accs, j.Accuracy)
		s.weights = append(s.weights, weightAt(i))
	}
	for k, s := range sides {
		out := Side{Inaccuracies: s.judgment[0], Mistakes: s.judgment[1], Blunders: s.judgment[2], Moves: len(s.accs)}
		if len(s.accs) > 0 {
			out.ACPL = s.cpl / float64(len(s.accs))
			var wsum, w, harm float64
			for i, a := range s.accs {
				wsum += a * s.weights[i]
				w += s.weights[i]
				harm += 1 / math.Max(a, 1)
			}
			weighted := wsum / w
			harmonic := float64(len(s.accs)) / harm
			out.Accuracy = (weighted + harmonic) / 2
		}
		if k == 0 {
			res.White = out
		} else {
			res.Black = out
		}
	}
}
