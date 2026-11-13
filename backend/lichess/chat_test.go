package lichess

import (
	"strings"
	"testing"
	"time"
)

func TestPlayerChat(t *testing.T) {
	h := newPlayHarness(t)
	if _, err := h.p.Connect(h.srv.URL, "secret"); err != nil {
		t.Fatal(err)
	}
	h.wait("connected", func(st PlayStatus) bool { return st.State == "connected" })
	if err := h.p.Seek(LobbySeek{Limit: 600, Increment: 0, Color: "white"}); err != nil {
		t.Fatal(err)
	}
	st := h.wait("a game", func(st PlayStatus) bool { return len(st.Games) == 1 })
	id := st.Games[0].ID
	h.wait("the game's stream", func(PlayStatus) bool { return h.last().ID == id })

	chat := func(what string, cond func(ChatView) bool) ChatView {
		t.Helper()
		end := time.Now().Add(5 * time.Second)
		for time.Now().Before(end) {
			if v, ok := h.p.Chat(id); ok && cond(v) {
				return v
			}
			time.Sleep(10 * time.Millisecond)
		}
		v, _ := h.p.Chat(id)
		t.Fatalf("timed out waiting for %s; chat %+v", what, v)
		return ChatView{}
	}

	// Someone watching says something; Lichess itself too.
	h.fake.Say(id, "Kibitzer", "spectator", "nice opening")
	h.fake.Say(id, "lichess", "player", "Draw offer declined")
	v := chat("two lines", func(v ChatView) bool { return len(v.Lines) == 2 })
	if l := v.Lines[0]; l.Room != "spectator" || l.User != "Kibitzer" || l.Text != "nice opening" || l.Mine || l.System {
		t.Fatalf("first line %+v", l)
	}
	if l := v.Lines[1]; l.Room != "player" || !l.System {
		t.Fatalf("second line %+v", l)
	}
	if v.Me != "Alice" {
		t.Fatalf("me = %q", v.Me)
	}

	// Our message comes back through the game's stream, then the answer.
	if err := h.p.Say(id, "spectator", "  hello   everyone "); err != nil {
		t.Fatal(err)
	}
	v = chat("our message and the answer", func(v ChatView) bool { return len(v.Lines) == 4 })
	if l := v.Lines[2]; !l.Mine || l.Text != "hello everyone" || l.Room != "spectator" {
		t.Fatalf("our line %+v", l)
	}
	if l := v.Lines[3]; l.Mine || l.Text != "You said: hello everyone" {
		t.Fatalf("answer %+v", l)
	}

	if err := h.p.Say(id, "player", "   "); err == nil {
		t.Fatal("an empty message was sent")
	}
	if err := h.p.Say(id, "player", strings.Repeat("é", ChatMaxLen+1)); err == nil {
		t.Fatal("a message over the limit was sent")
	}
	if err := h.p.Say(id, "player", strings.Repeat("é", ChatMaxLen)); err != nil {
		t.Fatal(err)
	}
	if err := h.p.Say("nosuchgame", "player", "hi"); err == nil {
		t.Fatal("a message was sent to a game that is not ours")
	}
}

func TestChatSeed(t *testing.T) {
	var l chatLog
	l.add(newChatLine("Bob", "three", "player", "alice"))
	l.add(newChatLine("Kib", "watching", "spectator", "alice"))
	history := []ChatMessage{{"Alice", "one"}, {"Bob", "two"}, {"Bob", "three"}}
	if !l.seed(history, "alice") {
		t.Fatal("history not taken")
	}
	var got []string
	for _, line := range l.lines {
		got = append(got, line.Text)
	}
	if strings.Join(got, ",") != "one,two,three,watching" {
		t.Fatalf("lines %v", got)
	}
	if !l.lines[0].Mine || l.lines[0].At != 0 || l.lines[1].Mine {
		t.Fatalf("seeded lines %+v", l.lines[:2])
	}
	if l.seed(history, "alice") {
		t.Fatal("history taken twice")
	}
	for i := 0; i < chatKept+50; i++ {
		l.add(newChatLine("Bob", "x", "player", "alice"))
	}
	if len(l.lines) != chatKept {
		t.Fatalf("kept %d lines", len(l.lines))
	}
}

func TestBotGreetings(t *testing.T) {
	h := newHarness(t, Policy{Casual: true, Humans: true, MaxGames: 1})
	h.cfg.Greeting = Greeting{
		Hello: "Hi {opponent}! I'm {me}.", Goodbye: "Good game!",
		HelloSpectators: "Hi! I'm {me}.", // nothing to the spectators at the end
	}
	h.connect()
	if err := h.bot.SetAutoAccept(true); err != nil {
		t.Fatal(err)
	}
	id := h.fake.Challenge("Alice", false, false, 120, 1, "white", "standard")
	h.waitFor("game start", func(s Status) bool { return len(s.Games) == 1 })
	me := h.bot.Status().Account.Username

	said := func() []string {
		var out []string
		v, _ := h.bot.Chat(id)
		for _, l := range v.Lines {
			if l.Mine {
				out = append(out, l.Room+": "+l.Text)
			}
		}
		return out
	}
	waitSaid := func(want ...string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for strings.Join(said(), "|") != strings.Join(want, "|") {
			if time.Now().After(deadline) {
				t.Fatalf("the engine said %q, want %q", said(), want)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	hello := []string{"player: Hi Alice! I'm " + me + ".", "spectator: Hi! I'm " + me + "."}
	waitSaid(hello...)

	if err := h.bot.Resign(id); err != nil {
		t.Fatal(err)
	}
	h.waitFor("resignation", func(s Status) bool { _, ok := finishedGame(s); return ok })
	waitSaid(append(hello, "player: Good game!")...)
	time.Sleep(200 * time.Millisecond) // nothing more follows
	waitSaid(append(hello, "player: Good game!")...)
}

func TestGreetingText(t *testing.T) {
	if got := GreetingText("  Hi {opponent},\n I'm {me}  ", "BoardBot", "Alice"); got != "Hi Alice, I'm BoardBot" {
		t.Fatalf("got %q", got)
	}
	if got := GreetingText("   ", "a", "b"); got != "" {
		t.Fatalf("got %q", got)
	}
	long := GreetingText(strings.Repeat("é", 200), "a", "b")
	if n := len([]rune(long)); n != ChatMaxLen || !strings.HasSuffix(long, "…") {
		t.Fatalf("%d characters: %q", n, long)
	}
	// No greeting in a game the engine does not play, or one under way.
	if lines := (Greeting{}).lines(true, "a", "b"); len(lines) != 0 {
		t.Fatalf("empty greeting says %v", lines)
	}
}
