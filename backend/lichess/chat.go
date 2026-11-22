package lichess

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

// Chat in a Lichess game. Lichess gives the chat of a game only to the
// accounts playing it (Bot and Board API): the players' room, and the
// spectators' room where the people watching talk. Games of other players
// (Spectator) have no chat API.

// ChatMaxLen is the longest message Lichess takes.
const ChatMaxLen = 140

const chatKept = 500

// ChatLine is one message. It is sent to the UI in a "lichessChat" event.
type ChatLine struct {
	Room   string `json:"room"` // player or spectator
	User   string `json:"user"`
	Text   string `json:"text"`
	At     int64  `json:"at,omitempty"` // when it arrived, ms; 0 for earlier messages
	Mine   bool   `json:"mine,omitempty"`
	System bool   `json:"system,omitempty"` // from Lichess itself (draw offers, …)
}

// ChatEvent is the "lichessChat" event: one new line, or (Lines) the whole
// chat again.
type ChatEvent struct {
	GameID string     `json:"gameId"`
	Line   *ChatLine  `json:"line,omitempty"`
	Lines  []ChatLine `json:"lines,omitempty"`
}

// ChatView is the chat of a game as the UI asks for it.
type ChatView struct {
	GameID string     `json:"gameId"`
	Lines  []ChatLine `json:"lines"`
	Me     string     `json:"me"`
	// Finished: messages can still be sent, but answers no longer arrive.
	Finished bool `json:"finished"`
}

// chatLog is the chat of one game, guarded by its owner's mutex.
type chatLog struct {
	lines  []ChatLine
	seeded bool // the earlier messages were asked for
}

func newChatLine(user, text, room, me string) ChatLine {
	if room != "spectator" {
		room = "player"
	}
	return ChatLine{
		Room: room, User: user, Text: text, At: time.Now().UnixMilli(),
		Mine:   me != "" && strings.EqualFold(user, me),
		System: strings.EqualFold(user, "lichess"),
	}
}

func (l *chatLog) add(line ChatLine) {
	l.lines = append(l.lines, line)
	if len(l.lines) > chatKept {
		l.lines = append([]ChatLine(nil), l.lines[len(l.lines)-chatKept:]...)
	}
}

// seed puts the messages from before the game was followed in front, unless
// the players' room already has that many (a reconnect).
func (l *chatLog) seed(history []ChatMessage, me string) bool {
	have := 0
	for _, line := range l.lines {
		if line.Room == "player" {
			have++
		}
	}
	if len(history) <= have {
		return false
	}
	old := make([]ChatLine, 0, len(history)-have+len(l.lines))
	for _, m := range history[:len(history)-have] {
		line := newChatLine(m.User, m.Text, "player", me)
		line.At = 0
		old = append(old, line)
	}
	l.lines = append(old, l.lines...)
	return true
}

func (l *chatLog) copy() []ChatLine {
	return append([]ChatLine{}, l.lines...)
}

// chatText checks a message before it is sent.
func chatText(room, text string) (string, string, error) {
	text = strings.Join(strings.Fields(text), " ")
	if text == "" {
		return "", "", errors.New("write a message first")
	}
	if utf8.RuneCountInString(text) > ChatMaxLen {
		return "", "", errors.New("Lichess takes messages of up to 140 characters")
	}
	if room != "spectator" {
		room = "player"
	}
	return room, text, nil
}

// ChatMessage is an earlier message of the players' room.
type ChatMessage struct {
	User string `json:"user"`
	Text string `json:"text"`
}

// Chat posts a message in a game's chat: room is "player" or "spectator".
func (c *Client) Chat(ctx context.Context, gameID, room, text string) error {
	form := url.Values{}
	form.Set("room", room)
	form.Set("text", text)
	return c.call(ctx, "POST", c.gamePath(gameID)+"/chat", form, nil)
}

// ChatHistory is what was said in the players' room so far.
func (c *Client) ChatHistory(ctx context.Context, gameID string) ([]ChatMessage, error) {
	var out []ChatMessage
	err := c.call(ctx, "GET", c.gamePath(gameID)+"/chat", nil, &out)
	return out, err
}

// --- the engine's games (Bot API) ---

func (b *Bot) meLocked() string {
	if b.account != nil {
		return b.account.Username
	}
	return ""
}

func (r *runner) onChatLine(e GameEvent) {
	b := r.b
	b.mu.Lock()
	line := newChatLine(e.Username, e.Text, e.Room, b.meLocked())
	r.chat.add(line)
	b.mu.Unlock()
	if b.hooks.Emit != nil {
		b.hooks.Emit("lichessChat", ChatEvent{GameID: r.id, Line: &line})
	}
}

// seedChat reads what was said before the game was followed.
func (r *runner) seedChat() {
	b := r.b
	b.mu.Lock()
	client, seeded := b.client, r.chat.seeded
	r.chat.seeded = true
	b.mu.Unlock()
	if seeded || client == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		history, err := client.ChatHistory(ctx, r.id)
		if err != nil || len(history) == 0 {
			return
		}
		b.mu.Lock()
		changed := r.chat.seed(history, b.meLocked())
		lines := r.chat.copy()
		b.mu.Unlock()
		if changed && b.hooks.Emit != nil {
			b.hooks.Emit("lichessChat", ChatEvent{GameID: r.id, Lines: lines})
		}
	}()
}

// HasGame reports whether id is one of the engine's games.
func (b *Bot) HasGame(id string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.games[id] != nil
}

// Chat is the chat of one of the engine's games.
func (b *Bot) Chat(id string) (ChatView, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	r := b.games[id]
	if r == nil {
		return ChatView{}, false
	}
	return ChatView{GameID: id, Lines: r.chat.copy(), Me: b.meLocked(), Finished: r.finished}, true
}

// Say posts a message in the chat of one of the engine's games.
func (b *Bot) Say(id, room, text string) error {
	room, text, err := chatText(room, text)
	if err != nil {
		return err
	}
	c, err := b.connected()
	if err != nil {
		return err
	}
	b.mu.Lock()
	r := b.games[id]
	b.mu.Unlock()
	if r == nil {
		return errors.New("no such game")
	}
	return r.post(c, room, text)
}

// Remark posts the engine's own chat message (written for it by the AI)
// in one of its games, to its opponent and to the people watching: in the
// players' room and in the spectators' room, one after the other. A room
// that fails does not keep the message from the other; the error says
// which failed.
func (b *Bot) Remark(id, text string) error {
	_, text, err := chatText("player", text)
	if err != nil {
		return err
	}
	c, err := b.connected()
	if err != nil {
		return err
	}
	b.mu.Lock()
	r := b.games[id]
	b.mu.Unlock()
	if r == nil {
		return errors.New("no such game")
	}
	var failed []string
	var last error
	for _, room := range []string{"player", "spectator"} {
		if err := r.post(c, room, text); err != nil {
			failed, last = append(failed, roomName[room]), err
		}
	}
	switch len(failed) {
	case 0:
		return nil
	case 1:
		return fmt.Errorf("not posted in the %s' chat: %w", failed[0], last)
	}
	return fmt.Errorf("not posted: %w", last)
}

var roomName = map[string]string{"player": "players", "spectator": "spectators"}

// post sends a message. The game's stream brings it back, until the game
// is over: then it is added to the chat here.
func (r *runner) post(c *Client, room, text string) error {
	b := r.b
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := c.Chat(ctx, r.id, room, text); err != nil {
		return err
	}
	b.mu.Lock()
	finished, me := r.finished, b.meLocked()
	b.mu.Unlock()
	if finished {
		r.onChatLine(GameEvent{Username: me, Text: text, Room: room})
	}
	return nil
}

// --- hello and goodbye ---

// Greeting is what the engine says in the games it plays, as lichess-bot
// does: to its opponent and to the people watching, when the game starts
// and when it ends. {me} and {opponent} stand for the two names; an empty
// message is not sent.
type Greeting struct {
	Hello             string `json:"hello"`
	Goodbye           string `json:"goodbye"`
	HelloSpectators   string `json:"helloSpectators"`
	GoodbyeSpectators string `json:"goodbyeSpectators"`
}

type chatSend struct{ room, text string }

// GreetingText fills in a message's names, on one line and no longer than
// Lichess takes.
func GreetingText(tmpl, me, opponent string) string {
	text := strings.NewReplacer("{me}", me, "{opponent}", opponent).Replace(tmpl)
	text = strings.Join(strings.Fields(text), " ")
	if r := []rune(text); len(r) > ChatMaxLen {
		text = string(r[:ChatMaxLen-1]) + "…"
	}
	return text
}

// lines are the messages for the start (hello) or the end of a game.
func (g Greeting) lines(hello bool, me, opponent string) []chatSend {
	player, spectator := g.Goodbye, g.GoodbyeSpectators
	if hello {
		player, spectator = g.Hello, g.HelloSpectators
	}
	var out []chatSend
	if t := GreetingText(player, me, opponent); t != "" {
		out = append(out, chatSend{"player", t})
	}
	if t := GreetingText(spectator, me, opponent); t != "" {
		out = append(out, chatSend{"spectator", t})
	}
	return out
}

// sayHello greets once, in a game the engine plays that is only starting
// (like lichess-bot: not when joining a game already under way).
func (r *runner) sayHello() {
	b := r.b
	b.mu.Lock()
	var lines []chatSend
	if r.started && !r.greeted {
		r.greeted = true
		if r.play && !r.finished && len(r.moves) < 2 {
			lines = r.greeting.lines(true, b.meLocked(), r.opponent().DisplayName())
		}
	}
	b.mu.Unlock()
	if len(lines) > 0 {
		go r.send(lines)
	}
}

func (r *runner) send(lines []chatSend) {
	r.b.mu.Lock()
	c := r.b.client
	r.b.mu.Unlock()
	if c == nil {
		return
	}
	for _, l := range lines {
		r.post(c, l.room, l.text) // a greeting that cannot be sent is not worth a message
	}
}

// --- your own games (Board API) ---

func (p *Player) meNameLocked() string {
	if p.account != nil {
		return p.account.Username
	}
	return ""
}

func (g *pgame) onChatLine(e GameEvent) {
	p := g.p
	p.mu.Lock()
	line := newChatLine(e.Username, e.Text, e.Room, p.meNameLocked())
	g.chat.add(line)
	p.mu.Unlock()
	if p.hooks.Emit != nil {
		p.hooks.Emit("lichessChat", ChatEvent{GameID: g.id, Line: &line})
	}
}

func (g *pgame) seedChat() {
	p := g.p
	p.mu.Lock()
	client, seeded := p.client, g.chat.seeded
	g.chat.seeded = true
	p.mu.Unlock()
	if seeded || client == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		history, err := client.ChatHistory(ctx, g.id)
		if err != nil || len(history) == 0 {
			return
		}
		p.mu.Lock()
		changed := g.chat.seed(history, p.meNameLocked())
		lines := g.chat.copy()
		p.mu.Unlock()
		if changed && p.hooks.Emit != nil {
			p.hooks.Emit("lichessChat", ChatEvent{GameID: g.id, Lines: lines})
		}
	}()
}

// Chat is the chat of one of your games.
func (p *Player) Chat(id string) (ChatView, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	g := p.games[id]
	if g == nil {
		return ChatView{}, false
	}
	return ChatView{GameID: id, Lines: g.chat.copy(), Me: p.meNameLocked(), Finished: g.finished}, true
}

// Say posts a message in the chat of one of your games.
func (p *Player) Say(id, room, text string) error {
	room, text, err := chatText(room, text)
	if err != nil {
		return err
	}
	c, err := p.connected()
	if err != nil {
		return err
	}
	p.mu.Lock()
	g := p.games[id]
	p.mu.Unlock()
	if g == nil {
		return errors.New("no such game")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := c.Chat(ctx, id, room, text); err != nil {
		return err
	}
	p.mu.Lock()
	finished, me := g.finished, p.meNameLocked()
	p.mu.Unlock()
	if finished {
		g.onChatLine(GameEvent{Username: me, Text: text, Room: room})
	}
	return nil
}
