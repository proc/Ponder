package tournament

import (
	"fmt"
	"math"
	"sort"
)

// The ways a tournament pairs its engines.
const (
	FormatMatch      = "match"      // two engines, with Elo and an SPRT
	FormatRoundRobin = "roundrobin" // everyone plays everyone
	FormatGauntlet   = "gauntlet"   // the first engine plays each of the others
	FormatKnockout   = "knockout"   // the loser of each tie is out
	FormatSwiss      = "swiss"      // a few rounds, engines on like scores meeting
)

// maxEngines is the most engines one tournament takes.
const maxEngines = 32

// knockoutExtras is how many more pairs of games a level knockout tie gets
// before the higher seed goes through.
const knockoutExtras = 3

// unit is a pair of games from one opening between engines a and b, a with
// white in the first.
type unit struct {
	a, b    int
	opening int
	round   int // from 1; 0 in a match
	tie     int // index in the round (knockout, Swiss)
}

// entrant is one engine's results so far.
type entrant struct {
	games, wins, draws, losses int
	points                     float64 // with byes
	bye                        float64 // points from byes
	timeLosses, crashes        int
	out                        bool // knocked out
	reached                    int  // knockout: the last round played in
}

// Cell is one engine's record against another.
type Cell struct {
	Wins   int `json:"wins"`
	Draws  int `json:"draws"`
	Losses int `json:"losses"`
}

// Standing is a row of the table, best first.
type Standing struct {
	Index      int     `json:"index"` // in the order the engines were given
	Name       string  `json:"name"`
	Rank       int     `json:"rank"`
	Games      int     `json:"games"`
	Wins       int     `json:"wins"`
	Draws      int     `json:"draws"`
	Losses     int     `json:"losses"`
	Points     float64 `json:"points"`
	Bye        float64 `json:"bye"`
	Score      float64 `json:"score"` // points per game, 0 to 1
	Elo        float64 `json:"elo"`   // against the engines it met, from its score
	SB         float64 `json:"sb"`    // Sonneborn–Berger
	TimeLosses int     `json:"timeLosses"`
	Crashes    int     `json:"crashes"`
	Out        bool    `json:"out"`
}

// Tie is two engines meeting in a round of a knockout or a Swiss.
type Tie struct {
	A       int     `json:"a"` // engine index, -1: nobody (a bye)
	B       int     `json:"b"`
	PointsA float64 `json:"pointsA"`
	PointsB float64 `json:"pointsB"`
	Games   int     `json:"games"`
	Winner  int     `json:"winner"` // engine index, -1: not decided (or level, in a Swiss)
	Done    bool    `json:"done"`
	Note    string  `json:"note"`
	pending int
	extra   int
}

// Progress is every engine's points as the games went by, for a chart:
// Points[i][k] are engine i's points after Games[k] games in all.
type Progress struct {
	Games  []int       `json:"games"`
	Points [][]float64 `json:"points"`
}

const progressKept = 240

// FormatName is how a format is called in messages.
func FormatName(f string) string {
	switch f {
	case FormatRoundRobin:
		return "Round robin"
	case FormatGauntlet:
		return "Gauntlet"
	case FormatKnockout:
		return "Knockout"
	case FormatSwiss:
		return "Swiss"
	}
	return "Match"
}

// roundRobinRounds pairs n engines so that each meets every other once,
// by the circle method: n-1 rounds (n when n is odd, one engine resting).
func roundRobinRounds(n int) [][][2]int {
	m := n
	if m%2 == 1 {
		m++
	}
	arr := make([]int, m)
	for i := range arr {
		arr[i] = i
	}
	var rounds [][][2]int
	for r := 0; r < m-1; r++ {
		var pairs [][2]int
		for i := 0; i < m/2; i++ {
			a, b := arr[i], arr[m-1-i]
			if a >= n || b >= n {
				continue
			}
			if a > b {
				a, b = b, a
			}
			pairs = append(pairs, [2]int{a, b})
		}
		rounds = append(rounds, pairs)
		last := arr[m-1]
		copy(arr[2:], arr[1:m-1])
		arr[1] = last
	}
	return rounds
}

// bracketOrder seeds a knockout of size (a power of two): 0 meets the last,
// and the two best can only meet in the final.
func bracketOrder(size int) []int {
	order := []int{0}
	for len(order) < size {
		n := len(order) * 2
		next := make([]int, 0, n)
		for _, s := range order {
			next = append(next, s, n-1-s)
		}
		order = next
	}
	return order
}

// plannedGames is how many games the format will play, as far as can be
// told beforehand (a knockout may add games to level ties).
func plannedGames(format string, n, pairGames, rounds int) int {
	switch format {
	case FormatRoundRobin:
		return n * (n - 1) / 2 * pairGames
	case FormatGauntlet:
		return (n - 1) * pairGames
	case FormatKnockout:
		return (n - 1) * pairGames
	case FormatSwiss:
		return rounds * (n / 2) * pairGames
	}
	return 0
}

// setupLocked lays out the tournament's games: all of them for a round robin
// or a gauntlet, the first round for a knockout or a Swiss.
func (t *Tournament) setupLocked() {
	n := len(t.cfg.Engines)
	cycles := t.cfg.PairGames / 2
	t.queue, t.issued, t.bracket, t.finished = nil, 0, nil, 0
	t.ent = make([]entrant, n)
	t.cross = make([][]Cell, n)
	for i := range t.cross {
		t.cross[i] = make([]Cell, n)
	}
	t.progress = Progress{Points: make([][]float64, n)}
	t.st.Round, t.st.Rounds = 0, 0
	switch t.cfg.Format {
	case FormatRoundRobin:
		rounds := roundRobinRounds(n)
		for c := 0; c < cycles; c++ {
			for r, pairs := range rounds {
				for _, p := range pairs {
					a, b := p[0], p[1]
					if c%2 == 1 {
						a, b = b, a
					}
					t.queue = append(t.queue, unit{a: a, b: b, round: c*len(rounds) + r + 1})
				}
			}
		}
		t.st.Rounds = cycles * len(rounds)
	case FormatGauntlet:
		for c := 0; c < cycles; c++ {
			for j := 1; j < n; j++ {
				t.queue = append(t.queue, unit{a: 0, b: j, round: c + 1})
			}
		}
		t.st.Rounds = cycles
	case FormatKnockout:
		size := 1
		for size < n {
			size *= 2
		}
		t.st.Rounds = int(math.Round(math.Log2(float64(size))))
		order := bracketOrder(size)
		seat := func(s int) int {
			if s >= n {
				return -1
			}
			return s
		}
		var ties []*Tie
		for i := 0; i < size; i += 2 {
			ties = append(ties, &Tie{A: seat(order[i]), B: seat(order[i+1]), Winner: -1})
		}
		t.startRoundLocked(ties)
	case FormatSwiss:
		t.st.Rounds = t.cfg.Rounds
		t.startRoundLocked(t.swissPairingLocked())
	}
}

// startRoundLocked begins a round of ties: byes are settled at once and the
// others get their games.
func (t *Tournament) startRoundLocked(ties []*Tie) {
	t.bracket = append(t.bracket, ties)
	round := len(t.bracket)
	t.st.Round = round
	cycles := t.cfg.PairGames / 2
	for i, tie := range ties {
		if tie.A < 0 || tie.B < 0 {
			in := tie.A
			if in < 0 {
				in = tie.B
			}
			tie.Done, tie.Note = true, "bye"
			if in >= 0 {
				tie.Winner = in
				t.ent[in].reached = round
				if t.cfg.Format == FormatSwiss {
					// A bye counts as a drawn round.
					t.ent[in].bye += float64(cycles)
					t.ent[in].points += float64(cycles)
				}
			}
			continue
		}
		t.ent[tie.A].reached, t.ent[tie.B].reached = round, round
		tie.pending = cycles
		for c := 0; c < cycles; c++ {
			a, b := tie.A, tie.B
			if c%2 == 1 {
				a, b = b, a
			}
			t.queue = append(t.queue, unit{a: a, b: b, round: round, tie: i})
		}
	}
}

// swissPairingLocked pairs the engines for the next Swiss round: best
// first, each with the nearest below it that it has not met yet.
func (t *Tournament) swissPairingLocked() []*Tie {
	n := len(t.cfg.Engines)
	order := make([]int, n)
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(x, y int) bool { return t.ent[order[x]].points > t.ent[order[y]].points })
	met := func(a, b int) bool { c := t.cross[a][b]; return c.Wins+c.Draws+c.Losses > 0 }
	used := make([]bool, n)
	var ties []*Tie
	for x, a := range order {
		if used[a] {
			continue
		}
		used[a] = true
		partner := -1
		for _, b := range order[x+1:] {
			if !used[b] && !met(a, b) {
				partner = b
				break
			}
		}
		if partner < 0 {
			for _, b := range order[x+1:] {
				if !used[b] {
					partner = b
					break
				}
			}
		}
		if partner >= 0 {
			used[partner] = true
		}
		ties = append(ties, &Tie{A: a, B: partner, Winner: -1})
	}
	return ties
}

// refillLocked gives the queue more games when it has run out: the next
// pair of a match, or the next round once every game of this one is over.
func (t *Tournament) refillLocked() {
	switch t.cfg.Format {
	case FormatMatch:
		if t.pairs == 0 || t.nextPair < t.pairs {
			t.queue = append(t.queue, unit{a: 0, b: 1})
		}
	case FormatKnockout:
		if t.issued > 0 || len(t.bracket) == 0 {
			return
		}
		last := t.bracket[len(t.bracket)-1]
		if len(last) == 1 {
			return // the final has been played
		}
		var ties []*Tie
		for i := 0; i+1 < len(last); i += 2 {
			ties = append(ties, &Tie{A: last[i].Winner, B: last[i+1].Winner, Winner: -1})
		}
		t.startRoundLocked(ties)
	case FormatSwiss:
		if t.issued > 0 || len(t.bracket) >= t.cfg.Rounds {
			return
		}
		t.startRoundLocked(t.swissPairingLocked())
	}
}

// takeUnit gives a worker its next pair of games, waiting for a round to
// end when the next one depends on it; false when there is nothing left.
func (t *Tournament) takeUnit() (unit, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for {
		if t.st.State != "running" {
			return unit{}, false
		}
		if t.paused {
			// Paused: no new pair starts until it is resumed (or stopped).
			t.cond.Wait()
			continue
		}
		if len(t.queue) == 0 {
			t.refillLocked()
		}
		if len(t.queue) > 0 {
			u := t.queue[0]
			t.queue = t.queue[1:]
			u.opening = t.nextPair
			t.nextPair++
			t.issued++
			if u.round > t.st.Round {
				t.st.Round = u.round
			}
			return u, true
		}
		if t.issued == 0 {
			t.cond.Broadcast() // nothing left: the others can go too
			return unit{}, false
		}
		t.cond.Wait()
	}
}

// finishUnit takes a pair of games back: points are a's, of 2. A pair that
// was cut short (complete false) counts for nothing.
func (t *Tournament) finishUnit(u unit, complete bool, points float64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.issued--
	defer t.cond.Broadcast()
	if u.round == 0 || u.round > len(t.bracket) || u.tie >= len(t.bracket[u.round-1]) {
		return
	}
	tie := t.bracket[u.round-1][u.tie]
	tie.pending--
	if complete {
		if u.a == tie.A {
			tie.PointsA += points
			tie.PointsB += 2 - points
		} else {
			tie.PointsB += points
			tie.PointsA += 2 - points
		}
		tie.Games += 2
	}
	if tie.pending > 0 || tie.Done {
		return
	}
	switch {
	case tie.PointsA > tie.PointsB:
		tie.Winner = tie.A
	case tie.PointsB > tie.PointsA:
		tie.Winner = tie.B
	}
	if t.cfg.Format == FormatSwiss {
		tie.Done = true
		return
	}
	// A knockout tie must have a winner.
	if tie.Winner < 0 {
		if tie.extra < knockoutExtras && t.st.State == "running" {
			tie.extra++
			tie.pending++
			a, b := tie.A, tie.B
			if tie.extra%2 == 1 {
				a, b = b, a
			}
			t.queue = append(t.queue, unit{a: a, b: b, round: u.round, tie: u.tie})
			tie.Note = "level: playing on"
			return
		}
		tie.Winner = tie.A
		if tie.B < tie.A {
			tie.Winner = tie.B
		}
		tie.Note = "level: the higher seed goes through"
	} else if tie.extra > 0 {
		tie.Note = "after extra games"
	}
	tie.Done = true
	loser := tie.A
	if tie.Winner == tie.A {
		loser = tie.B
	}
	t.ent[loser].out = true
}

// countLocked adds a finished game to the engines' records. White and black
// are engine indexes.
func (t *Tournament) countLocked(white, black int, res gameResult) {
	w, b := &t.ent[white], &t.ent[black]
	w.games++
	b.games++
	loser := -1
	switch res.Result {
	case "1-0":
		w.wins++
		b.losses++
		w.points++
		t.cross[white][black].Wins++
		t.cross[black][white].Losses++
		loser = black
	case "0-1":
		b.wins++
		w.losses++
		b.points++
		t.cross[black][white].Wins++
		t.cross[white][black].Losses++
		loser = white
	default:
		w.draws++
		b.draws++
		w.points += 0.5
		b.points += 0.5
		t.cross[white][black].Draws++
		t.cross[black][white].Draws++
	}
	if loser >= 0 {
		if res.TimeOut {
			t.ent[loser].timeLosses++
		}
		if res.Crashed {
			t.ent[loser].crashes++
		}
	}
	t.finished++
	p := &t.progress
	p.Games = append(p.Games, t.finished)
	for i := range p.Points {
		p.Points[i] = append(p.Points[i], t.ent[i].points)
	}
	if len(p.Games) > 2*progressKept {
		// Keep every other sample, the latest among them.
		half := func(n int) []int {
			var keep []int
			for k := n - 1; k >= 0; k -= 2 {
				keep = append(keep, k)
			}
			sort.Ints(keep)
			return keep
		}
		keep := half(len(p.Games))
		games := make([]int, len(keep))
		for x, k := range keep {
			games[x] = p.Games[k]
		}
		p.Games = games
		for i := range p.Points {
			pts := make([]float64, len(keep))
			for x, k := range keep {
				pts[x] = p.Points[i][k]
			}
			p.Points[i] = pts
		}
	}
}

// standingsLocked is the table, best first.
func (t *Tournament) standingsLocked() []Standing {
	n := len(t.ent)
	out := make([]Standing, n)
	for i, e := range t.ent {
		s := Standing{
			Index: i, Name: t.cfg.Engines[i].Name, Games: e.games, Wins: e.wins, Draws: e.draws, Losses: e.losses,
			Points: e.points, Bye: e.bye, TimeLosses: e.timeLosses, Crashes: e.crashes, Out: e.out,
		}
		if e.games > 0 {
			s.Score = (e.points - e.bye) / float64(e.games)
			s.Elo = eloOf(math.Min(0.99, math.Max(0.01, s.Score)))
		}
		for j := range t.ent {
			c := t.cross[i][j]
			s.SB += (float64(c.Wins) + float64(c.Draws)/2) * t.ent[j].points
		}
		out[i] = s
	}
	knockout := t.cfg.Format == FormatKnockout
	sort.SliceStable(out, func(x, y int) bool {
		a, b := out[x], out[y]
		if knockout {
			// Still in beats out; then the round reached.
			if a.Out != b.Out {
				return !a.Out
			}
			if ra, rb := t.ent[a.Index].reached, t.ent[b.Index].reached; ra != rb {
				return ra > rb
			}
		}
		if a.Points != b.Points {
			return a.Points > b.Points
		}
		if a.SB != b.SB {
			return a.SB > b.SB
		}
		if a.Wins != b.Wins {
			return a.Wins > b.Wins
		}
		return a.Index < b.Index
	})
	for i := range out {
		out[i].Rank = i + 1
	}
	return out
}

// bracketLocked copies the rounds of ties for the status.
func (t *Tournament) bracketLocked() [][]Tie {
	out := make([][]Tie, len(t.bracket))
	for r, ties := range t.bracket {
		out[r] = make([]Tie, len(ties))
		for i, tie := range ties {
			out[r][i] = *tie
		}
	}
	return out
}

// crossLocked copies the head-to-head records.
func (t *Tournament) crossLocked() [][]Cell {
	out := make([][]Cell, len(t.cross))
	for i, row := range t.cross {
		out[i] = append([]Cell(nil), row...)
	}
	return out
}

// progressLocked copies the points history.
func (t *Tournament) progressLocked() Progress {
	p := Progress{Games: append([]int(nil), t.progress.Games...), Points: make([][]float64, len(t.progress.Points))}
	for i, pts := range t.progress.Points {
		p.Points[i] = append([]float64(nil), pts...)
	}
	return p
}

// winnerLocked names who came first, for the closing message.
func (t *Tournament) winnerLocked() string {
	table := t.standingsLocked()
	if len(table) == 0 || t.finished == 0 {
		return ""
	}
	first := table[0]
	if t.cfg.Format != FormatKnockout && len(table) > 1 && table[1].Points == first.Points && table[1].SB == first.SB {
		return fmt.Sprintf("%s and %s share first place with %s points", first.Name, table[1].Name, pointsText(first.Points))
	}
	if t.cfg.Format == FormatKnockout {
		return fmt.Sprintf("%s wins the knockout", first.Name)
	}
	return fmt.Sprintf("%s wins with %s of %d", first.Name, pointsText(first.Points-first.Bye), first.Games)
}

func pointsText(p float64) string {
	whole := int(math.Floor(p))
	if p-float64(whole) >= 0.5 {
		if whole == 0 {
			return "½"
		}
		return fmt.Sprintf("%d½", whole)
	}
	return fmt.Sprint(whole)
}
