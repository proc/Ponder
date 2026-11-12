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
	flag.Parse()
	s := fake.New(*token, *user)
	s.Delay = *delay
	s.Bot = !*notBot
	s.MaxPlies = *maxPlies
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("http://%s\n", ln.Addr())
	log.Fatal(http.Serve(ln, s))
}
