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
	*Result
}

// Reviewer runs one analysis at a time.
type Reviewer struct {
	mu     sync.Mutex
	emit   func(string, any)
	cancel context.CancelFunc
	key    string
}

func New(emit func(string, any)) *Reviewer { return &Reviewer{emit: emit} }

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
		res, err := run(ctx, req, start, func(done int) {
			r.emit("review", Progress{Key: req.Key, State: "running", Done: done, Total: len(req.Moves) + 1})
		})
		r.mu.Lock()
		if r.key == req.Key {
			r.key, r.cancel = "", nil
		}
		r.mu.Unlock()
		switch {
		case ctx.Err() != nil:
			// Stopped early: what was analysed so far still counts.
			p := Progress{Key: req.Key, State: "stopped", Done: len(res.Positions), Total: len(req.Moves) + 1}
			if len(res.Positions) >= 2 {
				p.Result = &res
			}
			r.emit("review", p)
		case err != nil:
			r.emit("review", Progress{Key: req.Key, State: "error", Error: err.Error()})
		default:
			r.emit("review", Progress{Key: req.Key, State: "done", Done: len(req.Moves) + 1, Total: len(req.Moves) + 1, Result: &res})
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

func run(ctx context.Context, req Request, start chess.Position, progress func(int)) (Result, error) {
	best := make(chan string, 4)
	var mu sync.Mutex
	var last uci.Info
	dead := make(chan struct{})
	var once sync.Once
	eng, err := uci.Start(req.Engine.Path, req.Engine.Args, uci.Handlers{
		OnInfo: func(in uci.Info) {
			if in.MultiPV > 1 {
				return
			}
			mu.Lock()
			if in.HasScore || len(last.PV) == 0 {
				last = in
			} else if len(in.PV) > 0 {
				last.PV, last.Depth = in.PV, in.Depth
			}
			mu.Unlock()
		},
		OnBestMove: func(m string) {
			select {
			case best <- m:
			default:
			}
		},
		OnExit: func() { once.Do(func() { close(dead) }) },
	})
	if err != nil {
		return Result{}, err
	}
	defer eng.Quit()
	if err := eng.ApplyOptions(req.Engine.Options, "MultiPV"); err != nil {
		return Result{}, err
	}
	if err := eng.NewGame(); err != nil {
		return Result{}, err
	}
	res := Result{Key: req.Key, Engine: req.Engine.Name, Positions: append([]Position(nil), req.Resume...)}
	if len(res.Positions) > 0 {
		progress(len(res.Positions))
	}
	pos := start
	startFEN := start.FEN()
	for ply := 0; ply <= len(req.Moves); ply++ {
		if ply > 0 {
			mv, _ := pos.ParseUCIMove(req.Moves[ply-1])
			pos = pos.Make(mv)
		}
		if ply < len(res.Positions) {
			continue // analysed before the stop
		}
		var p Position
		if len(pos.LegalMoves()) == 0 {
			// Nothing to search: the game is over on the board.
			if pos.InCheck() {
				p.Final = "checkmate"
				p.Mate = 0
				p.CP = 10000
				if pos.Turn == chess.White {
					p.CP = -10000
				}
			} else {
				p.Final = "stalemate"
			}
			res.Positions = append(res.Positions, p)
			progress(ply + 1)
			continue
		}
		mu.Lock()
		last = uci.Info{}
		mu.Unlock()
		cmd := "position fen " + startFEN
		if ply > 0 {
			cmd += " moves " + strings.Join(req.Moves[:ply], " ")
		}
		eng.Go(cmd, fmt.Sprintf("go movetime %d", req.MoveTimeMs))
		limit := time.Duration(req.MoveTimeMs)*time.Millisecond + 10*time.Second
		var bm string
		select {
		case bm = <-best:
		case <-dead:
			return Result{}, errors.New("the engine stopped unexpectedly")
		case <-time.After(limit):
			eng.Stop()
			select {
			case bm = <-best:
			case <-time.After(2 * time.Second):
				return Result{}, errors.New("the engine did not answer")
			}
		case <-ctx.Done():
			eng.Stop()
			// The moves analysed so far are judged as a game that ended there.
			if n := len(res.Positions); n >= 2 {
				judge(&res, start, req.Moves[:n-1])
			}
			return res, ctx.Err()
		}
		mu.Lock()
		in := last
		mu.Unlock()
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
		for i, s := range in.PV {
			if i == 8 {
				break
			}
			mv, err := q.ParseUCIMove(s)
			if err != nil {
				break
			}
			p.PV = append(p.PV, q.SAN(mv))
			q = q.Make(mv)
		}
		res.Positions = append(res.Positions, p)
		progress(ply + 1)
	}
	judge(&res, start, req.Moves)
	return res, nil
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

// judge classifies each move by the winning chances it gave away, and sums
// up accuracy and average centipawn loss per side, as Lichess does.
func judge(res *Result, start chess.Position, moves []string) {
	n := len(moves)
	if len(res.Positions) != n+1 {
		return
	}
	whiteFirst := start.Turn == chess.White
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
		white := (i%2 == 1) == whiteFirst
		before, after := res.Positions[i-1], res.Positions[i]
		mover := 1.0
		s := &sides[0]
		if !white {
			mover = -1
			s = &sides[1]
		}
		// Losses from the mover's side.
		loss := mover * (winningChances(before) - winningChances(after))
		cpBefore := math.Max(-1000, math.Min(1000, float64(before.CP))) * mover
		cpAfter := math.Max(-1000, math.Min(1000, float64(after.CP))) * mover
		cpLoss := math.Max(0, cpBefore-cpAfter)
		winLoss := math.Max(0, mover*(wins[i-1]-wins[i]))
		a := 103.1668*math.Exp(-0.04354*winLoss) - 3.1669 + 1
		a = math.Max(0, math.Min(100, a))
		j := Judgment{Ply: i, Loss: math.Max(0, loss), CPLoss: int(cpLoss), Accuracy: a}
		switch {
		case loss >= 0.3:
			j.Kind, j.Glyph = "blunder", "??"
			s.judgment[2]++
		case loss >= 0.2:
			j.Kind, j.Glyph = "mistake", "?"
			s.judgment[1]++
		case loss >= 0.1:
			j.Kind, j.Glyph = "inaccuracy", "?!"
			s.judgment[0]++
		}
		// The move played was the best one: nothing to suggest.
		if j.Kind != "" && before.Best != "" && before.Best != moves[i-1] {
			j.Best = before.BestS
		} else if j.Kind != "" && before.Best == moves[i-1] {
			j.Kind, j.Glyph = "", ""
		}
		res.Judgments = append(res.Judgments, j)
		s.cpl += cpLoss
		s.accs = append(s.accs, a)
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
