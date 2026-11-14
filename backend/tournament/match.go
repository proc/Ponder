package tournament

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"board/backend/chess"
	"board/backend/uci"
)

// EngineSpec is an engine taking part.
type EngineSpec struct {
	Name    string            `json:"name"`
	Path    string            `json:"path"`
	Args    []string          `json:"args"`
	Options map[string]string `json:"options"`
}

// player runs one engine process for a worker; it is reused game after
// game (with ucinewgame) and restarted if it dies.
type player struct {
	spec EngineSpec
	eng  *uci.Engine
	// The options the engine was sent and confirmed, when it was last
	// started; started says it has been.
	applied []uci.OptionSetting
	started bool
	best    chan string
	dead    chan struct{}

	mu   sync.Mutex
	info uci.Info // the last main-line info of the current search
}

func (p *player) start() error {
	p.best = make(chan string, 4)
	p.dead = make(chan struct{})
	dead := p.dead
	var once sync.Once
	eng, err := uci.Start(p.spec.Path, p.spec.Args, uci.Handlers{
		OnInfo: func(in uci.Info) {
			if in.MultiPV > 1 {
				return
			}
			p.mu.Lock()
			if in.HasScore || p.info.PV == nil {
				p.info = in
			} else {
				// Keep the score from the last line that had one.
				in.HasScore, in.ScoreCP, in.IsMate, in.Mate = p.info.HasScore, p.info.ScoreCP, p.info.IsMate, p.info.Mate
				p.info = in
			}
			p.mu.Unlock()
		},
		OnBestMove: func(m string) {
			select {
			case p.best <- m:
			default:
			}
		},
		OnExit: func() { once.Do(func() { close(dead) }) },
	})
	if err != nil {
		return err
	}
	if err := eng.ApplyOptions(p.spec.Options); err != nil {
		eng.Quit()
		return err
	}
	p.applied, p.started = eng.Applied, true
	p.eng = eng
	return nil
}

// ready makes sure the engine runs and starts a new game.
func (p *player) ready() error {
	if p.eng != nil {
		select {
		case <-p.dead:
			p.eng = nil
		default:
		}
	}
	if p.eng == nil {
		if err := p.start(); err != nil {
			return err
		}
	}
	if err := p.eng.NewGame(); err != nil {
		p.stop()
		return err
	}
	return nil
}

func (p *player) stop() {
	if p.eng != nil {
		p.eng.Quit()
		p.eng = nil
	}
}

func (p *player) lastInfo() uci.Info {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.info
}

// TimeControl for every game: a clock (base + increment), a fixed time per
// move, or a fixed number of nodes per move.
type TimeControl struct {
	BaseMs     int64 `json:"baseMs"`
	IncMs      int64 `json:"incMs"`
	MoveTimeMs int64 `json:"moveTimeMs"`
	Nodes      int64 `json:"nodes"`
	MarginMs   int64 `json:"marginMs"` // allowed overrun before a loss on time
}

func (tc TimeControl) clocked() bool { return tc.MoveTimeMs == 0 && tc.Nodes == 0 }

// PGN is the TimeControl tag.
func (tc TimeControl) PGN() string {
	switch {
	case tc.Nodes > 0:
		return "-"
	case tc.MoveTimeMs > 0:
		return fmt.Sprintf("%g/move", float64(tc.MoveTimeMs)/1000)
	}
	return fmt.Sprintf("%g+%g", float64(tc.BaseMs)/1000, float64(tc.IncMs)/1000)
}

// String describes it for people.
func (tc TimeControl) String() string {
	switch {
	case tc.Nodes > 0:
		return fmt.Sprintf("%d nodes/move", tc.Nodes)
	case tc.MoveTimeMs > 0:
		return fmt.Sprintf("%gs/move", float64(tc.MoveTimeMs)/1000)
	}
	return fmt.Sprintf("%g+%g", float64(tc.BaseMs)/1000, float64(tc.IncMs)/1000)
}

// Adjudication ends games whose outcome is clear, to save time.
type Adjudication struct {
	Draw           bool `json:"draw"`
	DrawMoveNumber int  `json:"drawMoveNumber"` // from this move number
	DrawMoves      int  `json:"drawMoves"`      // consecutive moves by each side…
	DrawScore      int  `json:"drawScore"`      // …within ±this (cp)
	Resign         bool `json:"resign"`
	ResignMoves    int  `json:"resignMoves"` // consecutive moves by each side…
	ResignScore    int  `json:"resignScore"` // …with both agreeing on at least this (cp)
	MaxMoves       int  `json:"maxMoves"`    // draw after this many moves (0: none)
}

// gameResult is a finished game.
type gameResult struct {
	Result  string // 1-0, 0-1, 1/2-1/2
	Reason  string // how it ended, for the PGN and the UI
	Moves   []string
	Data    moveData
	Crashed bool
	TimeOut bool
}

// NoEval marks a move without an evaluation (a book move, or none given).
const NoEval = 32767

// moveData is what the engines said about each move (book moves included),
// for the report: the evaluation from White's side in centipawns (mates
// near ±10000), the depth, and the time taken.
type moveData struct {
	Evals   []int   `json:"evals"`
	Depths  []int   `json:"depths"`
	TimesMs []int64 `json:"times"`
	// What each side's engine reported for the moves it searched (White,
	// Black), summed for the statistics.
	search [2]searchSum
}

// searchSum adds up an engine's searches: how many moves, and the depth,
// selective depth, nodes, speed and time of each that reported them.
type searchSum struct {
	Moves            int
	DepthSum, DepthN int
	SelSum, SelN     int
	Nodes, NodesN    int64
	NPS, NPSN        int64
	TimeMs           int64
}

func (s *searchSum) add(in uci.Info, ms int64) {
	s.Moves++
	s.TimeMs += ms
	if in.Depth > 0 {
		s.DepthSum += in.Depth
		s.DepthN++
	}
	if in.SelDepth > 0 {
		s.SelSum += in.SelDepth
		s.SelN++
	}
	if in.Nodes > 0 {
		s.Nodes += in.Nodes
		s.NodesN++
	}
	if in.NPS > 0 {
		s.NPS += in.NPS
		s.NPSN++
	}
}

func (s *searchSum) merge(o searchSum) {
	s.Moves += o.Moves
	s.DepthSum += o.DepthSum
	s.DepthN += o.DepthN
	s.SelSum += o.SelSum
	s.SelN += o.SelN
	s.Nodes += o.Nodes
	s.NodesN += o.NodesN
	s.NPS += o.NPS
	s.NPSN += o.NPSN
	s.TimeMs += o.TimeMs
}

func (d *moveData) add(eval, depth int, ms int64) {
	d.Evals = append(d.Evals, eval)
	d.Depths = append(d.Depths, depth)
	d.TimesMs = append(d.TimesMs, ms)
}

// moveUpdate reports a move of a game being watched.
type moveUpdate struct {
	moves   []string
	clocks  [2]int64
	turnAt  time.Time
	running bool
	info    uci.Info
	side    chess.Color // the side that is thinking (or just moved, with info)
}

const mateScore = 100000

func scoreCP(in uci.Info) (int, bool) {
	if !in.HasScore {
		return 0, false
	}
	if in.IsMate {
		if in.Mate > 0 {
			return mateScore - in.Mate, true
		}
		return -mateScore - in.Mate, true
	}
	return in.ScoreCP, true
}

// playGame plays one game; seats[0] has white.
func playGame(ctx context.Context, op Opening, seats [2]*player, tc TimeControl, adj Adjudication,
	update func(moveUpdate)) (gameResult, error) {
	start, err := chess.ParseFEN(op.FEN)
	if err != nil {
		return gameResult{}, err
	}
	pos := start
	seen := map[chess.Key]int{pos.Key(): 1}
	var moves []string
	var data moveData
	for _, u := range op.Moves {
		m, err := pos.ParseUCIMove(u)
		if err != nil {
			return gameResult{}, fmt.Errorf("opening move %s: %w", u, err)
		}
		pos = pos.Make(m)
		seen[pos.Key()]++
		moves = append(moves, m.UCI())
		data.add(NoEval, 0, 0)
	}
	for i, p := range seats {
		if err := p.ready(); err != nil {
			return gameResult{Crashed: true, Result: map[int]string{0: "0-1", 1: "1-0"}[i],
				Reason: fmt.Sprintf("%s did not start: %v", p.spec.Name, err)}, nil
		}
	}
	clocks := [2]int64{tc.BaseMs, tc.BaseMs}
	startFEN := start.FEN()
	end := func(result, reason string) (gameResult, error) {
		return gameResult{Result: result, Reason: reason, Moves: moves, Data: data}, nil
	}
	win := func(c chess.Color) string { return map[chess.Color]string{chess.White: "1-0", chess.Black: "0-1"}[c] }
	name := func(c chess.Color) string {
		return map[chess.Color]string{chess.White: "White", chess.Black: "Black"}[c]
	}
	// Adjudication counters: consecutive moves per side.
	var drawRun, losingRun, winningRun [2]int
	gameMoves := 0 // moves played by the engines (plies)

	for {
		switch {
		case len(pos.LegalMoves()) == 0:
			if pos.InCheck() {
				return end(win(pos.Turn.Other()), name(pos.Turn.Other())+" wins by checkmate")
			}
			return end("1/2-1/2", "Draw by stalemate")
		case pos.InsufficientMaterial():
			return end("1/2-1/2", "Draw by insufficient material")
		case seen[pos.Key()] >= 3:
			return end("1/2-1/2", "Draw by threefold repetition")
		case pos.Halfmove >= 100:
			return end("1/2-1/2", "Draw by the fifty-move rule")
		case adj.MaxMoves > 0 && pos.Fullmove > adj.MaxMoves:
			return end("1/2-1/2", "Draw by adjudication: move limit")
		}
		if err := ctx.Err(); err != nil {
			return gameResult{}, err
		}
		side := pos.Turn
		p := seats[side]
		position := "position fen " + startFEN
		if len(moves) > 0 {
			position += " moves " + strings.Join(moves, " ")
		}
		var goCmd string
		limit := time.Duration(0)
		switch {
		case tc.Nodes > 0:
			goCmd = fmt.Sprintf("go nodes %d", tc.Nodes)
			limit = time.Minute // a sanity limit only
		case tc.MoveTimeMs > 0:
			goCmd = fmt.Sprintf("go movetime %d", tc.MoveTimeMs)
			limit = time.Duration(tc.MoveTimeMs+tc.MarginMs) * time.Millisecond
		default:
			goCmd = fmt.Sprintf("go wtime %d btime %d winc %d binc %d", clocks[0], clocks[1], tc.IncMs, tc.IncMs)
			limit = time.Duration(clocks[side]+tc.MarginMs) * time.Millisecond
		}
	drain:
		for {
			select {
			case <-p.best:
			default:
				break drain
			}
		}
		p.mu.Lock()
		p.info = uci.Info{}
		p.mu.Unlock()
		began := time.Now()
		if update != nil {
			update(moveUpdate{moves: moves, clocks: clocks, turnAt: began, running: true, side: side})
		}
		p.eng.Go(position, goCmd)
		timer := time.NewTimer(limit)
		var best string
		timedOut, crashed := false, false
		select {
		case best = <-p.best:
		case <-timer.C:
			timedOut = true
		case <-p.dead:
			crashed = true
		case <-ctx.Done():
			timer.Stop()
			p.eng.Stop()
			waitBest(p, time.Second)
			return gameResult{}, ctx.Err()
		}
		timer.Stop()
		elapsed := time.Since(began).Milliseconds()
		if crashed {
			p.eng = nil
			return gameResult{Result: win(side.Other()), Reason: name(side) + " loses: the engine crashed",
				Moves: moves, Data: data, Crashed: true}, nil
		}
		if timedOut {
			p.eng.Stop()
			if !waitBest(p, 2*time.Second) {
				p.stop() // unresponsive: restart for the next game
			}
			reason := name(side) + " loses on time"
			if !tc.clocked() {
				reason = name(side) + " loses: took too long"
			}
			// Insufficient material for the winner makes it a draw.
			if !pos.CanMate(side.Other()) {
				return gameResult{Result: "1/2-1/2", Reason: "Draw: time out with insufficient material", Moves: moves, Data: data, TimeOut: true}, nil
			}
			return gameResult{Result: win(side.Other()), Reason: reason, Moves: moves, Data: data, TimeOut: true}, nil
		}
		if tc.clocked() {
			clocks[side] += tc.IncMs - elapsed
		}
		m, err := pos.ParseUCIMove(best)
		if err != nil {
			return end(win(side.Other()), fmt.Sprintf("%s loses: illegal move %s", name(side), best))
		}
		in := p.lastInfo()
		pos = pos.Make(m)
		seen[pos.Key()]++
		moves = append(moves, m.UCI())
		gameMoves++
		cp, has := scoreCP(in)
		eval := NoEval
		if has {
			eval = cp
			if in.IsMate {
				eval = 10000 - abs(in.Mate)
				if in.Mate < 0 {
					eval = -eval
				}
			}
			if eval > 10000 {
				eval = 10000
			} else if eval < -10000 {
				eval = -10000
			}
			if side == chess.Black {
				eval = -eval
			}
		}
		data.add(eval, in.Depth, elapsed)
		data.search[side].add(in, elapsed)
		if update != nil {
			update(moveUpdate{moves: moves, clocks: clocks, turnAt: time.Now(), info: in, side: side})
		}

		// Adjudication, on the evaluations of both engines.
		count := func(run *int, ok bool) {
			if ok {
				*run++
			} else {
				*run = 0
			}
		}
		count(&drawRun[side], has && abs(cp) <= adj.DrawScore)
		count(&losingRun[side], has && cp <= -adj.ResignScore)
		count(&winningRun[side], has && cp >= adj.ResignScore)
		if adj.Draw && pos.Fullmove >= adj.DrawMoveNumber && drawRun[0] >= adj.DrawMoves && drawRun[1] >= adj.DrawMoves {
			return end("1/2-1/2", "Draw by adjudication")
		}
		if adj.Resign {
			// One side sees itself lost and the other sees itself winning,
			// each for the given number of moves.
			for _, loser := range []chess.Color{chess.White, chess.Black} {
				if losingRun[loser] >= adj.ResignMoves && winningRun[loser.Other()] >= adj.ResignMoves {
					return end(win(loser.Other()), name(loser.Other())+" wins by adjudication")
				}
			}
		}
	}
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// waitBest waits for the bestmove after a stop.
func waitBest(p *player, d time.Duration) bool {
	select {
	case <-p.best:
		return true
	case <-p.dead:
		return false
	case <-time.After(d):
		return false
	}
}

var errStopped = errors.New("stopped")
