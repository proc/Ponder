package lichess

import (
	"path/filepath"

	"board/backend/game"
)

// BotMove is the "lichessBotMove" event: the engine has played its move in
// one of its games, and this is what it made of the position. The app uses
// it for the engine's chat remarks (the AI writes them, in character), so
// it is sent for every game the engine plays, whether it is on the board or
// not, and only once the move has gone to Lichess: nothing here waits on it.
type BotMove struct {
	GameID         string `json:"gameId"`
	URL            string `json:"url"`
	Me             string `json:"me"`     // the bot's account
	Engine         string `json:"engine"` // the engine's own name
	Opponent       string `json:"opponent"`
	OpponentRating int    `json:"opponentRating,omitempty"`
	OpponentTitle  string `json:"opponentTitle,omitempty"`
	Side           string `json:"side"` // the engine's: white or black
	Rated          bool   `json:"rated"`
	Speed          string `json:"speed,omitempty"`
	// Ply: the moves played before the engine's; FEN: the position it moved
	// in; Moves: those moves in SAN; Last: the opponent's move that led to
	// it ("" when the engine moved first).
	Ply   int      `json:"ply"`
	FEN   string   `json:"fen"`
	Moves []string `json:"moves"`
	Last  string   `json:"last"`
	Move  string   `json:"move"` // the engine's move, SAN
	// The engine's evaluation, from White's side, and the line it expects
	// (SAN, its own move first).
	HasEval bool     `json:"hasEval"`
	CP      int      `json:"cp"`
	IsMate  bool     `json:"isMate"`
	Mate    int      `json:"mate"`
	Depth   int      `json:"depth,omitempty"`
	PV      []string `json:"pv,omitempty"`
}

// botMoveLocked describes the engine's move (UCI) in the position it is to
// play in now. ok is false if the move cannot be read.
func (r *runner) botMoveLocked(move string, chosen game.EngineInfo) (BotMove, bool) {
	best, err := parseMove(&r.pos, move)
	if err != nil {
		return BotMove{}, false
	}
	opp := r.opponent()
	out := BotMove{
		GameID: r.id, URL: r.url(), Me: r.b.meLocked(), Engine: r.engineNameLocked(),
		Opponent: opp.DisplayName(), OpponentRating: opp.Rating, OpponentTitle: opp.Title,
		Side: r.side(), Rated: r.rated, Speed: r.speed,
		Ply: len(r.moves), FEN: r.pos.FEN(), Move: r.pos.SAN(best),
		HasEval: chosen.HasEval, CP: chosen.CP, IsMate: chosen.IsMate, Mate: chosen.Mate, Depth: chosen.Depth,
		PV: append([]string(nil), chosen.PV...),
	}
	pos := r.start
	out.Moves = make([]string, 0, len(r.moves))
	for _, u := range r.moves {
		mv, err := parseMove(&pos, u)
		if err != nil {
			break
		}
		out.Moves = append(out.Moves, pos.SAN(mv))
		pos = pos.Make(mv)
	}
	// It is the engine's turn: the move before was its opponent's.
	if n := len(out.Moves); n > 0 && n == len(r.moves) {
		out.Last = out.Moves[n-1]
	}
	return out, true
}

// engineNameLocked is the engine's name as it gives it ("id name"), else
// its file's.
func (r *runner) engineNameLocked() string {
	if r.eng != nil && r.eng.Name != "" {
		return r.eng.Name
	}
	if r.engPath != "" {
		return filepath.Base(r.engPath)
	}
	return ""
}
