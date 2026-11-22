package lichess

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHomeNeedsSignIn(t *testing.T) {
	h := newPlayHarness(t)
	if _, err := h.p.Home(); err == nil {
		t.Fatal("home read while signed out")
	}
	if err := h.p.Resume("abc"); err == nil {
		t.Fatal("resume while signed out")
	}
}

func TestHomeReadsEveryPart(t *testing.T) {
	h := newPlayHarness(t)
	if _, err := h.p.Connect(h.srv.URL, "secret"); err != nil {
		t.Fatal(err)
	}
	home, err := h.p.Home()
	if err != nil {
		t.Fatal(err)
	}
	if home.ProfileError != "" || home.Profile == nil || home.Profile.Username != "Alice" {
		t.Fatalf("profile: %+v %q", home.Profile, home.ProfileError)
	}
	if p := home.Profile.Perfs["blitz"]; p.Rating != 1588 || p.Games != 1204 || p.Prog != 23 {
		t.Fatalf("blitz perf: %+v", p)
	}
	if !home.Profile.Perfs["classical"].Prov {
		t.Fatal("provisional rating not read")
	}
	if home.Profile.Count == nil || home.Profile.Count.Win != 850 || home.Profile.Profile == nil || home.Profile.Profile.Flag != "NO" {
		t.Fatalf("count/flag: %+v %+v", home.Profile.Count, home.Profile.Profile)
	}
	if home.PlayingError != "" || len(home.Playing) != 0 {
		t.Fatalf("playing: %+v %q", home.Playing, home.PlayingError)
	}
	if home.FollowingError != "" || len(home.Following) != 4 {
		t.Fatalf("following: %+v %q", home.Following, home.FollowingError)
	}
	// Online first (by name), then offline.
	var order []string
	for _, f := range home.Following {
		order = append(order, f.Name)
	}
	if got := strings.Join(order, ","); got != "Frank,maia1,Bob,Carol" {
		t.Fatalf("following order %s", got)
	}
	if !home.Following[0].Online || home.Following[2].Online || home.Following[1].Title != "BOT" || home.Following[0].Perfs["blitz"].Rating == 0 {
		t.Fatalf("following details: %+v", home.Following)
	}
	if home.LobbyError != "" || len(home.Lobby) != 2 {
		t.Fatalf("lobby: %+v %q", home.Lobby, home.LobbyError)
	}
	if l := home.Lobby[0]; l.ID != "seek0001" || l.Username != "Dana" || !l.Rated || l.Days != 3 || l.Perf != "correspondence" || l.Variant != "standard" {
		t.Fatalf("lobby entry: %+v", l)
	}
	if l := home.Lobby[1]; l.Rated || !l.Provisional || l.Color != "white" || l.Days != 7 {
		t.Fatalf("lobby entry: %+v", l)
	}
	if home.At == 0 {
		t.Fatal("no time")
	}
}

func TestHomeWithoutFollowScope(t *testing.T) {
	h := newPlayHarness(t)
	h.fake.NoFollowScope = true
	if _, err := h.p.Connect(h.srv.URL, "secret"); err != nil {
		t.Fatal(err)
	}
	home, err := h.p.Home()
	if err != nil {
		t.Fatal(err)
	}
	if !home.NeedsScope || !strings.Contains(home.FollowingError, "Sign in again") || len(home.Following) != 0 {
		t.Fatalf("following without scope: %+v", home)
	}
	if home.Profile == nil || home.LobbyError != "" {
		t.Fatalf("other parts should still be read: %+v", home)
	}
}

func TestHomeListsOngoingGamesAndResumes(t *testing.T) {
	h := newPlayHarness(t)
	if _, err := h.p.Connect(h.srv.URL, "secret"); err != nil {
		t.Fatal(err)
	}
	if err := h.p.Seek(LobbySeek{Limit: 600, Color: "white"}); err != nil {
		t.Fatal(err)
	}
	st := h.wait("game start", func(s PlayStatus) bool { return len(s.Games) == 1 })
	id := st.Games[0].ID
	home, err := h.p.Home()
	if err != nil {
		t.Fatal(err)
	}
	if len(home.Playing) != 1 || home.Playing[0].Key() != id || home.Playing[0].Color != "white" || home.Playing[0].Opponent.Username != "Rival" {
		t.Fatalf("playing: %+v", home.Playing)
	}
	if !home.Playing[0].IsMyTurn || home.Playing[0].SecondsLeft <= 0 {
		t.Fatalf("turn and clock: %+v", home.Playing[0])
	}
	// A game already followed: Resume shows it.
	before := h.takes
	if err := h.p.Resume(id); err != nil {
		t.Fatal(err)
	}
	h.mu.Lock()
	took := h.takes > before
	h.mu.Unlock()
	if !took && h.p.Current() != id {
		t.Fatal("resume did not show the game")
	}
	if err := h.p.Resume("nosuchgame"); err == nil {
		t.Fatal("resumed a game that is not going on")
	}
}

// A game Lichess lists as ongoing but the event stream never announced
// (Ponder signed in while it was being set up, say) is followed on Resume.
func TestResumeFollowsUnannouncedGame(t *testing.T) {
	h := newPlayHarness(t)
	if _, err := h.p.Connect(h.srv.URL, "secret"); err != nil {
		t.Fatal(err)
	}
	if err := h.p.Seek(LobbySeek{Limit: 900, Increment: 10}); err != nil {
		t.Fatal(err)
	}
	st := h.wait("game start", func(s PlayStatus) bool { return len(s.Games) == 1 })
	id := st.Games[0].ID
	// Forget it, as if it had never been announced.
	h.p.mu.Lock()
	if g := h.p.games[id]; g != nil && g.cancel != nil {
		g.cancel()
	}
	delete(h.p.games, id)
	h.p.order, h.p.current = nil, ""
	h.p.mu.Unlock()
	if err := h.p.Resume(id); err != nil {
		t.Fatal(err)
	}
	st = h.wait("game followed again", func(s PlayStatus) bool {
		return len(s.Games) == 1 && s.Games[0].ID == id && s.Current == id && s.Games[0].Opponent == "Rival"
	})
	if st.Games[0].Finished {
		t.Fatalf("game finished: %+v", st.Games[0])
	}
}

func TestCorrespondenceSeek(t *testing.T) {
	h := newPlayHarness(t)
	if _, err := h.p.Connect(h.srv.URL, "secret"); err != nil {
		t.Fatal(err)
	}
	if err := h.p.Seek(LobbySeek{Days: 4, Rated: true}); err == nil {
		t.Fatal("4 days a move accepted")
	}
	if err := h.p.Seek(LobbySeek{Days: 3, Rated: true, Color: "black"}); err != nil {
		t.Fatal(err)
	}
	st := h.p.Status()
	if st.Seek != nil || !strings.Contains(st.Message, "rated correspondence seek (3 days a move)") {
		t.Fatalf("status after correspondence seek: %+v", st)
	}
	seeks := h.fake.CorrSeeksSent()
	if len(seeks) != 1 || seeks[0] != "3" {
		t.Fatalf("seeks sent: %v", seeks)
	}
}

func TestLobbySeeksErrors(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
		want       string
	}{
		{"not json", "<html>", 200, "not understood"},
		{"refused", `{"error":"Not found"}`, 404, "Not found"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/lobby/seeks" || !strings.Contains(r.Header.Get("Accept"), "lichess") {
					t.Errorf("request %s accept %q", r.URL.Path, r.Header.Get("Accept"))
				}
				w.WriteHeader(tc.status)
				w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, err := NewClient(srv.URL, "").LobbySeeks(ctx)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %v, want %q", err, tc.want)
			}
		})
	}
}

func TestSortFriends(t *testing.T) {
	fs := []Friend{
		{Name: "zed", SeenAt: 5}, {Name: "amy", SeenAt: 9}, {Name: "Bo", Online: true},
		{Name: "al", Online: true, Playing: true}, {Name: "Ann", Online: true},
	}
	SortFriends(fs)
	var got []string
	for _, f := range fs {
		got = append(got, f.Name)
	}
	if s := strings.Join(got, ","); s != "al,Ann,Bo,amy,zed" {
		t.Fatalf("order %s", s)
	}
}
