package game

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A UCI engine that writes every command it gets to the file named by its
// first argument, and answers "go movetime N" after N ms with a legal move
// it is told about in the position ("e7e5", "d7d5", … in turn).
const logEngineSrc = `package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

func main() {
	log, _ := os.OpenFile(os.Args[1], os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	replies := []string{"e7e5", "d7d5", "g8f6", "b8c6"}
	n := 0
	in := bufio.NewScanner(os.Stdin)
	for in.Scan() {
		line := strings.TrimSpace(in.Text())
		fmt.Fprintln(log, line)
		log.Sync()
		f := strings.Fields(line)
		if len(f) == 0 {
			continue
		}
		switch f[0] {
		case "uci":
			fmt.Println("id name Logger")
			fmt.Println("option name Hash type spin default 16 min 1 max 1024")
			fmt.Println("uciok")
		case "isready":
			fmt.Println("readyok")
		case "go":
			ms := 0
			for i := range f {
				if f[i] == "movetime" && i+1 < len(f) {
					ms, _ = strconv.Atoi(f[i+1])
				}
			}
			time.Sleep(time.Duration(ms) * time.Millisecond)
			fmt.Println("info depth 1 score cp 0 pv " + replies[n%len(replies)])
			fmt.Println("bestmove " + replies[n%len(replies)])
			n++
		case "quit":
			return
		}
	}
}
`

func buildLogEngine(t *testing.T) (path, logFile string) {
	t.Helper()
	dir := t.TempDir()
	src := filepath.Join(dir, "main.go")
	if err := os.WriteFile(src, []byte(logEngineSrc), 0o644); err != nil {
		t.Fatal(err)
	}
	path = filepath.Join(dir, "logengine")
	if out, err := exec.Command("go", "build", "-o", path, src).CombinedOutput(); err != nil {
		t.Fatal(string(out))
	}
	return path, filepath.Join(dir, "commands.log")
}

func readLog(t *testing.T, file string) []string {
	t.Helper()
	b, _ := os.ReadFile(file)
	return strings.Split(strings.TrimSpace(string(b)), "\n")
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(10 * time.Millisecond) {
		if cond() {
			return
		}
	}
	t.Fatal("timed out waiting for " + what)
}

func index(lines []string, s string) int {
	for i, l := range lines {
		if l == s {
			return i
		}
	}
	return -1
}

func TestUpdateEngineOptions(t *testing.T) {
	path, logFile := buildLogEngine(t)
	r := newRecorder()
	m := NewManager(r.emit)
	defer m.Shutdown()
	black := PlayerConfig{Type: "engine", Name: "Logger", EnginePath: path, EngineArgs: []string{logFile},
		TimeControl: TimeControl{Kind: "movetime", MoveTimeMs: 300}}
	if err := m.NewGame(Config{White: human(TimeControl{Kind: "none"}), Black: black}); err != nil {
		t.Fatal(err)
	}
	args := []string{logFile}

	// White to move: the engine is idle and gets the option at once.
	if n := m.UpdateEngineOptions(path, args, map[string]string{"Hash": "64"}); n != 1 {
		t.Fatalf("reached %d engines", n)
	}
	waitFor(t, "Hash 64", func() bool { return index(readLog(t, logFile), "setoption name Hash value 64") >= 0 })
	// Another engine (other arguments) is left alone.
	if n := m.UpdateEngineOptions(path, nil, map[string]string{"Hash": "8"}); n != 0 {
		t.Fatalf("an engine with other arguments was reached")
	}
	// Reset to the default: the default is sent back.
	m.UpdateEngineOptions(path, args, map[string]string{})
	waitFor(t, "Hash back to 16", func() bool { return index(readLog(t, logFile), "setoption name Hash value 16") >= 0 })

	// While it searches its move, the change waits for its next search.
	if err := m.Move("e2e4"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "first go", func() bool { return index(readLog(t, logFile), "go movetime 300") >= 0 })
	m.UpdateEngineOptions(path, args, map[string]string{"Hash": "128"})
	time.Sleep(50 * time.Millisecond)
	if index(readLog(t, logFile), "setoption name Hash value 128") >= 0 {
		t.Fatal("an option was sent during the search")
	}
	waitFor(t, "the engine's reply", func() bool { return len(m.State().Moves) == 2 })
	if err := m.Move("d2d4"); err != nil {
		t.Fatal(err)
	}
	// Wait for the second search's "go", not only its "position": the
	// log may be read between the two.
	var lines []string
	var gos []int
	waitFor(t, "the second search", func() bool {
		lines = readLog(t, logFile)
		gos = gos[:0]
		for i, l := range lines {
			if strings.HasPrefix(l, "go ") {
				gos = append(gos, i)
			}
		}
		return index(lines, "position startpos moves e2e4 e7e5 d2d4") >= 0 && len(gos) >= 2
	})
	set := index(lines, "setoption name Hash value 128")
	if len(gos) < 2 || set < gos[0] || set > gos[1] {
		t.Fatalf("setoption at %d, searches at %v:\n%s", set, gos, strings.Join(lines, "\n"))
	}
}
