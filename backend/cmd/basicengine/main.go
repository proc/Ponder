// Command basicengine is a small UCI chess engine bundled with the GUI as
// "Board Basic". It searches a few moves deep with alpha-beta, a capture
// search and a material and piece-square evaluation: weak, but real, so that
// analysis and engine games work before another engine is installed.
//
// It supports go depth/movetime/wtime/btime/infinite, stop, and MultiPV.
package main

import (
	"bufio"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"board/backend/chess"
)

const (
	mateScore = 30000
	maxDepth  = 32
	maxPly    = 64
)

var (
	outMu sync.Mutex
	out   = bufio.NewWriter(os.Stdout)
)

func say(format string, a ...any) {
	outMu.Lock()
	defer outMu.Unlock()
	fmt.Fprintf(out, format+"\n", a...)
	out.Flush()
}

func main() {
	pos, _ := chess.ParseFEN(chess.StartFEN)
	multiPV := 1
	var stop atomic.Bool
	var searching sync.WaitGroup

	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for in.Scan() {
		f := strings.Fields(in.Text())
		if len(f) == 0 {
			continue
		}
		switch f[0] {
		case "uci":
			say("id name Board Basic")
			say("id author Board")
			say("option name MultiPV type spin default 1 min 1 max 10")
			say("uciok")
		case "isready":
			say("readyok")
		case "setoption":
			// setoption name MultiPV value 3
			if len(f) >= 5 && strings.EqualFold(f[2], "MultiPV") {
				if n, err := strconv.Atoi(f[4]); err == nil && n >= 1 && n <= 10 {
					multiPV = n
				}
			}
		case "ucinewgame":
		case "position":
			searching.Wait()
			if p, ok := parsePosition(f[1:]); ok {
				pos = p
			}
		case "go":
			searching.Wait()
			stop.Store(false)
			lim := parseGo(f[1:], pos.Turn)
			p, n := pos, multiPV
			searching.Add(1)
			go func() {
				defer searching.Done()
				best := search(&p, lim, n, &stop)
				// In infinite mode the GUI decides when the search ends.
				for lim.infinite && !stop.Load() {
					time.Sleep(5 * time.Millisecond)
				}
				if best == nil {
					say("bestmove 0000")
				} else {
					say("bestmove %s", best.UCI())
				}
			}()
		case "stop":
			stop.Store(true)
			searching.Wait()
		case "quit":
			stop.Store(true)
			return
		}
	}
}

type limits struct {
	depth    int
	deadline time.Time // zero: none
	infinite bool
}

func parseGo(args []string, turn chess.Color) limits {
	lim := limits{depth: maxDepth}
	start := time.Now()
	num := func(i int) int64 {
		if i+1 < len(args) {
			n, _ := strconv.ParseInt(args[i+1], 10, 64)
			return n
		}
		return 0
	}
	var remaining, inc, movesToGo int64 = -1, 0, 0
	own, ownInc := "wtime", "winc"
	if turn == chess.Black {
		own, ownInc = "btime", "binc"
	}
	for i, a := range args {
		switch a {
		case "infinite":
			lim.infinite = true
		case "depth":
			if d := int(num(i)); d > 0 && d < maxDepth {
				lim.depth = d
			}
		case "movetime":
			lim.deadline = start.Add(time.Duration(num(i)) * time.Millisecond)
		case own:
			remaining = num(i)
		case ownInc:
			inc = num(i)
		case "movestogo":
			movesToGo = num(i)
		}
	}
	if remaining >= 0 && !lim.infinite {
		div := int64(30)
		if movesToGo > 0 {
			div = movesToGo + 2
		}
		budget := remaining/div + inc*3/4
		if budget > remaining/3 {
			budget = remaining / 3
		}
		if budget < 10 {
			budget = 10
		}
		lim.deadline = start.Add(time.Duration(budget) * time.Millisecond)
	}
	return lim
}

func parsePosition(f []string) (chess.Position, bool) {
	var pos chess.Position
	i := 0
	switch {
	case len(f) > 0 && f[0] == "startpos":
		pos, _ = chess.ParseFEN(chess.StartFEN)
		i = 1
	case len(f) > 0 && f[0] == "fen":
		j := 1
		for j < len(f) && f[j] != "moves" {
			j++
		}
		p, err := chess.ParseFEN(strings.Join(f[1:j], " "))
		if err != nil {
			return pos, false
		}
		pos, i = p, j
	default:
		return pos, false
	}
	if i < len(f) && f[i] == "moves" {
		for _, s := range f[i+1:] {
			m, err := pos.ParseUCIMove(s)
			if err != nil {
				break
			}
			pos = pos.Make(m)
		}
	}
	return pos, true
}

// ---------------------------------------------------------------------------
// Search

type rootMove struct {
	move  chess.Move
	score int
	pv    []chess.Move
}

type searcher struct {
	stop     *atomic.Bool
	deadline time.Time
	nodes    int64
	seldepth int
	aborted  bool
	pv       [maxPly][maxPly]chess.Move
	pvLen    [maxPly]int
}

func (s *searcher) timeUp() bool {
	if s.aborted {
		return true
	}
	if s.nodes&511 == 0 && (s.stop.Load() || (!s.deadline.IsZero() && time.Now().After(s.deadline))) {
		s.aborted = true
	}
	return s.aborted
}

// search runs iterative deepening and reports each completed depth. It
// returns the best move, or nil if there is no legal move.
func search(pos *chess.Position, lim limits, multiPV int, stop *atomic.Bool) *chess.Move {
	start := time.Now()
	s := &searcher{stop: stop, deadline: lim.deadline}
	var roots []rootMove
	for _, m := range pos.LegalMoves() {
		roots = append(roots, rootMove{move: m})
	}
	if len(roots) == 0 {
		return nil
	}
	orderRoot(pos, roots)
	if multiPV > len(roots) {
		multiPV = len(roots)
	}
	best := roots[0].move
	for depth := 1; depth <= lim.depth; depth++ {
		next := make([]rootMove, len(roots))
		copy(next, roots)
		alpha := -mateScore - 1
		for i := range next {
			c := pos.Make(next[i].move)
			// With one line, later moves only need to prove they are worse;
			// with several, every line needs an exact score.
			lo := -mateScore - 1
			if multiPV == 1 && i > 0 {
				lo = alpha
			}
			score := -s.negamax(&c, depth-1, 1, -mateScore-1, -lo)
			if s.aborted {
				break
			}
			next[i].score = score
			next[i].pv = append([]chess.Move{next[i].move}, s.pv[1][1:s.pvLen[1]]...)
			if score > alpha {
				alpha = score
			}
		}
		if s.aborted && depth > 1 {
			break // keep the last complete depth
		}
		sort.SliceStable(next, func(a, b int) bool { return next[a].score > next[b].score })
		roots = next
		best = roots[0].move
		elapsed := time.Since(start)
		ms := elapsed.Milliseconds()
		nps := int64(0)
		if elapsed > 0 {
			nps = int64(float64(s.nodes) / elapsed.Seconds())
		}
		for i := 0; i < multiPV; i++ {
			r := roots[i]
			var pv []string
			for _, m := range r.pv {
				pv = append(pv, m.UCI())
			}
			say("info depth %d seldepth %d multipv %d score %s nodes %d nps %d time %d pv %s",
				depth, maxInt(s.seldepth, depth), i+1, scoreText(r.score), s.nodes, nps, ms, strings.Join(pv, " "))
		}
		if s.aborted {
			break
		}
		// A forced mate found within the searched depth will not improve.
		if !lim.infinite && abs(roots[0].score) > mateScore-maxPly && mateScore-abs(roots[0].score) <= depth {
			break
		}
	}
	return &best
}

func scoreText(score int) string {
	if score > mateScore-maxPly {
		return fmt.Sprintf("mate %d", (mateScore-score+1)/2)
	}
	if score < -mateScore+maxPly {
		return fmt.Sprintf("mate %d", -(mateScore+score+1)/2)
	}
	return fmt.Sprintf("cp %d", score)
}

func (s *searcher) negamax(pos *chess.Position, depth, ply, alpha, beta int) int {
	s.pvLen[ply] = ply
	if s.timeUp() {
		return 0
	}
	if depth <= 0 || ply >= maxPly-1 {
		return s.quiesce(pos, ply, alpha, beta, 0)
	}
	s.nodes++
	if ply > s.seldepth {
		s.seldepth = ply
	}
	moves := pos.LegalMoves()
	if len(moves) == 0 {
		if pos.InCheck() {
			return -mateScore + ply
		}
		return 0
	}
	if pos.Halfmove >= 100 {
		return 0
	}
	order(pos, moves)
	for _, m := range moves {
		c := pos.Make(m)
		score := -s.negamax(&c, depth-1, ply+1, -beta, -alpha)
		if s.aborted {
			return 0
		}
		if score > alpha {
			alpha = score
			s.pv[ply][ply] = m
			for j := ply + 1; j < s.pvLen[ply+1]; j++ {
				s.pv[ply][j] = s.pv[ply+1][j]
			}
			s.pvLen[ply] = s.pvLen[ply+1]
			if alpha >= beta {
				break
			}
		}
	}
	return alpha
}

// quiesce searches captures only, so the evaluation is not taken in the
// middle of an exchange.
func (s *searcher) quiesce(pos *chess.Position, ply, alpha, beta, qdepth int) int {
	s.pvLen[ply] = ply
	s.nodes++
	if ply > s.seldepth {
		s.seldepth = ply
	}
	if s.timeUp() {
		return 0
	}
	stand := evaluate(pos)
	if stand >= beta {
		return stand
	}
	if stand > alpha {
		alpha = stand
	}
	if qdepth >= 6 || ply >= maxPly-1 {
		return alpha
	}
	moves := pos.LegalMoves()
	if len(moves) == 0 {
		if pos.InCheck() {
			return -mateScore + ply
		}
		return 0
	}
	caps := moves[:0]
	for _, m := range moves {
		if isCapture(pos, m) || m.Promo == chess.Queen {
			caps = append(caps, m)
		}
	}
	order(pos, caps)
	for _, m := range caps {
		c := pos.Make(m)
		score := -s.quiesce(&c, ply+1, -beta, -alpha, qdepth+1)
		if s.aborted {
			return 0
		}
		if score > alpha {
			alpha = score
			s.pv[ply][ply] = m
			for j := ply + 1; j < s.pvLen[ply+1]; j++ {
				s.pv[ply][j] = s.pv[ply+1][j]
			}
			s.pvLen[ply] = s.pvLen[ply+1]
			if alpha >= beta {
				break
			}
		}
	}
	return alpha
}

func isCapture(pos *chess.Position, m chess.Move) bool {
	return pos.Board[m.To] != chess.Empty ||
		(pos.Board[m.From].Type() == chess.Pawn && m.From%8 != m.To%8)
}

// order puts promotions and captures (most valuable victim, least valuable
// attacker) first.
func order(pos *chess.Position, moves []chess.Move) {
	key := func(m chess.Move) int {
		k := 0
		if m.Promo != 0 {
			k += 10 * value[m.Promo]
		}
		if v := pos.Board[m.To]; v != chess.Empty {
			k += 10*value[v.Type()] - value[pos.Board[m.From].Type()]
		}
		return k
	}
	sort.SliceStable(moves, func(a, b int) bool { return key(moves[a]) > key(moves[b]) })
}

func orderRoot(pos *chess.Position, roots []rootMove) {
	moves := make([]chess.Move, len(roots))
	for i, r := range roots {
		moves[i] = r.move
	}
	order(pos, moves)
	for i, m := range moves {
		roots[i] = rootMove{move: m}
	}
}

// ---------------------------------------------------------------------------
// Evaluation: material plus piece-square tables, from the side to move.

var value = [7]int{0, 100, 320, 330, 500, 900, 0}

// Tables from White's side, rank 8 first (as a board is printed).
var pst = [7][64]int{
	{},
	{ // pawn
		0, 0, 0, 0, 0, 0, 0, 0,
		50, 50, 50, 50, 50, 50, 50, 50,
		10, 10, 20, 30, 30, 20, 10, 10,
		5, 5, 10, 25, 25, 10, 5, 5,
		0, 0, 0, 20, 20, 0, 0, 0,
		5, -5, -10, 0, 0, -10, -5, 5,
		5, 10, 10, -20, -20, 10, 10, 5,
		0, 0, 0, 0, 0, 0, 0, 0,
	},
	{ // knight
		-50, -40, -30, -30, -30, -30, -40, -50,
		-40, -20, 0, 0, 0, 0, -20, -40,
		-30, 0, 10, 15, 15, 10, 0, -30,
		-30, 5, 15, 20, 20, 15, 5, -30,
		-30, 0, 15, 20, 20, 15, 0, -30,
		-30, 5, 10, 15, 15, 10, 5, -30,
		-40, -20, 0, 5, 5, 0, -20, -40,
		-50, -40, -30, -30, -30, -30, -40, -50,
	},
	{ // bishop
		-20, -10, -10, -10, -10, -10, -10, -20,
		-10, 0, 0, 0, 0, 0, 0, -10,
		-10, 0, 5, 10, 10, 5, 0, -10,
		-10, 5, 5, 10, 10, 5, 5, -10,
		-10, 0, 10, 10, 10, 10, 0, -10,
		-10, 10, 10, 10, 10, 10, 10, -10,
		-10, 5, 0, 0, 0, 0, 5, -10,
		-20, -10, -10, -10, -10, -10, -10, -20,
	},
	{ // rook
		0, 0, 0, 0, 0, 0, 0, 0,
		5, 10, 10, 10, 10, 10, 10, 5,
		-5, 0, 0, 0, 0, 0, 0, -5,
		-5, 0, 0, 0, 0, 0, 0, -5,
		-5, 0, 0, 0, 0, 0, 0, -5,
		-5, 0, 0, 0, 0, 0, 0, -5,
		-5, 0, 0, 0, 0, 0, 0, -5,
		0, 0, 0, 5, 5, 0, 0, 0,
	},
	{ // queen
		-20, -10, -10, -5, -5, -10, -10, -20,
		-10, 0, 0, 0, 0, 0, 0, -10,
		-10, 0, 5, 5, 5, 5, 0, -10,
		-5, 0, 5, 5, 5, 5, 0, -5,
		0, 0, 5, 5, 5, 5, 0, -5,
		-10, 5, 5, 5, 5, 5, 0, -10,
		-10, 0, 5, 0, 0, 0, 0, -10,
		-20, -10, -10, -5, -5, -10, -10, -20,
	},
	{ // king (middlegame)
		-30, -40, -40, -50, -50, -40, -40, -30,
		-30, -40, -40, -50, -50, -40, -40, -30,
		-30, -40, -40, -50, -50, -40, -40, -30,
		-30, -40, -40, -50, -50, -40, -40, -30,
		-20, -30, -30, -40, -40, -30, -30, -20,
		-10, -20, -20, -20, -20, -20, -20, -10,
		20, 20, 0, 0, 0, 0, 20, 20,
		20, 30, 10, 0, 0, 10, 30, 20,
	},
}

func evaluate(pos *chess.Position) int {
	score := 0
	for sq, pc := range pos.Board {
		if pc == chess.Empty {
			continue
		}
		t := pc.Type()
		rank, file := sq/8, sq%8
		if pc.Color() == chess.White {
			score += value[t] + pst[t][(7-rank)*8+file]
		} else {
			score -= value[t] + pst[t][rank*8+file]
		}
	}
	if pos.Turn == chess.Black {
		return -score
	}
	return score
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
