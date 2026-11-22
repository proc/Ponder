package pgn

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

const threeGames = `[Event "One"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 {a comment [with brackets]} Nc6 1-0

[Event "Two"]
[White "Carol \"C\" Jones"]
[Black "Dave"]
[Result "0-1"]

1. d4 d5 0-1

[Event "Three"]
[White "Erin"]
[Black "Frank"]
[Result "1/2-1/2"]

1. c4 c5 1/2-1/2
`

func openText(t *testing.T, text string) *Collection {
	t.Helper()
	path := filepath.Join(t.TempDir(), "games.pgn")
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := Open(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func reopen(t *testing.T, c *Collection) *Collection {
	t.Helper()
	n, err := Open(c.Path, nil)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func whites(c *Collection) string {
	var out []string
	for i := 0; i < c.Len(); i++ {
		out = append(out, c.Entry(i).White)
	}
	return strings.Join(out, ",")
}

func TestRewriteDeletesAndReplaces(t *testing.T) {
	c := openText(t, threeGames)
	if c.Len() != 3 {
		t.Fatalf("%d games", c.Len())
	}
	// Delete the middle game.
	if err := c.Rewrite(map[int]*string{1: nil}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Read(0); err == nil {
		t.Fatal("the old index still reads the changed file")
	}
	c = reopen(t, c)
	if whites(c) != "Alice,Erin" {
		t.Fatalf("after deleting: %s", whites(c))
	}
	if info, _ := os.Stat(c.Path); info.Mode().Perm() != 0o600 {
		t.Fatalf("file mode %v", info.Mode().Perm())
	}
	// The other games are as they were, comments and all.
	g, err := c.Read(0)
	if err != nil || len(g.Moves) != 4 {
		t.Fatalf("first game: %v %+v", err, g)
	}
	// Change the last game's tags.
	text, err := c.Raw(1)
	if err != nil {
		t.Fatal(err)
	}
	text, err = SetTags(text, []Tag{{"White", `Erin "E" O\Hara`}, {"WhiteElo", "2100"}, {"Result", "1-0"}, {"Black", ""}})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Rewrite(map[int]*string{1: &text}); err != nil {
		t.Fatal(err)
	}
	c = reopen(t, c)
	g, err = c.Read(1)
	if err != nil {
		t.Fatal(err)
	}
	if g.Tag("White") != `Erin "E" O\Hara` || g.Tag("WhiteElo") != "2100" || g.Tag("Result") != "1-0" || g.Tag("Black") != "?" || g.Tag("Event") != "Three" {
		t.Fatalf("tags %+v", g.Tags)
	}
	if e := c.Entry(1); e.Result != "1-0" || e.Plies != 2 {
		t.Fatalf("entry %+v", e)
	}
	data, _ := os.ReadFile(c.Path)
	if !strings.HasSuffix(strings.TrimSpace(string(data)), "1. c4 c5 1-0") {
		t.Fatalf("the result after the moves was not changed:\n%s", data)
	}
	// Delete everything.
	if err := c.Rewrite(map[int]*string{0: nil, 1: nil}); err != nil {
		t.Fatal(err)
	}
	if c = reopen(t, c); c.Len() != 0 {
		t.Fatalf("%d games left", c.Len())
	}
	left, _ := filepath.Glob(filepath.Join(filepath.Dir(c.Path), "*"))
	if len(left) != 1 {
		t.Fatalf("files left behind: %v", left)
	}
}

func TestSetTags(t *testing.T) {
	// A tag that can go is taken out; unknown ones are kept; a new one is added after the tags.
	text := "[Event \"E\"]\r\n[Annotator \"me\"]\r\n[WhiteElo \"1500\"]\r\n\r\n1. e4 *\r\n"
	got, err := SetTags(text, []Tag{{"WhiteElo", ""}, {"Site", "Here"}, {"Result", "1/2-1/2"}})
	if err != nil {
		t.Fatal(err)
	}
	want := "[Event \"E\"]\r\n[Annotator \"me\"]\r\n[Site \"Here\"]\r\n[Result \"1/2-1/2\"]\r\n\r\n1. e4 1/2-1/2\r\n"
	if got != want {
		t.Fatalf("got %q\nwant %q", got, want)
	}
	// Moves alone get their tags, and a result.
	got, err = SetTags("1. e4 e5\n", []Tag{{"White", "A"}, {"Result", "1-0"}})
	if err != nil || got != "[White \"A\"]\n[Result \"1-0\"]\n\n1. e4 e5 1-0\n\n" {
		t.Fatalf("got %q %v", got, err)
	}
	if games, err := Parse(got); err != nil || len(games) != 1 || games[0].Tag("White") != "A" {
		t.Fatalf("parsed %+v %v", games, err)
	}
	for _, bad := range [][]Tag{{{"Result", "2-0"}}, {{"Bad Name", "x"}}, {{"", "x"}}} {
		if _, err := SetTags(threeGames, bad); err == nil {
			t.Errorf("%+v was accepted", bad)
		}
	}
	// A value on several lines becomes one line.
	got, _ = SetTags("[Event \"E\"]\n\n*\n", []Tag{{"Event", "a\n[b]  c"}})
	if !strings.HasPrefix(got, "[Event \"a [b] c\"]\n") {
		t.Fatalf("got %q", got)
	}
}

func TestExportMatchAndShared(t *testing.T) {
	c := openText(t, threeGames)
	var out strings.Builder
	n, err := c.Export(&out, c.Select(Query{Words: []string{"1-0"}}))
	if err != nil || n != 1 {
		t.Fatalf("exported %d %v", n, err)
	}
	if games, err := Parse(out.String()); err != nil || len(games) != 1 || games[0].Tag("White") != "Alice" {
		t.Fatalf("export %q %v", out.String(), err)
	}
	out.Reset()
	if n, _ := c.Export(&out, c.Select(Query{})); n != 3 {
		t.Fatalf("exported %d", n)
	}
	if games, _ := Parse(out.String()); len(games) != 3 {
		t.Fatalf("export has %d games", len(games))
	}
	if c.Changed() {
		t.Fatal("unchanged file reported as changed")
	}
	os.WriteFile(c.Path, []byte(threeGames+"\n[Event \"Four\"]\n\n1. e4 *\n"), 0o600)
	if !c.Changed() {
		t.Fatal("change not noticed")
	}
	if err := c.Rewrite(map[int]*string{0: nil}); err == nil {
		t.Fatal("rewrote a file that changed since it was read")
	}

	// Two games with no tags between them share their text.
	c = openText(t, "1. e4 e5 1-0 1. d4 d5 0-1\n\n[Event \"Own\"]\n\n1. c4 *\n")
	if c.Len() != 3 {
		t.Fatalf("%d games", c.Len())
	}
	if err := c.Rewrite(map[int]*string{0: nil}); err == nil {
		t.Fatal("deleted one of two games that share their text")
	}
	if err := c.Rewrite(map[int]*string{2: nil}); err != nil {
		t.Fatal(err)
	}
	if c = reopen(t, c); c.Len() != 2 {
		t.Fatalf("%d games", c.Len())
	}
}

const searchGames = `[Event "Open A"]
[Date "2023.12.30"]
[Round "2"]
[White "Carlsen, Magnus"]
[Black "Nakamura"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 1-0

[Event "Open B"]
[Date "2024.05.??"]
[Round "10"]
[White "nakamura"]
[Black "Caruana"]
[Result "1/2-1/2"]

1. d4 d5 1/2-1/2

[Event "Open A"]
[Date "2024.06.15"]
[Round "1"]
[White "Ding"]
[Black "Carlsen, Magnus"]
[Result "0-1"]

1. c4 c5 2. Nc3 Nc6 3. g3 g6 4. Bg2 Bg7 0-1

[Event "Skittles"]
[White "Anon"]
[Black "Other"]
[Result "*"]

1. e4 *
`

func TestSearchAndSort(t *testing.T) {
	c := openText(t, searchGames)
	pick := func(q Query) string {
		var out []string
		for _, i := range c.Select(q) {
			out = append(out, strconv.Itoa(i))
		}
		return strings.Join(out, "")
	}
	for _, tc := range []struct {
		name string
		q    Query
		want string
	}{
		{"everything", Query{}, "0123"},
		{"words", Query{Words: []string{"OPEN", "carlsen"}}, "02"},
		{"white", Query{White: "carlsen"}, "0"},
		{"black", Query{Black: "CARLSEN"}, "2"},
		{"either colour", Query{Player: "nakamura"}, "01"},
		{"event", Query{Event: "open a"}, "02"},
		{"draws", Query{Result: "1/2-1/2"}, "1"},
		{"decisive", Query{Result: "decisive"}, "02"},
		{"unfinished", Query{Result: "*"}, "3"},
		{"from a year", Query{DateFrom: "2024"}, "12"},
		{"up to a year", Query{DateTo: "2023"}, "0"},
		{"a month", Query{DateFrom: "2024.05", DateTo: "2024-05"}, "1"},
		{"a day in a month only known", Query{DateFrom: "2024.05.20"}, "12"},
		{"a range", Query{DateFrom: "2023.12.31", DateTo: "2024.06.14"}, "1"},
		{"at least 3 moves", Query{MinMoves: 3}, "02"},
		{"at most 2 moves", Query{MaxMoves: 2}, "13"},
		{"together", Query{Player: "carlsen", Result: "decisive", DateFrom: "2024", MinMoves: 4}, "2"},
		{"nothing", Query{White: "nobody"}, ""},
	} {
		if got := pick(tc.q); got != tc.want {
			t.Errorf("%s: picked %q, want %q", tc.name, got, tc.want)
		}
	}
	if !(Query{}).Empty() || (Query{MinMoves: 1}).Empty() {
		t.Error("Empty is wrong")
	}

	order := func(by string, desc bool) string {
		_, rows := c.Search(Query{}, by, desc, 0)
		var out []string
		for _, r := range rows {
			out = append(out, strconv.Itoa(r.Index))
		}
		return strings.Join(out, "")
	}
	for _, tc := range []struct {
		by   string
		desc bool
		want string
	}{
		{"", false, "0123"}, {"index", true, "3210"},
		{"white", false, "3021"}, // Anon, Carlsen, Ding, nakamura: case does not count
		{"white", true, "1203"},
		{"black", false, "2103"}, {"event", false, "0213"},
		{"date", false, "3012"}, {"date", true, "2103"},
		{"round", false, "2013"}, // 1, 2, 10, then none
		{"moves", false, "3102"}, {"moves", true, "2013"},
		{"result", false, "3201"},
	} {
		if got := order(tc.by, tc.desc); got != tc.want {
			t.Errorf("sorted by %q (desc %v): %s, want %s", tc.by, tc.desc, got, tc.want)
		}
	}
	matched, rows := c.Search(Query{Event: "open"}, "date", true, 2)
	if matched != 3 || len(rows) != 2 || rows[0].Index != 2 || rows[1].Index != 1 {
		t.Fatalf("limited search: %d matched, rows %+v", matched, rows)
	}
}

const advancedGames = `[Event "Rated Blitz game"]
[Site "https://lichess.org/abc"]
[Date "2025.03.01"]
[White "Devilfishbot"]
[Black "someone"]
[Result "1-0"]
[ECO "B90"]
[Opening "Sicilian Defense: Najdorf Variation"]
[TimeControl "180+2"]

1. e4 c5 2. Nf3 d6 1-0

[Event "Casual Rapid game"]
[Site "https://lichess.org/def"]
[Date "2025.03.02"]
[White "other"]
[Black "EsperEngine"]
[Result "0-1"]
[ECO "C65"]
[Opening "Ruy Lopez: Berlin Defense"]
[TimeControl "600+0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 0-1

[Event "Rated Bullet game"]
[Date "2025.03.03"]
[White "EsperEngine"]
[Black "Devilfishbot"]
[Result "1/2-1/2"]
[ECO "A00"]
[TimeControl "60+0"]

1. a3 a6 1/2-1/2

[Event "Casual game"]
[Date "2025.03.04"]
[White "Devilfishbot"]
[Black "Stockfish"]
[Result "0-1"]
[ECO "B99"]
[TimeControl "40/7200:3600"]

1. e4 c5 0-1

[Event "Club night"]
[White "esperengine"]
[Black "devilfishbot"]
[Result "1-0"]
[TimeControl "-"]

1. d4 1-0
`

func TestAdvancedSearch(t *testing.T) {
	c := openText(t, advancedGames)
	pick := func(q Query) string {
		var out []string
		for _, i := range c.Select(q) {
			out = append(out, strconv.Itoa(i))
		}
		return strings.Join(out, "")
	}
	both := []string{"Devilfishbot", " EsperEngine "}
	for _, tc := range []struct {
		name string
		q    Query
		want string
	}{
		{"either of two names", Query{Players: both}, "01234"},
		{"one name, either colour", Query{Players: []string{"devilfish"}}, "0234"},
		{"one name won", Query{Players: []string{"devilfishbot"}, Outcome: "won"}, "0"},
		{"either of two won", Query{Players: both, Outcome: "won"}, "014"},
		{"either of two lost", Query{Players: both, Outcome: "lost"}, "34"},
		{"either of two drew", Query{Players: both, Outcome: "drew"}, "2"},
		{"won with black", Query{Players: both, Outcome: "won", Side: "black"}, "1"},
		{"played white", Query{Players: []string{"devilfishbot"}, Side: "white"}, "03"},
		{"old single player field joins the list", Query{Player: "stockfish", Players: []string{"someone"}}, "03"},
		{"white won, no names", Query{Side: "white", Outcome: "won"}, "04"},
		{"black won, no names", Query{Side: "black", Outcome: "won"}, "13"},
		{"several whites", Query{Whites: []string{"other", "esperengine"}}, "124"},
		{"eco code", Query{Openings: []string{"b90"}}, "0"},
		{"eco start", Query{Openings: []string{"B9"}}, "03"},
		{"eco letter", Query{Openings: []string{"B"}}, "03"},
		{"eco range", Query{Openings: []string{"B99–C70"}}, "13"},
		{"opening name or code", Query{Openings: []string{"berlin", "A00"}}, "12"},
		{"speed blitz", Query{Speed: "blitz"}, "0"},
		{"speed bullet from the clock", Query{Speed: "Bullet"}, "2"},
		{"speed classical from stages", Query{Speed: "classical"}, "3"},
		{"speed correspondence", Query{Speed: "correspondence"}, "4"},
		{"time control as written", Query{TimeControl: "180 + 2"}, "0"},
		{"rated", Query{Rated: "rated"}, "02"},
		{"casual", Query{Rated: "casual"}, "13"},
		{"together", Query{Players: both, Outcome: "won", Rated: "rated", Speed: "blitz", MinMoves: 2}, "0"},
		{"unknown values are ignored", Query{Side: "green", Outcome: "maybe", Speed: "fast", Rated: "sometimes"}, "01234"},
	} {
		if got := pick(tc.q); got != tc.want {
			t.Errorf("%s: picked %q, want %q", tc.name, got, tc.want)
		}
	}
	if !(Query{Players: []string{" "}, Side: "green"}).Empty() || (Query{Outcome: "won"}).Empty() || (Query{Openings: []string{"B"}}).Empty() {
		t.Error("Empty is wrong")
	}
}

func TestSpeedOf(t *testing.T) {
	for _, tc := range []struct {
		event, tc string
		want      speed
	}{
		{"", "15+0", ultraBullet}, {"", "120+1", bullet}, {"", "180+0", blitz}, {"", "300+3", blitz},
		{"", "600+5", rapid}, {"", "1800+0", classical}, {"", "-", correspondence},
		{"Rated Rapid game", "?", rapid}, {"Rated UltraBullet game", "", ultraBullet}, {"Some open", "", none},
		{"", "*30", none},
	} {
		if got := speedOf(tc.event, tc.tc); got != tc.want {
			t.Errorf("speedOf(%q, %q) = %d, want %d", tc.event, tc.tc, got, tc.want)
		}
	}
}
