package lichess

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Options saved for the engine reach it in the bot's game in progress,
// never in the middle of a search, and new games start with them.
func TestBotUpdateEngineOptions(t *testing.T) {
	dir := t.TempDir()
	engine := filepath.Join(dir, "ponderengine")
	if out, err := exec.Command("go", "build", "-o", engine, "./testdata/ponderengine").CombinedOutput(); err != nil {
		t.Fatal(string(out))
	}
	log := filepath.Join(dir, "engine.log")
	t.Setenv("PONDER_LOG", log)

	h := newHarness(t, Policy{Casual: true, Humans: true, MaxGames: 1})
	h.cfg.Engine = EngineConfig{Name: "Ponder Tester", Path: engine}
	h.fake.Delay = 100 * time.Millisecond
	h.connect()
	if err := h.bot.SetAutoAccept(true); err != nil {
		t.Fatal(err)
	}
	h.waitListening()
	h.fake.Challenge("Alice", false, false, 120, 1, "black", "standard")
	h.waitFor("game start", func(s Status) bool { return len(s.Games) == 1 })
	sent := func() []string {
		data, _ := os.ReadFile(log)
		return strings.Split(strings.TrimSpace(string(data)), "\n")
	}
	// Wait for its first search, so the game's engine is running.
	deadline := time.Now().Add(10 * time.Second)
	for !strings.Contains(strings.Join(sent(), "\n"), "go ") {
		if time.Now().After(deadline) {
			t.Fatal("the engine never searched")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if n := h.bot.UpdateEngineOptions(engine, nil, map[string]string{"Hash": "64"}); n != 1 {
		t.Fatalf("reached %d games' engines", n)
	}
	if n := h.bot.UpdateEngineOptions(engine+"-other", nil, map[string]string{"Hash": "8"}); n != 0 {
		t.Fatalf("another engine was reached")
	}
	for !strings.Contains(strings.Join(sent(), "\n"), "setoption name Hash value 64") {
		if time.Now().After(deadline) {
			t.Fatalf("the option never arrived; the engine was sent:\n%s", strings.Join(sent(), "\n"))
		}
		time.Sleep(20 * time.Millisecond)
	}
	h.bot.mu.Lock()
	kept := h.bot.cfg.Engine.Options["Hash"]
	h.bot.mu.Unlock()
	if kept != "64" {
		t.Fatalf("new games would start with Hash %q", kept)
	}
}
