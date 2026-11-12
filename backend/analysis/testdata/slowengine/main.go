// Command slowengine is a test double for a UCI engine that is slow to stop:
// after "stop" it keeps going for STOP_DELAY_MS before sending bestmove, the
// way a big engine with many threads or a large hash can. In infinite mode
// it reports a line every 50 ms, labelled with the position it was given, so
// a test can tell which position a line belongs to.
package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

func main() {
	delay := 3000
	if v, err := strconv.Atoi(os.Getenv("STOP_DELAY_MS")); err == nil {
		delay = v
	}
	var mu sync.Mutex
	say := func(f string, a ...any) {
		mu.Lock()
		defer mu.Unlock()
		fmt.Printf(f+"\n", a...)
	}
	position := ""
	var stop chan struct{}
	var done chan struct{}
	searching := false
	in := bufio.NewScanner(os.Stdin)
	for in.Scan() {
		line := in.Text()
		f := strings.Fields(line)
		if len(f) == 0 {
			continue
		}
		switch f[0] {
		case "uci":
			say("id name Slow Stopper")
			say("option name MultiPV type spin default 1 min 1 max 5")
			say("uciok")
		case "isready":
			say("readyok")
		case "position":
			mu.Lock()
			busy := searching
			mu.Unlock()
			if busy {
				// A real engine would be confused; make it visible.
				say("info string ERROR position while searching")
			}
			position = line
		case "go":
			mu.Lock()
			busy := searching
			searching = !busy
			mu.Unlock()
			if busy {
				say("info string ERROR go while searching")
				continue
			}
			stop, done = make(chan struct{}), make(chan struct{})
			// The first legal-looking move for the reported line: e2e4 from the
			// start position, or whatever the test does not care about.
			move := "g1f3"
			if strings.Contains(position, " b ") {
				move = "g8f6"
			}
			go func(stop, done chan struct{}, pos string) {
				defer close(done)
				depth := 0
				for {
					select {
					case <-stop:
						time.Sleep(time.Duration(delay) * time.Millisecond)
						// The search is over before bestmove goes out, as in a
						// real engine: the next "go" may follow at once.
						mu.Lock()
						searching = false
						mu.Unlock()
						say("bestmove %s", move)
						return
					case <-time.After(50 * time.Millisecond):
						depth++
						say("info depth %d multipv 1 score cp %d nodes %d pv %s", depth, len(pos), depth*1000, move)
					}
				}
			}(stop, done, position)
		case "stop":
			mu.Lock()
			busy := searching
			mu.Unlock()
			if busy && stop != nil {
				close(stop)
				stop = nil
			}
		case "quit":
			return
		}
	}
}
