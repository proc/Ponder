package tournament

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestRoundRobinRounds(t *testing.T) {
	for n := 2; n <= 9; n++ {
		met := map[[2]int]int{}
		for _, round := range roundRobinRounds(n) {
			busy := map[int]bool{}
			for _, p := range round {
				if busy[p[0]] || busy[p[1]] || p[0] >= p[1] {
					t.Fatalf("n=%d: bad round %v", n, round)
				}
				busy[p[0]], busy[p[1]] = true, true
				met[p]++
			}
		}
		if len(met) != n*(n-1)/2 {
			t.Fatalf("n=%d: %d pairings", n, len(met))
		}
		for p, k := range met {
			if k != 1 {
				t.Fatalf("n=%d: %v met %d times", n, p, k)
			}
		}
	}
}

func TestBracketOrder(t *testing.T) {
	if got := fmt.Sprint(bracketOrder(8)); got != "[0 7 3 4 1 6 2 5]" {
		t.Fatal(got)
	}
}

func field(n int) []EngineSpec {
	var out []EngineSpec
	for i := 0; i < n; i++ {
		out = append(out, EngineSpec{Name: string(rune('A' + i)), Path: randomEngine})
	}
	return out
}

func quick(format string, n int) Config {
	return Config{
		Engines: field(n), Format: format, PairGames: 2,
		TimeControl: TimeControl{BaseMs: 2000, IncMs: 20}, Concurrency: 4,
		Openings: OpeningConfig{Source: "book", Plies: 6}, Adjudication: Adjudication{MaxMoves: 40},
		PGNPath: "games.pgn",
	}
}

// sums checks that the table and the head-to-head records agree.
func sums(t *testing.T, s Status) {
	t.Helper()
	games, points := 0, 0.0
	for _, p := range s.Players {
		games += p.Games
		points += p.Points - p.Bye
		if p.Wins+p.Draws+p.Losses != p.Games {
			t.Fatalf("%s: %+v", p.Name, p)
		}
		row := Cell{}
		for _, c := range s.Cross[p.Index] {
			row.Wins += c.Wins
			row.Draws += c.Draws
			row.Losses += c.Losses
		}
		if row.Wins != p.Wins || row.Draws != p.Draws || row.Losses != p.Losses {
			t.Fatalf("%s: table %+v, head to head %+v", p.Name, p, row)
		}
	}
	if games != 2*s.Games || points != float64(s.Games) {
		t.Fatalf("games %d (table %d), points %v", s.Games, games, points)
	}
	if n := len(s.Progress.Games); n == 0 || s.Progress.Games[n-1] != s.Games || len(s.Progress.Points) != len(s.Players) {
		t.Fatalf("progress %+v", s.Progress.Games)
	}
}

func TestRoundRobin(t *testing.T) {
	r := &recorder{}
	tr := newT(r)
	c := quick(FormatRoundRobin, 4)
	c.PairGames = 4
	if err := tr.Start(c); err != nil {
		t.Fatal(err)
	}
	s := waitDone(t, tr, 120*time.Second)
	if s.Games != 24 || s.Total != 24 || s.Rounds != 6 || s.Format != FormatRoundRobin || len(s.Players) != 4 {
		t.Fatalf("games %d total %d rounds %d", s.Games, s.Total, s.Rounds)
	}
	sums(t, s)
	for i := 0; i < 4; i++ {
		for j := 0; j < 4; j++ {
			c := s.Cross[i][j]
			if want := map[bool]int{true: 0, false: 4}[i == j]; c.Wins+c.Draws+c.Losses != want {
				t.Fatalf("%d v %d: %+v", i, j, c)
			}
		}
	}
	if !strings.Contains(s.Message, "24 games played") || s.Players[0].Rank != 1 {
		t.Fatalf("message %q", s.Message)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.saved) != 24 || !strings.Contains(r.saved[0], `[Event "Round robin, 4 engines"]`) || !strings.Contains(strings.Join(r.saved, ""), `[Round "1.`) || !strings.Contains(strings.Join(r.saved, ""), `[Round "6.`) {
		t.Fatalf("%d saved; first:\n%s", len(r.saved), r.saved[0])
	}
}

func TestGauntlet(t *testing.T) {
	tr := newT(&recorder{})
	if err := tr.Start(quick(FormatGauntlet, 4)); err != nil {
		t.Fatal(err)
	}
	s := waitDone(t, tr, 60*time.Second)
	sums(t, s)
	if s.Games != 6 {
		t.Fatalf("games %d", s.Games)
	}
	for _, p := range s.Players {
		if want := map[bool]int{true: 6, false: 2}[p.Index == 0]; p.Games != want {
			t.Fatalf("%s played %d", p.Name, p.Games)
		}
	}
}

func TestKnockout(t *testing.T) {
	tr := newT(&recorder{})
	if err := tr.Start(quick(FormatKnockout, 5)); err != nil {
		t.Fatal(err)
	}
	s := waitDone(t, tr, 120*time.Second)
	sums(t, s)
	// Five engines: a bracket of eight, three byes, then two rounds more.
	if len(s.Bracket) != 3 || len(s.Bracket[0]) != 4 || len(s.Bracket[1]) != 2 || len(s.Bracket[2]) != 1 || s.Rounds != 3 {
		t.Fatalf("bracket %+v", s.Bracket)
	}
	byes, out := 0, 0
	for _, tie := range s.Bracket[0] {
		if tie.Note == "bye" {
			byes++
		}
	}
	for _, round := range s.Bracket {
		for _, tie := range round {
			if !tie.Done || tie.Winner < 0 || (tie.Winner != tie.A && tie.Winner != tie.B) {
				t.Fatalf("tie %+v", tie)
			}
			if tie.Note != "bye" && tie.Games < 2 {
				t.Fatalf("tie without games %+v", tie)
			}
		}
	}
	for _, p := range s.Players {
		if p.Out {
			out++
		}
	}
	final := s.Bracket[2][0]
	if byes != 3 || out != 4 || s.Players[0].Out || s.Players[0].Index != final.Winner || !strings.Contains(s.Message, "wins the knockout") {
		t.Fatalf("byes %d out %d first %+v final %+v: %s", byes, out, s.Players[0], final, s.Message)
	}
}

func TestSwiss(t *testing.T) {
	tr := newT(&recorder{})
	c := quick(FormatSwiss, 5)
	if err := tr.Start(c); err != nil {
		t.Fatal(err)
	}
	s := waitDone(t, tr, 120*time.Second)
	sums(t, s)
	// Five engines: three rounds of two ties and a bye.
	if s.Rounds != 3 || len(s.Bracket) != 3 || s.Games != 12 || s.Total != 12 {
		t.Fatalf("rounds %d bracket %d games %d total %d", s.Rounds, len(s.Bracket), s.Games, s.Total)
	}
	byes := map[int]int{}
	for _, round := range s.Bracket {
		seen := map[int]bool{}
		for _, tie := range round {
			for _, e := range []int{tie.A, tie.B} {
				if e >= 0 {
					if seen[e] {
						t.Fatalf("engine %d twice in a round: %+v", e, round)
					}
					seen[e] = true
				}
			}
			if tie.B < 0 {
				byes[tie.A]++
			}
		}
		if len(seen) != 5 {
			t.Fatalf("round %+v", round)
		}
	}
	total := 0
	for _, p := range s.Players {
		total += int(p.Bye)
	}
	if len(byes) != 3 && total != 3 {
		t.Fatalf("byes %v, points %d", byes, total)
	}
}

func TestFormatsAreChecked(t *testing.T) {
	tr := newT(&recorder{})
	c := quick(FormatMatch, 3)
	if err := tr.Start(c); err == nil || !strings.Contains(err.Error(), "two engines") {
		t.Fatalf("a match of three: %v", err)
	}
	c = quick("ladder", 3)
	if err := tr.Start(c); err == nil {
		t.Fatal("unknown format accepted")
	}
	c = quick(FormatRoundRobin, 1)
	if err := tr.Start(c); err == nil {
		t.Fatal("one engine accepted")
	}
}

func TestStopWhileWaitingForARound(t *testing.T) {
	tr := newT(&recorder{})
	c := quick(FormatKnockout, 4)
	c.Concurrency = 8 // more workers than ties: some wait for the round
	c.TimeControl = TimeControl{BaseMs: 60000}
	c.Adjudication = Adjudication{}
	if err := tr.Start(c); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	tr.Stop()
	s := waitDone(t, tr, 20*time.Second)
	if s.Message != "Stopped" {
		t.Fatalf("message %q", s.Message)
	}
}
