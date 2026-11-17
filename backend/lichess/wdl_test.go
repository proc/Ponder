package lichess

import (
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"board/backend/game"
)

// The bot's engine is asked for its win/draw/loss chances when it offers
// them, and its window gets them, White's first: flipped when the bot
// plays Black.
func TestBotEngineWDL(t *testing.T) {
	dir := t.TempDir()
	engine := filepath.Join(dir, "ponderengine")
	if out, err := exec.Command("go", "build", "-o", engine, "./testdata/ponderengine").CombinedOutput(); err != nil {
		t.Fatal(string(out))
	}
	for _, challenger := range []string{"white", "black"} {
		t.Run("challenger "+challenger, func(t *testing.T) {
			h := newHarness(t, Policy{Casual: true, Humans: true, MaxGames: 1})
			h.cfg.Engine = EngineConfig{Name: "Ponder Tester", Path: engine}
			h.connect()
			if err := h.bot.SetAutoAccept(true); err != nil {
				t.Fatal(err)
			}
			h.waitListening()
			h.fake.Challenge("Alice", false, false, 120, 1, challenger, "standard")
			s := h.waitFor("game start", func(s Status) bool { return len(s.Games) == 1 })
			bot := s.Games[0].Color
			var got *game.EngineInfo
			for deadline := time.Now().Add(10 * time.Second); got == nil; {
				h.mu.Lock()
				for i := range h.engineInfos {
					if in := h.engineInfos[i]; in.WDL != nil && !in.Pondering {
						got = &in
						break
					}
				}
				h.mu.Unlock()
				if got == nil {
					if time.Now().After(deadline) {
						t.Fatal("no engine info with win/draw/loss chances")
					}
					time.Sleep(20 * time.Millisecond)
				}
			}
			want := [3]int{600, 300, 100}
			if bot == "black" {
				want = [3]int{100, 300, 600}
			}
			if *got.WDL != want {
				t.Fatalf("bot plays %s: wdl %v, want %v", bot, *got.WDL, want)
			}
		})
	}
}
