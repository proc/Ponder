// Command fakelichess serves the stand-in Lichess from package fake, for
// trying the app without a Lichess account:
//
//	go run ./lichess/testdata/fakelichess -addr 127.0.0.1:8765 -token test
//
// Then set Settings → Lichess → Server to http://127.0.0.1:8765. Challenge
// the bot with: curl 'http://127.0.0.1:8765/_fake/challenge?from=Alice&limit=180&inc=2'
package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"board/backend/lichess/fake"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:0", "address to listen on")
	token := flag.String("token", "test", "API token the server accepts")
	user := flag.String("user", "BoardBot", "bot account name")
	delay := flag.Duration("delay", 400*time.Millisecond, "opponent thinking time")
	maxPlies := flag.Int("maxplies", 300, "games longer than this end in a draw")
	notBot := flag.Bool("notbot", false, "start as a regular account (to try the upgrade)")
	rateLimited := flag.Int("ratelimit", 0, "refuse this many challenges sent with 429 Too Many Requests")
	rateSecs := flag.Float64("ratelimitsecs", 0, "seconds the 429 names (the daily bot-game limit); 0: a bare 429")
	others := flag.String("others", "", "more tokens it takes, as token=Name,token=Name (one account, renamed by the token used)")
	flag.Parse()
	s := fake.New(*token, *user)
	for _, kv := range strings.Split(*others, ",") {
		if tok, name, ok := strings.Cut(kv, "="); ok {
			if s.Others == nil {
				s.Others = map[string]string{}
			}
			s.Others[tok] = name
		}
	}
	s.Delay = *delay
	s.Bot = !*notBot
	s.MaxPlies = *maxPlies
	s.RateLimited, s.RateLimitSeconds = *rateLimited, *rateSecs
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("http://%s\n", ln.Addr())
	log.Fatal(http.Serve(ln, s))
}
