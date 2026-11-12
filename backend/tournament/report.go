package tournament

import (
	"errors"
	"time"

	"board/backend/chess"
)

// ReportGame is a finished game as the report shows it. Moves and move
// data are kept for the most recent games only (detailKept).
type ReportGame struct {
	Number     int     `json:"number"`
	Pair       int     `json:"pair"`
	White      string  `json:"white"`
	Black      string  `json:"black"`
	FirstWhite bool    `json:"firstWhite"` // the first engine had white
	Result     string  `json:"result"`
	Reason     string  `json:"reason"`
	Points     float64 `json:"points"` // the first engine's
	Plies      int     `json:"plies"`
	BookPlies  int     `json:"bookPlies"`
	Opening    string  `json:"opening"`
	DurationMs int64   `json:"durationMs"`
	TimeOut    bool    `json:"timeOut"`
	Crashed    bool    `json:"crashed"`
	// Per engine (index 0: the first engine): moves made, time used, and
	// the sum and count of reported depths.
	EngineMoves [2]int   `json:"engineMoves"`
	EngineTime  [2]int64 `json:"engineTimeMs"`
	DepthSum    [2]int   `json:"depthSum"`
	DepthN      [2]int   `json:"depthN"`

	StartFEN string    `json:"startFen,omitempty"`
	UCI      []string  `json:"uci,omitempty"`
	SAN      []string  `json:"san,omitempty"`
	Data     *moveData `json:"data,omitempty"`
}

// PairPoint is the state of the match after a pair of games.
type PairPoint struct {
	Pair   int     `json:"pair"`
	Games  int     `json:"games"`
	Points float64 `json:"points"`
	LLR    float64 `json:"llr"`
	Elo    float64 `json:"elo"`
	Margin float64 `json:"margin"`
	Score  float64 `json:"score"`
	At     float64 `json:"at"` // seconds from the start
}

// Report is everything the match report needs.
type Report struct {
	Status   Status       `json:"status"`
	Config   Config       `json:"config"`
	Started  time.Time    `json:"started"`
	Ended    time.Time    `json:"ended"`
	Games    []ReportGame `json:"games"`
	Pairs    []PairPoint  `json:"pairs"`
	Detailed int          `json:"detailed"` // games with moves, the most recent
}

// detailKept is how many recent games keep their moves for the report.
const detailKept = 2000

func (t *Tournament) addReportGame(number, pair int, op Opening, seats [2]*player, res gameResult, swapped bool, points float64, dur time.Duration) {
	g := ReportGame{
		Number: number, Pair: pair + 1, White: seats[0].spec.Name, Black: seats[1].spec.Name, FirstWhite: !swapped,
		Result: res.Result, Reason: res.Reason, Points: points, Plies: len(res.Moves), BookPlies: len(op.Moves),
		Opening: op.Name, DurationMs: dur.Milliseconds(), TimeOut: res.TimeOut, Crashed: res.Crashed,
		StartFEN: op.FEN, UCI: res.Moves,
	}
	d := res.Data
	g.Data = &d
	for i := len(op.Moves); i < len(d.TimesMs); i++ {
		// Ply i was played by White when i has the parity of the start.
		whiteMoved := (i%2 == 0) == startsWhite(op.FEN)
		engine := 0 // the first engine
		if whiteMoved == swapped {
			engine = 1
		}
		g.EngineMoves[engine]++
		g.EngineTime[engine] += d.TimesMs[i]
		if d.Depths[i] > 0 {
			g.DepthSum[engine] += d.Depths[i]
			g.DepthN[engine]++
		}
	}
	t.mu.Lock()
	t.reportGames = append(t.reportGames, g)
	if n := len(t.reportGames) - detailKept - 1; n >= 0 {
		old := &t.reportGames[n]
		old.UCI, old.Data, old.StartFEN = nil, nil, ""
	}
	t.mu.Unlock()
}

func startsWhite(fen string) bool {
	p, err := chess.ParseFEN(fen)
	return err != nil || p.Turn == chess.White
}

// Report gathers the match so far for the report.
func (t *Tournament) Report() (Report, error) {
	t.mu.Lock()
	if t.started.IsZero() {
		t.mu.Unlock()
		return Report{}, errors.New("no tournament has been played yet")
	}
	r := Report{Status: t.statusLocked(), Config: t.cfg, Started: t.started, Ended: t.ended,
		Games: append([]ReportGame(nil), t.reportGames...), Pairs: append([]PairPoint(nil), t.pairPoints...)}
	t.mu.Unlock()
	for i := range r.Config.Engines {
		r.Config.Engines[i].Path = "" // not needed, and may be private
	}
	// Moves as SAN, for the game views.
	for i := range r.Games {
		g := &r.Games[i]
		if g.UCI == nil {
			continue
		}
		r.Detailed++
		pos, err := chess.ParseFEN(g.StartFEN)
		if err != nil {
			continue
		}
		g.SAN = make([]string, 0, len(g.UCI))
		for _, u := range g.UCI {
			m, err := pos.ParseUCIMove(u)
			if err != nil {
				break
			}
			g.SAN = append(g.SAN, pos.SAN(m))
			pos = pos.Make(m)
		}
	}
	return r, nil
}
