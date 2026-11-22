package review

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"board/backend/chess"
)

func TestReview(t *testing.T) {
	dir := t.TempDir()
	eng := filepath.Join(dir, "basicengine")
	if out, err := exec.Command("go", "build", "-o", eng, "../cmd/basicengine").CombinedOutput(); err != nil {
		t.Fatal(string(out))
	}
	done := make(chan Progress, 100)
	r := New(func(ev string, d any) {
		p := d.(Progress)
		if p.State != "running" {
			done <- p
		}
	})
	// Scholar's mate: 1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6?? 4. Qxf7#.
	moves := []string{"e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"}
	err := r.Start(Request{Key: "k", Engine: Engine{Name: "Basic", Path: eng}, StartFEN: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", Moves: moves, MoveTimeMs: 150})
	if err != nil {
		t.Fatal(err)
	}
	var p Progress
	select {
	case p = <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("timeout")
	}
	if p.State != "done" || p.Result == nil {
		t.Fatalf("%+v", p)
	}
	res := p.Result
	if len(res.Positions) != 8 || len(res.Judgments) != 7 {
		t.Fatalf("%d positions %d judgments", len(res.Positions), len(res.Judgments))
	}
	if res.Positions[7].Final != "checkmate" || res.Positions[7].CP != 10000 {
		t.Fatalf("final %+v", res.Positions[7])
	}
	nf6 := res.Judgments[5]
	if nf6.Kind != "blunder" || nf6.Glyph != "??" || nf6.Best == "" {
		t.Fatalf("Nf6 should be a blunder with a better move: %+v", nf6)
	}
	if res.Black.Blunders < 1 || res.White.Accuracy <= res.Black.Accuracy {
		t.Fatalf("white %+v black %+v", res.White, res.Black)
	}
	t.Logf("white %+v black %+v; Nf6: %+v", res.White, res.Black, nf6)
}

// An analysis stopped early reports the moves it got through.
func TestStoppedReviewKeepsResults(t *testing.T) {
	dir := t.TempDir()
	eng := filepath.Join(dir, "basicengine")
	if out, err := exec.Command("go", "build", "-o", eng, "../cmd/basicengine").CombinedOutput(); err != nil {
		t.Fatal(string(out))
	}
	events := make(chan Progress, 100)
	r := New(func(ev string, d any) { events <- d.(Progress) })
	moves := []string{"e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6"}
	err := r.Start(Request{Key: "k", Engine: Engine{Name: "Basic", Path: eng}, StartFEN: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", Moves: moves, MoveTimeMs: 300})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.After(30 * time.Second)
	for {
		var p Progress
		select {
		case p = <-events:
		case <-deadline:
			t.Fatal("timeout")
		}
		if p.State == "running" && p.Done == 3 {
			r.Stop()
			continue
		}
		if p.State == "running" {
			continue
		}
		if p.State != "stopped" || p.Result == nil {
			t.Fatalf("%+v", p)
		}
		n := len(p.Result.Positions)
		if n < 3 || n >= len(moves)+1 || len(p.Result.Judgments) != n-1 || p.Done != n || p.Total != len(moves)+1 {
			t.Fatalf("%d positions, %d judgments, done %d of %d", n, len(p.Result.Judgments), p.Done, p.Total)
		}
		if p.Result.White.Moves+p.Result.Black.Moves != n-1 {
			t.Fatalf("sides cover %d moves, want %d", p.Result.White.Moves+p.Result.Black.Moves, n-1)
		}
		// Continuing picks up after the positions it had.
		kept := p.Result.Positions
		err = r.Start(Request{Key: "k", Engine: Engine{Name: "Basic", Path: eng}, StartFEN: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", Moves: moves, MoveTimeMs: 100, Resume: kept})
		if err != nil {
			t.Fatal(err)
		}
		first := 0
		for {
			select {
			case p = <-events:
			case <-deadline:
				t.Fatal("timeout")
			}
			if p.State == "running" {
				if first == 0 {
					first = p.Done
				}
				continue
			}
			break
		}
		if first != n {
			t.Fatalf("resumed at %d, want %d", first, n)
		}
		if p.State != "done" || len(p.Result.Positions) != len(moves)+1 || len(p.Result.Judgments) != len(moves) {
			t.Fatalf("%+v", p)
		}
		for i := range kept {
			if p.Result.Positions[i].CP != kept[i].CP || p.Result.Positions[i].Best != kept[i].Best {
				t.Fatalf("position %d was analysed again", i)
			}
		}
		return
	}
}

// Each position is reported once, as soon as it is analysed, with the
// judgment of each move next to it whose two positions are now known; the
// moves are judged once each, as in the final result. With a swarm they
// come in any order.
func TestReviewStreamsJudgments(t *testing.T) {
	dir := t.TempDir()
	eng := filepath.Join(dir, "basicengine")
	if out, err := exec.Command("go", "build", "-o", eng, "../cmd/basicengine").CombinedOutput(); err != nil {
		t.Fatal(string(out))
	}
	moves := []string{"e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"}
	for _, swarm := range []int{1, 4} {
		events := make(chan Progress, 100)
		r := New(func(ev string, d any) { events <- d.(Progress) })
		if err := r.Start(Request{Key: "k", Engine: Engine{Name: "Basic", Path: eng}, StartFEN: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", Moves: moves, MoveTimeMs: 100, Swarm: swarm}); err != nil {
			t.Fatal(err)
		}
		positions := map[int]Position{}
		judged := map[int]Judgment{}
		var order []int
		for done := false; !done; {
			var p Progress
			select {
			case p = <-events:
			case <-time.After(30 * time.Second):
				t.Fatal("timeout")
			}
			if p.State == "running" {
				if p.Position == nil || p.Ply == nil {
					t.Fatalf("swarm %d: running event without its position: %+v", swarm, p)
				}
				ply := *p.Ply
				if _, ok := positions[ply]; ok {
					t.Fatalf("swarm %d: position %d twice", swarm, ply)
				}
				positions[ply] = *p.Position
				order = append(order, ply)
				if p.Done != len(positions) {
					t.Fatalf("swarm %d: done %d with %d positions", swarm, p.Done, len(positions))
				}
				for _, j := range p.MoveJudgments {
					_, before := positions[j.Ply-1]
					_, after := positions[j.Ply]
					_, twice := judged[j.Ply]
					if !before || !after || twice || (j.Ply != ply && j.Ply != ply+1) {
						t.Fatalf("swarm %d: judgment of move %d with position %d", swarm, j.Ply, ply)
					}
					judged[j.Ply] = j
				}
				continue
			}
			if p.State != "done" {
				t.Fatalf("swarm %d: %+v", swarm, p)
			}
			for i, want := range p.Positions {
				if !reflect.DeepEqual(positions[i], want) {
					t.Fatalf("swarm %d: position %d streamed %+v, final %+v", swarm, i, positions[i], want)
				}
			}
			for _, want := range p.Result.Judgments {
				if !reflect.DeepEqual(judged[want.Ply], want) {
					t.Fatalf("swarm %d: move %d streamed %+v, final %+v", swarm, want.Ply, judged[want.Ply], want)
				}
			}
			if len(positions) != len(moves)+1 || len(judged) != len(moves) {
				t.Fatalf("swarm %d: %d positions, %d judged", swarm, len(positions), len(judged))
			}
			done = true
		}
		t.Logf("swarm %d: positions in the order %v", swarm, order)
	}
}

// runTo runs an analysis to its end: the last event, and how many
// positions were searched (counted from the engine's own "go" commands, by
// the running events' Searched).
func runTo(t *testing.T, r *Reviewer, events chan Progress, req Request) Progress {
	t.Helper()
	if err := r.Start(req); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(60 * time.Second)
	for {
		select {
		case p := <-events:
			if p.State != "running" {
				return p
			}
		case <-deadline:
			t.Fatal("timeout")
		}
	}
}

// Positions analysed once are not searched again: not when moves are added,
// nor run again, nor after a move is changed; but they are with more time a
// move or another engine. The cache file carries them to a new run of the app.
func TestReviewReusesPositions(t *testing.T) {
	dir := t.TempDir()
	eng := filepath.Join(dir, "basicengine")
	if out, err := exec.Command("go", "build", "-o", eng, "../cmd/basicengine").CombinedOutput(); err != nil {
		t.Fatal(string(out))
	}
	events := make(chan Progress, 200)
	emit := func(ev string, d any) { events <- d.(Progress) }
	r := New(emit)
	cacheFile := filepath.Join(dir, "cache", "review.json")
	r.UseCacheFile(cacheFile)
	const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
	moves := []string{"e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"} // ends in mate
	req := func(m []string, ms int, path string) Request {
		return Request{Key: "k", Engine: Engine{Name: "Basic", Path: path}, StartFEN: start, Moves: m, MoveTimeMs: ms}
	}
	check := func(name string, p Progress, reused, searched int) {
		t.Helper()
		if p.State != "done" || p.Reused != reused || p.Searched != searched {
			t.Fatalf("%s: %s, reused %d searched %d, want %d and %d", name, p.State, p.Reused, p.Searched, reused, searched)
		}
	}
	// The first four moves: five positions searched.
	check("first moves", runTo(t, r, events, req(moves[:4], 100, eng)), 0, 5)
	// The whole game is not analysed yet; once it is, it counts as analysed.
	startPos, _ := chess.ParseFEN(start)
	var mvs []chess.Move
	for p, i := startPos, 0; i < len(moves); i++ {
		mv, _ := p.ParseUCIMove(moves[i])
		mvs = append(mvs, mv)
		p = p.Make(mv)
	}
	if by := r.AnalysedBy(SearchFENs(startPos, mvs)); by != "" {
		t.Fatalf("analysed by %q after four moves", by)
	}
	// The whole game: only the three new positions that need a search (the
	// last is mate on the board).
	full := runTo(t, r, events, req(moves, 100, eng))
	check("moves added", full, 5, 2)
	if by := r.AnalysedBy(SearchFENs(startPos, mvs)); by != "Basic" {
		t.Fatalf("analysed by %q, want Basic", by)
	}
	// Again, or with less time a move: nothing searched, the same result.
	again := runTo(t, r, events, req(moves, 50, eng))
	check("again", again, 7, 0)
	if !reflect.DeepEqual(again.Result.Positions, full.Result.Positions) || !reflect.DeepEqual(again.Result.Judgments, full.Result.Judgments) || again.White != full.White || again.Black != full.Black {
		t.Fatal("a result from the cache differs")
	}
	// A move changed: the six positions before it are known; after it, one
	// to search and a mate.
	changed := append(append([]string(nil), moves[:5]...), "d7d6", "h5f7")
	check("move changed", runTo(t, r, events, req(changed, 100, eng)), 6, 1)
	// More time a move: all searched again.
	check("more time", runTo(t, r, events, req(moves, 200, eng)), 0, 7)
	// Another engine (a copy of the program is another file).
	other := filepath.Join(dir, "other")
	b, _ := os.ReadFile(eng)
	if err := os.WriteFile(other, b, 0o755); err != nil {
		t.Fatal(err)
	}
	check("other engine", runTo(t, r, events, req(moves, 100, other)), 0, 7)
	// A new run of the app finds them in the file: the 200 ms search
	// stands in for one of 100 ms.
	r2 := New(emit)
	r2.UseCacheFile(cacheFile)
	check("from the file", runTo(t, r2, events, req(moves, 100, eng)), 7, 0)
}

// A swarm stopped part-way keeps the moves up to the first position not
// done; the positions done after it are in the cache, so carrying on
// searches only what no engine finished.
func TestSwarmStopped(t *testing.T) {
	dir := t.TempDir()
	eng := filepath.Join(dir, "basicengine")
	if out, err := exec.Command("go", "build", "-o", eng, "../cmd/basicengine").CombinedOutput(); err != nil {
		t.Fatal(string(out))
	}
	events := make(chan Progress, 200)
	r := New(func(ev string, d any) { events <- d.(Progress) })
	moves := []string{"e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7", "f1e1", "b7b5"}
	req := Request{Key: "k", Engine: Engine{Name: "Basic", Path: eng}, StartFEN: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", Moves: moves, MoveTimeMs: 200, Swarm: 3}
	if err := r.Start(req); err != nil {
		t.Fatal(err)
	}
	seen := map[int]bool{}
	var p Progress
	for {
		select {
		case p = <-events:
		case <-time.After(30 * time.Second):
			t.Fatal("timeout")
		}
		if p.State != "running" {
			break
		}
		seen[*p.Ply] = true
		if p.Done == 6 {
			r.Stop()
		}
	}
	if p.State != "stopped" || p.Result == nil {
		t.Fatalf("%+v", p)
	}
	k := len(p.Result.Positions)
	for i := 0; i < k; i++ {
		if !seen[i] {
			t.Fatalf("position %d kept but not analysed", i)
		}
	}
	if seen[k] || len(p.Result.Judgments) != k-1 {
		t.Fatalf("kept %d positions (with %d judgments) though %d was done too", k, len(p.Result.Judgments), k)
	}
	// Carrying on: what was done, before the gap or after it, is not searched again.
	again := runTo(t, r, events, req)
	if again.State != "done" || again.Reused != len(seen) || again.Searched != len(moves)+1-len(seen) {
		t.Fatalf("%d done before; now reused %d, searched %d", len(seen), again.Reused, again.Searched)
	}
	t.Logf("stopped with %v, kept %d; carrying on searched %d", seen, k, again.Searched)
}
