// Package epdtest runs an engine on a set of test positions (an EPD suite
// such as Win at Chess) for a fixed time each and checks whether it plays
// the best move (bm) or avoids the bad one (am).
package epdtest

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"board/backend/chess"
	"board/backend/uci"
)

// Engine is the engine tested.
type Engine struct {
	Name    string            `json:"name"`
	Path    string            `json:"path"`
	Args    []string          `json:"args"`
	Options map[string]string `json:"options"`
}

// Position is one test: a position and its solution, as SAN.
type Position struct {
	Index int      `json:"index"` // where it is in the suite, sent back
	ID    string   `json:"id"`
	FEN   string   `json:"fen"`
	BM    []string `json:"bm"`
	AM    []string `json:"am"`
}

// Request is a test run.
type Request struct {
	Key        string     `json:"key"`
	Engine     Engine     `json:"engine"`
	Positions  []Position `json:"positions"`
	MoveTimeMs int        `json:"moveTimeMs"`
	// Engines searching at once (each its own process); 1 by default.
	Concurrency int `json:"concurrency"`
}

// Result is how the engine did on one position.
type Result struct {
	Index   int      `json:"index"`
	ID      string   `json:"id"`
	Move    string   `json:"move,omitempty"` // the engine's move, SAN
	UCI     string   `json:"uci,omitempty"`
	Solved  bool     `json:"solved"`
	FoundMs int64    `json:"foundMs"` // when it settled on the solution for good; -1 if it did not
	Depth   int      `json:"depth"`
	CP      int      `json:"cp"` // from the side to move
	Mate    int      `json:"mate,omitempty"`
	Nodes   int64    `json:"nodes"`
	PV      []string `json:"pv,omitempty"` // SAN, a few moves
	PVUCI   []string `json:"pvUci,omitempty"`
	// The solution moves as UCI (bm; for an am position, the moves to avoid).
	Want  []string `json:"want,omitempty"`
	Error string   `json:"error,omitempty"`
}

// Progress is sent as the "epdtest" event.
type Progress struct {
	Key    string  `json:"key"`
	State  string  `json:"state"` // running, done, stopped, error
	Done   int     `json:"done"`
	Total  int     `json:"total"`
	Solved int     `json:"solved"`
	Result *Result `json:"result,omitempty"` // the position just finished
	Error  string  `json:"error,omitempty"`
}

// Runner runs one test at a time.
type Runner struct {
	emit   func(string, any)
	mu     sync.Mutex
	cancel context.CancelFunc
	key    string
}

func NewRunner(emit func(string, any)) *Runner { return &Runner{emit: emit} }

// Running is the key of the run under way, or "".
func (r *Runner) Running() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.key
}

// Stop ends the run.
func (r *Runner) Stop() {
	r.mu.Lock()
	cancel := r.cancel
	r.cancel, r.key = nil, ""
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// normSAN drops check marks and annotations, and the = of a promotion.
func normSAN(s string) string {
	s = strings.TrimRight(s, "+#!?")
	return strings.ReplaceAll(s, "=", "")
}

// moveSet turns SAN moves into the UCI moves they are in pos.
func moveSet(pos chess.Position, sans []string) (map[string]bool, error) {
	out := map[string]bool{}
	for _, s := range sans {
		want := normSAN(s)
		found := false
		for _, m := range pos.LegalMoves() {
			if normSAN(pos.SAN(m)) == want || m.UCI() == strings.ToLower(s) {
				out[m.UCI()] = true
				found = true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("%s is not a legal move in the position", s)
		}
	}
	return out, nil
}

// Start runs the test in the background, replacing any run under way.
func (r *Runner) Start(req Request) error {
	if req.Engine.Path == "" {
		return errors.New("choose an engine to test")
	}
	if len(req.Positions) == 0 {
		return errors.New("no positions to test")
	}
	if req.MoveTimeMs <= 0 {
		req.MoveTimeMs = 1000
	}
	if req.Concurrency <= 0 {
		req.Concurrency = 1
	}
	req.Concurrency = min(req.Concurrency, len(req.Positions), 32)
	r.Stop()
	ctx, cancel := context.WithCancel(context.Background())
	r.mu.Lock()
	r.cancel, r.key = cancel, req.Key
	r.mu.Unlock()

	go func() {
		total := len(req.Positions)
		jobs := make(chan Position)
		var mu sync.Mutex
		done, solved := 0, 0
		var failure error
		var wg sync.WaitGroup
		for w := 0; w < req.Concurrency; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				t, err := newTester(req)
				if err != nil {
					mu.Lock()
					if failure == nil {
						failure = err
					}
					mu.Unlock()
					cancel()
					return
				}
				defer t.close()
				for p := range jobs {
					res, err := t.test(ctx, p)
					if ctx.Err() != nil {
						return
					}
					if err != nil {
						res = Result{Index: p.Index, ID: p.ID, FoundMs: -1, Error: err.Error()}
						if errors.Is(err, errEngineGone) {
							// Start a fresh engine for the rest.
							t.close()
							if t, err = newTester(req); err != nil {
								mu.Lock()
								failure = err
								mu.Unlock()
								cancel()
								return
							}
						}
					}
					mu.Lock()
					done++
					if res.Solved {
						solved++
					}
					pr := Progress{Key: req.Key, State: "running", Done: done, Total: total, Solved: solved, Result: &res}
					mu.Unlock()
					r.emit("epdtest", pr)
				}
			}()
		}
	feed:
		for _, p := range req.Positions {
			select {
			case jobs <- p:
			case <-ctx.Done():
				break feed
			}
		}
		close(jobs)
		wg.Wait()
		r.mu.Lock()
		mine := r.key == req.Key
		if mine {
			r.key, r.cancel = "", nil
		}
		r.mu.Unlock()
		mu.Lock()
		final := Progress{Key: req.Key, Done: done, Total: total, Solved: solved}
		err := failure
		mu.Unlock()
		switch {
		case err != nil:
			final.State, final.Error = "error", err.Error()
		case ctx.Err() != nil && done < total:
			final.State = "stopped"
		default:
			final.State = "done"
		}
		r.emit("epdtest", final)
	}()
	return nil
}

var errEngineGone = errors.New("the engine stopped unexpectedly")

// tester is one engine process working through positions.
type tester struct {
	req  Request
	eng  *uci.Engine
	mu   sync.Mutex
	info func(uci.Info)
	best chan string
	dead chan struct{}
}

func newTester(req Request) (*tester, error) {
	t := &tester{req: req, best: make(chan string, 4), dead: make(chan struct{})}
	var once sync.Once
	eng, err := uci.Start(req.Engine.Path, req.Engine.Args, uci.Handlers{
		OnInfo: func(in uci.Info) {
			t.mu.Lock()
			f := t.info
			t.mu.Unlock()
			if f != nil {
				f(in)
			}
		},
		OnBestMove: func(m string) {
			select {
			case t.best <- m:
			default:
			}
		},
		OnExit: func() { once.Do(func() { close(t.dead) }) },
	})
	if err != nil {
		return nil, err
	}
	for k, v := range req.Engine.Options {
		if strings.EqualFold(k, "MultiPV") || strings.EqualFold(k, "Ponder") {
			continue
		}
		eng.SetOption(k, v)
	}
	t.eng = eng
	return t, nil
}

func (t *tester) close() {
	if t.eng != nil {
		t.eng.Quit()
	}
}

func (t *tester) test(ctx context.Context, p Position) (Result, error) {
	res := Result{Index: p.Index, ID: p.ID, FoundMs: -1}
	pos, err := chess.ParseFEN(p.FEN)
	if err != nil {
		return res, fmt.Errorf("the position cannot be read: %v", err)
	}
	if len(pos.LegalMoves()) == 0 {
		return res, errors.New("there are no legal moves in the position")
	}
	bm, err := moveSet(pos, p.BM)
	if err != nil {
		return res, err
	}
	am, err := moveSet(pos, p.AM)
	if err != nil {
		return res, err
	}
	for u := range bm {
		res.Want = append(res.Want, u)
	}
	if len(bm) == 0 {
		for u := range am {
			res.Want = append(res.Want, u)
		}
	}
	sort.Strings(res.Want)
	good := func(u string) bool {
		if len(bm) > 0 {
			return bm[u]
		}
		return len(am) > 0 && !am[u]
	}
	if err := t.eng.NewGame(); err != nil {
		return res, errEngineGone
	}
	// Drain a stale bestmove.
	select {
	case <-t.best:
	default:
	}
	var last uci.Info
	start := time.Now()
	t.mu.Lock()
	t.info = func(in uci.Info) {
		if in.MultiPV > 1 || len(in.PV) == 0 {
			return
		}
		t.mu.Lock()
		defer t.mu.Unlock()
		if in.HasScore || len(last.PV) == 0 {
			last = in
		} else {
			last.PV, last.Depth = in.PV, in.Depth
		}
		ms := in.TimeMs
		if ms <= 0 {
			ms = time.Since(start).Milliseconds()
		}
		// When the engine settled on the solution: reset whenever it
		// changes its mind.
		if good(in.PV[0]) {
			if res.FoundMs < 0 {
				res.FoundMs = ms
			}
		} else {
			res.FoundMs = -1
		}
	}
	t.mu.Unlock()
	defer func() {
		t.mu.Lock()
		t.info = nil
		t.mu.Unlock()
	}()
	t.eng.Go("position fen "+pos.FEN(), fmt.Sprintf("go movetime %d", t.req.MoveTimeMs))
	limit := time.Duration(t.req.MoveTimeMs)*time.Millisecond + 10*time.Second
	var move string
	select {
	case move = <-t.best:
	case <-t.dead:
		return res, errEngineGone
	case <-time.After(limit):
		t.eng.Stop()
		select {
		case move = <-t.best:
		case <-time.After(2 * time.Second):
			return res, errEngineGone
		}
	case <-ctx.Done():
		t.eng.Stop()
		select {
		case <-t.best:
		case <-time.After(time.Second):
		}
		return res, ctx.Err()
	}
	t.mu.Lock()
	t.info = nil // nothing more from this search
	in := last
	found := res.FoundMs
	t.mu.Unlock()
	res.UCI = move
	if m, err := pos.ParseUCIMove(move); err == nil {
		res.Move = pos.SAN(m)
	} else {
		res.Move = move
	}
	res.Solved = good(move)
	res.FoundMs = found
	if !res.Solved {
		res.FoundMs = -1
	} else if res.FoundMs < 0 {
		res.FoundMs = int64(t.req.MoveTimeMs)
	}
	res.Depth, res.Nodes = in.Depth, in.Nodes
	if in.IsMate {
		res.Mate = in.Mate
	} else {
		res.CP = in.ScoreCP
	}
	// The line, as SAN.
	pv := pos
	for i, u := range in.PV {
		if i >= 8 {
			break
		}
		m, err := pv.ParseUCIMove(u)
		if err != nil {
			break
		}
		res.PV = append(res.PV, pv.SAN(m))
		res.PVUCI = append(res.PVUCI, m.UCI())
		pv = pv.Make(m)
	}
	return res, nil
}
