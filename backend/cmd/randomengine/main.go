// Command randomengine is a tiny UCI engine that plays random legal moves
// (taking a mate in one when it sees it). It ships with the GUI so that
// engine games work before a real engine is installed, and is used in tests.
package main

import (
	"bufio"
	"fmt"
	"math/rand"
	"os"
	"strconv"
	"strings"
	"time"

	"board/backend/chess"
)

func main() {
	pos, _ := chess.ParseFEN(chess.StartFEN)
	delay := 400
	reported := "" // opening already announced for this position
	out := bufio.NewWriter(os.Stdout)
	say := func(format string, a ...any) {
		fmt.Fprintf(out, format+"\n", a...)
		out.Flush()
	}
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for in.Scan() {
		f := strings.Fields(in.Text())
		if len(f) == 0 {
			continue
		}
		switch f[0] {
		case "uci":
			say("id name Random Mover")
			say("id author Board")
			say("option name Delay type spin default 400 min 0 max 5000")
			say("uciok")
		case "isready":
			say("readyok")
		case "setoption":
			if len(f) >= 5 && strings.EqualFold(f[2], "Delay") {
				if n, err := strconv.Atoi(f[4]); err == nil && n >= 0 {
					delay = n
				}
			}
		case "position":
			pos = parsePosition(f[1:], pos)
			reported = ""
		case "go":
			moves := pos.LegalMoves()
			if len(moves) == 0 {
				say("bestmove 0000")
				continue
			}
			best := moves[rand.Intn(len(moves))]
			for _, m := range moves {
				n := pos.Make(m)
				if n.InCheck() && len(n.LegalMoves()) == 0 {
					best = m
					break
				}
			}
			if fromStart {
				if name := openingFor(history); name != "" && name != reported {
					say("info string Opening: %s", name)
					reported = name
				}
			}
			time.Sleep(time.Duration(thinkMs(f[1:], delay, pos.Turn)) * time.Millisecond)
			say("info depth 1 score cp 0 nodes %d nps 0 pv %s", len(moves), best.UCI())
			say("bestmove %s", best.UCI())
		case "quit":
			return
		}
	}
}

// thinkMs keeps the artificial delay well inside whatever time we were given.
func thinkMs(args []string, delay int, turn chess.Color) int {
	own := "wtime"
	if turn == chess.Black {
		own = "btime"
	}
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "movetime" || args[i] == own {
			if n, err := strconv.Atoi(args[i+1]); err == nil {
				budget := n / 2
				if args[i] == own {
					budget = n / 40
				}
				if budget < delay {
					delay = budget
				}
			}
		}
	}
	if delay < 0 {
		delay = 0
	}
	return delay
}

// The moves of the current game and whether it began from the start
// position, for the opening table.
var (
	history   []string
	fromStart bool
)

func parsePosition(f []string, old chess.Position) chess.Position {
	pos := old
	i := 0
	history, fromStart = nil, false
	if len(f) > 0 && f[0] == "startpos" {
		pos, _ = chess.ParseFEN(chess.StartFEN)
		i = 1
		fromStart = true
	} else if len(f) > 0 && f[0] == "fen" {
		j := 1
		for j < len(f) && f[j] != "moves" {
			j++
		}
		p, err := chess.ParseFEN(strings.Join(f[1:j], " "))
		if err != nil {
			return old
		}
		pos, i = p, j
		fromStart = p.FEN() == chess.StartFEN
	}
	if i < len(f) && f[i] == "moves" {
		for _, s := range f[i+1:] {
			m, err := pos.ParseUCIMove(s)
			if err != nil {
				break
			}
			pos = pos.Make(m)
			history = append(history, m.UCI())
		}
	}
	return pos
}
