// Command ponderengine is a scripted UCI engine for the pondering tests. It
// always plays the legal move that sorts first and names the reply that
// sorts first as its ponder move; while pondering it waits, as UCI asks,
// for ponderhit or stop. Every line it is sent is written to the file named
// by PONDER_LOG.
package main

import (
	"bufio"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"board/backend/chess"
)

func first(pos chess.Position) (chess.Move, bool) {
	moves := pos.LegalMoves()
	if len(moves) == 0 {
		return chess.Move{}, false
	}
	sort.Slice(moves, func(a, b int) bool { return moves[a].UCI() < moves[b].UCI() })
	return moves[0], true
}

// answer is "bestmove X ponder Y" for a position.
func answer(pos chess.Position) string {
	best, ok := first(pos)
	if !ok {
		return "bestmove 0000"
	}
	if reply, ok := first(pos.Make(best)); ok {
		return "bestmove " + best.UCI() + " ponder " + reply.UCI()
	}
	return "bestmove " + best.UCI()
}

func main() {
	var log *os.File
	if path := os.Getenv("PONDER_LOG"); path != "" {
		log, _ = os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	}
	pos, _ := chess.ParseFEN(chess.StartFEN)
	// The score it gives every position.
	score := os.Getenv("PONDER_SCORE")
	if score == "" {
		score = "10"
	}
	pondering := false
	out := bufio.NewWriter(os.Stdout)
	say := func(s string) {
		fmt.Fprintln(out, s)
		out.Flush()
	}
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for in.Scan() {
		line := strings.TrimSpace(in.Text())
		if log != nil {
			fmt.Fprintln(log, line)
		}
		f := strings.Fields(line)
		if len(f) == 0 {
			continue
		}
		switch f[0] {
		case "uci":
			say("id name Ponder Tester")
			say("option name Ponder type check default false")
			say("uciok")
		case "isready":
			say("readyok")
		case "position":
			// position fen <fen> [moves ...]
			j := 2
			for j < len(f) && f[j] != "moves" {
				j++
			}
			if p, err := chess.ParseFEN(strings.Join(f[2:j], " ")); err == nil {
				pos = p
				for _, s := range f[min(j+1, len(f)):] {
					if m, err := pos.ParseUCIMove(s); err == nil {
						pos = pos.Make(m)
					}
				}
			}
		case "go":
			if len(f) > 1 && f[1] == "ponder" {
				pondering = true
				continue
			}
			time.Sleep(30 * time.Millisecond)
			if best, ok := first(pos); ok {
				say("info depth 1 score cp " + score + " nodes 1 pv " + best.UCI())
			}
			say(answer(pos))
		case "ponderhit", "stop":
			if pondering {
				pondering = false
				say(answer(pos))
			}
		case "quit":
			return
		}
	}
}
