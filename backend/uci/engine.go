// Package uci drives a UCI chess engine running as a child process.
package uci

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Option is an engine option as announced during the "uci" handshake.
type Option struct {
	Name    string   `json:"name"`
	Type    string   `json:"type"` // check, spin, combo, button, string
	Default string   `json:"default"`
	Min     *int     `json:"min,omitempty"`
	Max     *int     `json:"max,omitempty"`
	Vars    []string `json:"vars,omitempty"`
}

// Info is a parsed "info" line.
type Info struct {
	MultiPV  int // which line, from 1; 1 when the engine does not say
	Depth    int
	SelDepth int
	HasScore bool
	ScoreCP  int
	IsMate   bool
	Mate     int
	Nodes    int64
	NPS      int64
	TimeMs   int64
	PV       []string
}

// Handlers receive asynchronous engine output. They are called from the
// engine's reader goroutine.
type Handlers struct {
	OnInfo     func(Info)
	OnString   func(text string) // free-text "info string ..." messages
	OnBestMove func(move string)
	// OnPonder, when set, is called just before OnBestMove with the reply
	// the engine expects ("bestmove e2e4 ponder e7e5"), or "" without one.
	OnPonder func(move string)
	OnExit   func() // engine process ended without Quit being called
}

type Engine struct {
	Name    string
	Author  string
	Options []Option
	// Applied is what ApplyOptions sent, in order, once the engine has
	// confirmed it took them.
	Applied []OptionSetting

	cmd      *exec.Cmd
	stdin    io.WriteCloser
	h        Handlers
	uciok    chan struct{}
	readyok  chan struct{}
	done     chan struct{}
	mu       sync.Mutex
	quitting bool
}

const handshakeTimeout = 10 * time.Second

// Every engine process still running, so that all can be closed on exit.
var (
	liveMu sync.Mutex
	live   = map[*Engine]struct{}{}
)

// CloseAll asks every running engine to quit and waits up to timeout for
// them to exit, then kills any that are left. Call it before the program ends.
func CloseAll(timeout time.Duration) {
	liveMu.Lock()
	engines := make([]*Engine, 0, len(live))
	for e := range live {
		engines = append(engines, e)
	}
	liveMu.Unlock()
	deadline := time.After(timeout)
	for _, e := range engines {
		e.Quit()
	}
	for _, e := range engines {
		select {
		case <-e.done:
		case <-deadline:
			e.Kill()
			<-e.done
		}
	}
}

// Start launches the engine and completes the uci/uciok handshake.
func Start(path string, args []string, h Handlers) (*Engine, error) {
	cmd := exec.Command(path, args...)
	// Many engines look for network/book files next to the executable.
	if abs, err := filepath.Abs(path); err == nil {
		cmd.Dir = filepath.Dir(abs)
	}
	hideWindow(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("cannot start engine: %w", err)
	}
	e := &Engine{
		cmd: cmd, stdin: stdin, h: h,
		uciok:   make(chan struct{}, 1),
		readyok: make(chan struct{}, 1),
		done:    make(chan struct{}),
	}
	liveMu.Lock()
	live[e] = struct{}{}
	liveMu.Unlock()
	go e.read(stdout)

	e.Send("uci")
	if err := e.wait(e.uciok, "uciok"); err != nil {
		e.Quit()
		return nil, err
	}
	if e.Name == "" {
		e.Name = filepath.Base(path)
	}
	return e, nil
}

func (e *Engine) wait(ch chan struct{}, what string) error {
	select {
	case <-ch:
		return nil
	case <-e.done:
		return fmt.Errorf("engine exited before sending %s", what)
	case <-time.After(handshakeTimeout):
		return fmt.Errorf("engine did not send %s (is it a UCI engine?)", what)
	}
}

func (e *Engine) read(r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		f := strings.Fields(line)
		if len(f) == 0 {
			continue
		}
		switch f[0] {
		case "id":
			if len(f) > 2 && f[1] == "name" {
				e.Name = strings.Join(f[2:], " ")
			} else if len(f) > 2 && f[1] == "author" {
				e.Author = strings.Join(f[2:], " ")
			}
		case "option":
			if o, ok := parseOption(f[1:]); ok {
				e.Options = append(e.Options, o)
			}
		case "uciok":
			signal(e.uciok)
		case "readyok":
			signal(e.readyok)
		case "info":
			// "string" consumes the rest of the line, wherever it appears.
			rest := f[1:]
			for i, tok := range rest {
				if tok == "string" {
					if text := strings.Join(rest[i+1:], " "); text != "" && e.h.OnString != nil {
						e.h.OnString(text)
					}
					rest = rest[:i]
					break
				}
			}
			if e.h.OnInfo != nil {
				if info, ok := parseInfo(rest); ok {
					e.h.OnInfo(info)
				}
			}
		case "bestmove":
			if e.h.OnPonder != nil {
				ponder := ""
				if len(f) > 3 && f[2] == "ponder" {
					ponder = f[3]
				}
				e.h.OnPonder(ponder)
			}
			if e.h.OnBestMove != nil {
				mv := ""
				if len(f) > 1 {
					mv = f[1]
				}
				e.h.OnBestMove(mv)
			}
		}
	}
	e.cmd.Wait()
	liveMu.Lock()
	delete(live, e)
	liveMu.Unlock()
	close(e.done)
	e.mu.Lock()
	quitting := e.quitting
	e.mu.Unlock()
	if !quitting && e.h.OnExit != nil {
		e.h.OnExit()
	}
}

func signal(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}

// Send writes one raw command line to the engine.
func (e *Engine) Send(line string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	io.WriteString(e.stdin, line+"\n")
}

// IsReady sends isready and waits for readyok.
func (e *Engine) IsReady() error {
	select {
	case <-e.readyok:
	default:
	}
	e.Send("isready")
	return e.wait(e.readyok, "readyok")
}

// SetOption sets an engine option. Call only while the engine is idle.
func (e *Engine) SetOption(name, value string) {
	for _, o := range e.Options {
		if strings.EqualFold(o.Name, name) && o.Type == "button" {
			e.Send("setoption name " + o.Name)
			return
		}
	}
	e.Send("setoption name " + name + " value " + value)
}

// OptionSetting is one option to set, as it is sent.
type OptionSetting struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// PlanOptions puts the options to set in the order and form the engine
// takes them: in the order the engine listed its options (so that one an
// engine reads when another changes, such as Threads before Hash or a
// strength limit before its rating, is in place first), under the names
// the engine uses, with values made to fit (a spin within its range, a
// check as true or false, a combo as the engine spells the choice). Options
// the engine did not list follow, by name. Those in skip (any case) are
// left out.
func PlanOptions(listed []Option, opts map[string]string, skip ...string) []OptionSetting {
	left := map[string]string{} // lower-case name -> the name given
	for name := range opts {
		left[strings.ToLower(name)] = name
	}
	for _, s := range skip {
		delete(left, strings.ToLower(s))
	}
	var out []OptionSetting
	for _, o := range listed {
		given, ok := left[strings.ToLower(o.Name)]
		if !ok {
			continue
		}
		delete(left, strings.ToLower(o.Name))
		value := strings.TrimSpace(opts[given])
		switch o.Type {
		case "button":
			continue // pressed, not set: never as part of loading
		case "check":
			switch strings.ToLower(value) {
			case "true", "1", "on", "yes":
				value = "true"
			default:
				value = "false"
			}
		case "spin":
			n, err := strconv.Atoi(value)
			if err != nil {
				continue // not a number: the engine keeps its own value
			}
			if o.Min != nil && n < *o.Min {
				n = *o.Min
			}
			if o.Max != nil && n > *o.Max {
				n = *o.Max
			}
			value = strconv.Itoa(n)
		case "combo":
			found := false
			for _, v := range o.Vars {
				if strings.EqualFold(v, value) {
					value, found = v, true
				}
			}
			if !found && len(o.Vars) > 0 {
				continue // not one of the choices
			}
		}
		out = append(out, OptionSetting{o.Name, value})
	}
	var rest []string
	for _, given := range left {
		rest = append(rest, given)
	}
	sort.Strings(rest)
	for _, given := range rest {
		out = append(out, OptionSetting{given, strings.TrimSpace(opts[given])})
	}
	return out
}

// ApplyOptions sets the options as the engine is loaded, in the order
// PlanOptions gives, and waits until the engine has taken them in: an
// engine that stops over one (a hash too large, a file not found) is
// reported here rather than at its first search.
func (e *Engine) ApplyOptions(opts map[string]string, skip ...string) error {
	plan := PlanOptions(e.Options, opts, skip...)
	for _, s := range plan {
		e.Send("setoption name " + s.Name + " value " + s.Value)
	}
	if err := e.IsReady(); err != nil {
		return fmt.Errorf("the engine did not take its options: %w", err)
	}
	e.Applied = plan
	return nil
}

// NewGame tells the engine a new game starts and waits until it is ready.
func (e *Engine) NewGame() error {
	e.Send("ucinewgame")
	return e.IsReady()
}

// Go sets the position and starts a search. position is the full
// "position ..." command, goCmd the full "go ..." command.
func (e *Engine) Go(position, goCmd string) {
	e.Send(position)
	e.Send(goCmd)
}

// Stop asks the engine to end its search now.
func (e *Engine) Stop() { e.Send("stop") }

// Quit shuts the engine down, killing it if it does not exit promptly.
func (e *Engine) Quit() {
	e.mu.Lock()
	already := e.quitting
	e.quitting = true
	e.mu.Unlock()
	if already {
		return
	}
	e.Send("stop")
	e.Send("quit")
	// End of input too: engines that miss "quit" stop at end of input.
	e.mu.Lock()
	e.stdin.Close()
	e.mu.Unlock()
	go func() {
		select {
		case <-e.done:
		case <-time.After(1500 * time.Millisecond):
			e.Kill()
		}
	}()
}

// Kill ends the engine process at once.
func (e *Engine) Kill() {
	e.mu.Lock()
	e.quitting = true
	e.mu.Unlock()
	if e.cmd.Process != nil {
		e.cmd.Process.Kill()
	}
}

// Done is closed when the engine process has exited.
func (e *Engine) Done() <-chan struct{} { return e.done }

// Probe starts an engine just long enough to read its identity and options.
func Probe(path string, args []string) (*Engine, error) {
	if path == "" {
		return nil, errors.New("no engine path given")
	}
	e, err := Start(path, args, Handlers{})
	if err != nil {
		return nil, err
	}
	e.Quit()
	return e, nil
}

func parseOption(f []string) (Option, bool) {
	var o Option
	key := ""
	var val []string
	flush := func() {
		v := strings.Join(val, " ")
		switch key {
		case "name":
			o.Name = v
		case "type":
			o.Type = v
		case "default":
			if v == "<empty>" {
				v = ""
			}
			o.Default = v
		case "min":
			if n, err := strconv.Atoi(v); err == nil {
				o.Min = &n
			}
		case "max":
			if n, err := strconv.Atoi(v); err == nil {
				o.Max = &n
			}
		case "var":
			o.Vars = append(o.Vars, v)
		}
		val = nil
	}
	for _, tok := range f {
		isKey := false
		switch tok {
		case "name":
			isKey = key == ""
		case "type":
			isKey = key == "name"
		case "default", "min", "max", "var":
			isKey = key != "" && key != "name"
		}
		if isKey {
			flush()
			key = tok
		} else {
			val = append(val, tok)
		}
	}
	flush()
	return o, o.Name != "" && o.Type != ""
}

func parseInfo(f []string) (Info, bool) {
	in := Info{MultiPV: 1}
	useful := false
	for i := 0; i < len(f); i++ {
		next := func() int64 {
			if i+1 < len(f) {
				i++
				n, _ := strconv.ParseInt(f[i], 10, 64)
				return n
			}
			return 0
		}
		switch f[i] {
		case "multipv":
			if n := int(next()); n > 0 {
				in.MultiPV = n
			}
		case "depth":
			in.Depth = int(next())
			useful = true
		case "seldepth":
			in.SelDepth = int(next())
		case "nodes":
			in.Nodes = next()
		case "nps":
			in.NPS = next()
		case "time":
			in.TimeMs = next()
		case "score":
			if i+2 < len(f) {
				n, _ := strconv.Atoi(f[i+2])
				if f[i+1] == "cp" {
					in.HasScore, in.ScoreCP = true, n
				} else if f[i+1] == "mate" {
					in.HasScore, in.IsMate, in.Mate = true, true, n
				}
				i += 2
				useful = true
			}
		case "pv":
			in.PV = append([]string(nil), f[i+1:]...)
			return in, true
		}
	}
	return in, useful
}
