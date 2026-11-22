package lichess

import (
	"fmt"
	"testing"
	"time"

	"board/backend/chess"
)

// After each of its moves the engine says what it made of the position
// (lichessBotMove), for the chat remarks the app has the AI write: the
// opponent's move it answered, the position, its own move and its line.
// It is said only once the move is on Lichess.
func TestBotMoveEvents(t *testing.T) {
	h := newHarness(t, Policy{Casual: true, Humans: true, MaxGames: 1})
	h.connect()
	if err := h.bot.SetAutoAccept(true); err != nil {
		t.Fatal(err)
	}
	id := h.fake.Challenge("Alice", false, false, 120, 1, "black", "standard") // Alice is Black: the engine moves first
	deadline := time.Now().Add(10 * time.Second)
	for {
		h.mu.Lock()
		n := len(h.botMoves)
		h.mu.Unlock()
		if n >= 4 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d lichessBotMove events", n)
		}
		time.Sleep(20 * time.Millisecond)
	}
	h.mu.Lock()
	moves := append([]BotMove(nil), h.botMoves...)
	onServer := append([]int(nil), h.botMovesOnServer...)
	h.mu.Unlock()
	me := h.bot.Status().Account.Username
	for i, m := range moves[:4] {
		if m.GameID != id || m.Me != me || m.Opponent != "Alice" || m.Side != "white" || m.Engine == "" {
			t.Fatalf("event %d: %+v", i, m)
		}
		if m.Ply != 2*i || len(m.Moves) != m.Ply {
			t.Errorf("event %d: ply %d with %d moves", i, m.Ply, len(m.Moves))
		}
		// The position is the one after the moves given.
		pos, _ := chess.ParseFEN(chess.StartFEN)
		for _, san := range m.Moves {
			mv, err := bySAN(&pos, san)
			if err != nil {
				t.Fatalf("event %d: %q: %v", i, san, err)
			}
			pos = pos.Make(mv)
		}
		if pos.FEN() != m.FEN {
			t.Errorf("event %d: FEN %q, the moves give %q", i, m.FEN, pos.FEN())
		}
		if _, err := bySAN(&pos, m.Move); err != nil {
			t.Errorf("event %d: the engine's move %q is not legal there", i, m.Move)
		}
		// The opponent's move it answered: none before the first.
		if (i == 0 && m.Last != "") || (i > 0 && m.Last != m.Moves[len(m.Moves)-1]) {
			t.Errorf("event %d: last %q", i, m.Last)
		}
		// Sent after the move reached Lichess, never before.
		if onServer[i] <= m.Ply {
			t.Errorf("event %d came with %d moves on Lichess, before the engine's move %d", i, onServer[i], m.Ply+1)
		}
	}
}

// bySAN is the legal move written san in pos.
func bySAN(pos *chess.Position, san string) (chess.Move, error) {
	for _, mv := range pos.LegalMoves() {
		if pos.SAN(mv) == san {
			return mv, nil
		}
	}
	return chess.Move{}, fmt.Errorf("no legal move %s", san)
}
