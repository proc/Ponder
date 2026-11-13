package lichess

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	"board/backend/chess"
)

// Offering and accepting draws, as lichess-bot does: the engine's move is
// sent with a draw offer (which also accepts an offer of the opponent's)
// when the game looks drawn to it.

// DrawOffer is when the engine offers or accepts a draw.
type DrawOffer struct {
	Enabled bool `json:"enabled"`
	// The game looks drawn when the engine's score was within Score
	// centipawns of zero for its last Moves moves, with at most Pieces
	// pieces (pawns and kings too) on the board.
	Score  int `json:"score"`
	Moves  int `json:"moves"`
	Pieces int `json:"pieces"`
	// EGTBZero: also when the Lichess endgame tablebase says the position
	// is a draw (seven pieces or fewer).
	EGTBZero bool `json:"egtbZero"`
}

// DefaultTablebaseURL is the Lichess endgame tablebase.
const DefaultTablebaseURL = "https://tablebase.lichess.ovh"

// tablebasePieces is the most pieces the tablebase knows positions with.
const tablebasePieces = 7

// mateScore stands for a mate among centipawn scores.
const mateScore = 40000

func pieceCount(pos *chess.Position) int {
	n := 0
	for _, pc := range pos.Board {
		if pc != chess.Empty {
			n++
		}
	}
	return n
}

// TablebaseDraw asks the endgame tablebase at base whether the position is
// a draw. Nothing but the position is sent.
func TablebaseDraw(ctx context.Context, base, fen string) (bool, error) {
	if base == "" {
		base = DefaultTablebaseURL
	}
	u := strings.TrimRight(base, "/") + "/standard?fen=" + url.QueryEscape(strings.ReplaceAll(fen, " ", "_"))
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("User-Agent", "Ponder (UCI chess GUI)")
	res, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return false, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return false, &APIError{Status: res.StatusCode, Message: "tablebase: " + res.Status}
	}
	var out struct {
		Category string `json:"category"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return false, err
	}
	return out.Category == "draw", nil
}

// lookupTablebaseLocked asks the tablebase about the position the engine is
// to move in, when a drawn one is a reason to offer a draw. The answer is
// used if it is there by the time the engine has chosen its move.
func (r *runner) lookupTablebaseLocked() {
	d := r.b.cfg.Draw
	n := len(r.moves)
	if !d.Enabled || !d.EGTBZero || !r.play || r.pos.Turn != r.color || r.tbAsked[n] ||
		pieceCount(&r.pos) > tablebasePieces || len(r.pos.LegalMoves()) == 0 {
		return
	}
	if r.tbAsked == nil {
		r.tbAsked = map[int]bool{}
	}
	r.tbAsked[n] = true
	base, fen, ctx := r.b.cfg.TablebaseURL, r.pos.FEN(), r.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	go func() {
		draw, err := TablebaseDraw(ctx, base, fen)
		if err != nil || !draw {
			return
		}
		r.b.mu.Lock()
		if r.tbDraw == nil {
			r.tbDraw = map[int]bool{}
		}
		r.tbDraw[n] = true
		r.b.mu.Unlock()
	}()
}

// offerDrawLocked notes the engine's score for the move it has just chosen
// and reports whether the move goes with a draw offer.
func (r *runner) offerDrawLocked() bool {
	n := len(r.moves)
	if r.lastLinePly == n && r.lastLine.HasScore {
		score := r.lastLine.ScoreCP
		if r.lastLine.IsMate {
			score = mateScore
			if r.lastLine.Mate < 0 {
				score = -mateScore
			}
		}
		r.scores = append(r.scores, score)
	}
	d := r.b.cfg.Draw
	if !d.Enabled {
		return false
	}
	if d.EGTBZero && r.tbDraw[n] {
		return true
	}
	moves := d.Moves
	if moves < 1 {
		moves = 1
	}
	if len(r.scores) < moves || pieceCount(&r.pos) > d.Pieces {
		return false
	}
	for _, s := range r.scores[len(r.scores)-moves:] {
		if s > d.Score || s < -d.Score {
			return false
		}
	}
	return true
}
