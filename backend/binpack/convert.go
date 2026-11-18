package binpack

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"board/backend/chess"
	"board/backend/pgn"
	"board/backend/uci"
)

// Engine scores positions when the PGN's own evaluations are not used.
type Engine struct {
	Name    string            `json:"name"`
	Path    string            `json:"path"`
	Args    []string          `json:"args"`
	Options map[string]string `json:"options"`
}

// Request is one conversion.
type Request struct {
	Key  string `json:"key"`
	From string `json:"from"` // the PGN file
	To   string `json:"to"`   // the binpack written
	// Scores: "pgn" reads them from the games' comments ([%eval 0.25] as
	// Lichess writes, or "+0.25/18" as engines in tournaments do);
	// "engine" has Engine search each position.
	Scores string `json:"scores"`
	// Missing is what a position without an evaluation in the PGN gets:
	// "skip" leaves it out, "zero" scores it 0.
	Missing string `json:"missing"`
	// PawnValue is the score of one pawn in the file: 208 is Stockfish's
	// internal unit, which nnue-pytorch expects; 100 keeps centipawns.
	PawnValue int `json:"pawnValue"`
	// SkipPlies leaves out the first plies of every game (the opening).
	SkipPlies int `json:"skipPlies"`
	// SkipNoisy leaves out positions in check and those whose move captures.
	SkipNoisy bool `json:"skipNoisy"`
	// Engine scoring: Depth or Nodes per position (Depth when both are
	// set), Concurrency engines at once.
	Engine      Engine `json:"engine"`
	Depth       int    `json:"depth"`
	Nodes       int64  `json:"nodes"`
	Concurrency int    `json:"concurrency"`
}

// Progress is sent as the "binpack" event.
type Progress struct {
	Key   string `json:"key"`
	State string `json:"state"` // running, done, stopped, error
	// Read and Size: bytes of the PGN read so far and in all.
	Read int64 `json:"read"`
	Size int64 `json:"size"`
	Stats
	Name  string `json:"name"` // the binpack's file name
	Error string `json:"error,omitempty"`
}

// Stats counts what a conversion did.
type Stats struct {
	Games      int   `json:"games"`      // games written from
	Unfinished int   `json:"unfinished"` // games left out: no result
	Broken     int   `json:"broken"`     // games with an illegal move (written up to it)
	Positions  int64 `json:"positions"`  // entries written
	Unscored   int64 `json:"unscored"`   // positions left out for want of a score
	Bytes      int64 `json:"bytes"`      // the binpack's size
}

// Runner runs one conversion at a time.
type Runner struct {
	emit   func(string, any)
	mu     sync.Mutex
	cancel context.CancelFunc
	key    string
}

func NewRunner(emit func(string, any)) *Runner { return &Runner{emit: emit} }

// Running is the key of the conversion under way, or "".
func (r *Runner) Running() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.key
}

// Stop ends the conversion; what was written stays a valid binpack.
func (r *Runner) Stop() {
	r.mu.Lock()
	cancel := r.cancel
	r.cancel, r.key = nil, ""
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Start checks the request and runs it in the background.
func (r *Runner) Start(req Request) error {
	if req.From == "" || req.To == "" {
		return errors.New("choose a PGN file and where to write the binpack")
	}
	if filepath.Clean(req.From) == filepath.Clean(req.To) {
		return errors.New("the binpack would overwrite the PGN file")
	}
	if req.PawnValue <= 0 {
		req.PawnValue = 208
	}
	switch req.Scores {
	case "pgn":
	case "engine":
		if req.Engine.Path == "" {
			return errors.New("choose an engine to score the positions")
		}
		if req.Depth <= 0 && req.Nodes <= 0 {
			req.Depth = 8
		}
		if req.Concurrency < 1 {
			req.Concurrency = 1
		}
		if req.Concurrency > 64 {
			req.Concurrency = 64
		}
	default:
		return fmt.Errorf("unknown score source %q", req.Scores)
	}
	if _, err := os.Stat(req.From); err != nil {
		return err
	}
	r.mu.Lock()
	if r.cancel != nil {
		r.mu.Unlock()
		return errors.New("a conversion is already running")
	}
	ctx, cancel := context.WithCancel(context.Background())
	r.cancel, r.key = cancel, req.Key
	r.mu.Unlock()
	go func() {
		p := Progress{Key: req.Key, Name: filepath.Base(req.To)}
		var last time.Time
		report := func(force bool) {
			if force || time.Since(last) >= 200*time.Millisecond {
				last = time.Now()
				r.emit("binpack", p)
			}
		}
		p.State = "running"
		report(true)
		err := Convert(ctx, req, func(read, size int64, st Stats) {
			p.Read, p.Size, p.Stats = read, size, st
			report(false)
		})
		switch {
		case ctx.Err() != nil:
			p.State = "stopped"
		case err != nil:
			p.State, p.Error = "error", err.Error()
		default:
			p.State = "done"
		}
		if info, serr := os.Stat(req.To); serr == nil {
			p.Bytes = info.Size()
		}
		r.mu.Lock()
		if r.key == req.Key {
			r.cancel, r.key = nil, ""
		}
		r.mu.Unlock()
		cancel()
		report(true)
	}()
	return nil
}

// Convert writes the positions of every finished game in req.From to
// req.To. progress gets the PGN bytes read, its size and the counts.
// When ctx ends, what was written so far is closed as a valid file.
func Convert(ctx context.Context, req Request, progress func(read, size int64, st Stats)) (err error) {
	out, err := os.Create(req.To)
	if err != nil {
		return err
	}
	bw := bufio.NewWriterSize(out, 1<<20)
	w := NewWriter(bw)
	var st Stats
	var read, size int64
	defer func() {
		if cerr := w.Close(); err == nil {
			err = cerr
		}
		if ferr := bw.Flush(); err == nil {
			err = ferr
		}
		if cerr := out.Close(); err == nil {
			err = cerr
		}
	}()

	var pool *enginePool
	if req.Scores == "engine" {
		pool, err = newEnginePool(req)
		if err != nil {
			return err
		}
		defer pool.close()
	}

	err = pgn.Each(req.From, func(done, total int64) { read, size = done, total }, func(g pgn.Commented) error {
		if ctx.Err() != nil {
			return pgn.ErrStop
		}
		if gameResult(&g.Game) == nil {
			st.Unfinished++
			return nil
		}
		entries, broken, unscored, err := gameEntries(ctx, req, g, pool)
		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			return pgn.ErrStop // a game cut short by stopping is left out
		}
		st.Games++
		if broken {
			st.Broken++
		}
		st.Unscored += unscored
		for _, e := range entries {
			if err := w.Add(e); err != nil {
				return err
			}
		}
		st.Positions = w.Entries()
		progress(read, size, st)
		return nil
	})
	progress(read, size, st)
	if ctx.Err() != nil {
		return nil
	}
	return err
}

// gameResult is the result from White's side, or nil when unknown.
func gameResult(g *pgn.Game) *int8 {
	res := g.Result
	if res == "" || res == "*" {
		res = g.Tag("Result")
	}
	var v int8
	switch strings.TrimSpace(res) {
	case "1-0":
		v = 1
	case "0-1":
		v = -1
	case "1/2-1/2":
		v = 0
	default:
		return nil
	}
	return &v
}

// gameEntries makes a game's entries. broken: an illegal move cut it
// short. unscored: positions left out for want of a score.
func gameEntries(ctx context.Context, req Request, g pgn.Commented, pool *enginePool) (entries []Entry, broken bool, unscored int64, err error) {
	result := gameResult(&g.Game)
	if result == nil {
		return nil, false, 0, nil
	}
	start, moves, rerr := g.Replay()
	if rerr != nil {
		if len(moves) == 0 {
			return nil, true, 0, nil
		}
		broken = true
	}
	start.Castle = castling(&start)
	positions := make([]chess.Position, len(moves))
	pos := start
	for i, m := range moves {
		positions[i] = pos
		pos = pos.Make(m)
	}

	// Which positions to write.
	keep := make([]bool, len(moves))
	for i, p := range positions {
		keep[i] = i >= req.SkipPlies
		if keep[i] && req.SkipNoisy {
			m := moves[i]
			capture := p.Board[m.To] != chess.Empty ||
				(p.Board[m.From].Type() == chess.Pawn && m.From%8 != m.To%8)
			keep[i] = !capture && !p.InCheck()
		}
	}

	scores := make([]int16, len(moves))
	scored := make([]bool, len(moves))
	if pool != nil {
		if err := pool.score(ctx, positions, keep, scores, scored); err != nil {
			return nil, broken, 0, err
		}
	} else {
		pgnScores(req, g.Comments, positions, scores, scored)
	}

	for i, p := range positions {
		if !keep[i] {
			continue
		}
		if !scored[i] {
			if pool != nil || req.Missing != "zero" {
				unscored++
				continue
			}
			scores[i] = 0
		}
		r := *result
		if p.Turn == chess.Black {
			r = -r
		}
		entries = append(entries, Entry{Pos: p, Move: moves[i], Score: scores[i], Result: r})
	}
	return entries, broken, unscored, nil
}

var (
	evalTag   = regexp.MustCompile(`\[%eval\s+([^\]\s,]+)`)
	engineCmt = regexp.MustCompile(`^\s*([+-]?)(M|#)?(\d+(?:\.\d+)?)/\d+`)
)

// pgnScores reads the scores of the positions from the comments. A
// "[%eval x]" after move i is White's view of the position after it; an
// engine's "+0.31/18" after move i is the mover's view of the position
// before it (its search for that move). The engine's own word wins.
func pgnScores(req Request, comments []string, positions []chess.Position, scores []int16, scored []bool) {
	for i := range positions {
		if i >= len(comments) {
			break
		}
		c := comments[i]
		if c == "" {
			continue
		}
		if m := engineCmt.FindStringSubmatch(c); m != nil {
			v, err := strconv.ParseFloat(m[3], 64)
			if err != nil {
				continue
			}
			sign := 1.0
			if m[1] == "-" {
				sign = -1
			}
			if m[2] != "" {
				scores[i] = mateScore(int(sign) * int(v))
			} else {
				scores[i] = cpScore(sign*v*100, req.PawnValue)
			}
			scored[i] = true
			continue
		}
		if m := evalTag.FindStringSubmatch(c); m != nil && i+1 < len(positions) && !scored[i+1] {
			s, ok := parseEval(m[1], req.PawnValue)
			if !ok {
				continue
			}
			if positions[i+1].Turn == chess.Black {
				s = -s
			}
			scores[i+1], scored[i+1] = s, true
		}
	}
}

// parseEval reads a Lichess-style evaluation: pawns ("0.25", "-1.3") or a
// mate ("#3", "#-4").
func parseEval(s string, pawnValue int) (int16, bool) {
	if strings.HasPrefix(s, "#") {
		n, err := strconv.Atoi(s[1:])
		if err != nil {
			return 0, false
		}
		return mateScore(n), true
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false
	}
	return cpScore(v*100, pawnValue), true
}

const (
	valueMate     = 32000
	maxPly        = 246
	maxPlainScore = valueMate - 2*maxPly - 1 // below Stockfish's tablebase-win scores
)

// cpScore turns centipawns into the file's unit, kept below mate scores.
func cpScore(cp float64, pawnValue int) int16 {
	v := math.Round(cp * float64(pawnValue) / 100)
	if v > maxPlainScore {
		v = maxPlainScore
	}
	if v < -maxPlainScore {
		v = -maxPlainScore
	}
	return int16(v)
}

// mateScore is Stockfish's score for mate in n moves (n < 0: being mated).
func mateScore(n int) int16 {
	switch {
	case n > 0:
		return int16(valueMate - min(2*n-1, maxPly))
	case n < 0:
		return int16(-valueMate + min(-2*n, maxPly))
	}
	return -valueMate // mated now
}

// --- Scoring with an engine ---

var errEngineGone = errors.New("the engine stopped unexpectedly")

type enginePool struct {
	req     Request
	workers []*scorer
}

func newEnginePool(req Request) (*enginePool, error) {
	p := &enginePool{req: req}
	for i := 0; i < req.Concurrency; i++ {
		s, err := newScorer(req)
		if err != nil {
			p.close()
			return nil, fmt.Errorf("could not start %s: %w", engineName(req.Engine), err)
		}
		p.workers = append(p.workers, s)
	}
	return p, nil
}

func engineName(e Engine) string {
	if e.Name != "" {
		return e.Name
	}
	return filepath.Base(e.Path)
}

func (p *enginePool) close() {
	for _, w := range p.workers {
		w.eng.Quit()
	}
}

// score has the engines search the positions to keep, sharing them out.
func (p *enginePool) score(ctx context.Context, positions []chess.Position, keep []bool, scores []int16, scored []bool) error {
	jobs := make(chan int)
	errs := make(chan error, len(p.workers))
	var wg sync.WaitGroup
	for _, w := range p.workers {
		wg.Add(1)
		go func(w *scorer) {
			defer wg.Done()
			for i := range jobs {
				s, ok, err := w.score(ctx, positions[i], p.req)
				if err != nil {
					errs <- err
					for range jobs {
					}
					return
				}
				scores[i], scored[i] = s, ok
			}
		}(w)
	}
	for i := range positions {
		if keep[i] && ctx.Err() == nil {
			jobs <- i
		}
	}
	close(jobs)
	wg.Wait()
	select {
	case err := <-errs:
		if ctx.Err() != nil {
			return nil
		}
		return err
	default:
	}
	return nil
}

// scorer is one engine process.
type scorer struct {
	eng  *uci.Engine
	mu   sync.Mutex
	last uci.Info
	best chan string
	dead chan struct{}
}

func newScorer(req Request) (*scorer, error) {
	s := &scorer{best: make(chan string, 4), dead: make(chan struct{})}
	var once sync.Once
	eng, err := uci.Start(req.Engine.Path, req.Engine.Args, uci.Handlers{
		OnInfo: func(in uci.Info) {
			if in.MultiPV > 1 || !in.HasScore {
				return
			}
			s.mu.Lock()
			s.last = in
			s.mu.Unlock()
		},
		OnBestMove: func(string) {
			select {
			case s.best <- "":
			default:
			}
		},
		OnExit: func() { once.Do(func() { close(s.dead) }) },
	})
	if err != nil {
		return nil, err
	}
	if err := eng.ApplyOptions(req.Engine.Options, "MultiPV", "Ponder", "UCI_AnalyseMode"); err != nil {
		eng.Quit()
		return nil, err
	}
	if err := eng.NewGame(); err != nil {
		eng.Quit()
		return nil, err
	}
	s.eng = eng
	return s, nil
}

// score searches one position; ok is false when the engine gave no score.
func (s *scorer) score(ctx context.Context, pos chess.Position, req Request) (int16, bool, error) {
	s.mu.Lock()
	s.last = uci.Info{}
	s.mu.Unlock()
	select {
	case <-s.best:
	default:
	}
	goCmd := fmt.Sprintf("go depth %d", req.Depth)
	if req.Depth <= 0 {
		goCmd = fmt.Sprintf("go nodes %d", req.Nodes)
	}
	s.eng.Go("position fen "+pos.FEN(), goCmd)
	select {
	case <-s.best:
	case <-s.dead:
		return 0, false, errEngineGone
	case <-ctx.Done():
		s.eng.Stop()
		select {
		case <-s.best:
		case <-time.After(time.Second):
		}
		return 0, false, nil
	}
	s.mu.Lock()
	in := s.last
	s.mu.Unlock()
	if !in.HasScore {
		return 0, false, nil
	}
	if in.IsMate {
		return mateScore(in.Mate), true, nil
	}
	return cpScore(float64(in.ScoreCP), req.PawnValue), true, nil
}
