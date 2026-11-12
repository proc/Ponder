// Command backend is the chess GUI's game server. It speaks JSON lines on
// stdin/stdout with the Electron main process:
//
//	request:  {"id": 1, "cmd": "newGame", "args": {...}}
//	response: {"id": 1, "ok": true, "data": ...} or {"id": 1, "ok": false, "error": "..."}
//	event:    {"event": "state", "data": {...}}
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"board/backend/analysis"
	"board/backend/chess"
	"board/backend/game"
	"board/backend/lichess"
	"board/backend/openings"
	"board/backend/pgn"
	"board/backend/puzzles"
	"board/backend/review"
	"board/backend/tournament"
	"board/backend/uci"
)

type request struct {
	ID   int             `json:"id"`
	Cmd  string          `json:"cmd"`
	Args json.RawMessage `json:"args"`
}

type message struct {
	ID    int    `json:"id,omitempty"`
	OK    *bool  `json:"ok,omitempty"`
	Error string `json:"error,omitempty"`
	Event string `json:"event,omitempty"`
	Data  any    `json:"data,omitempty"`
}

func main() {
	out := bufio.NewWriter(os.Stdout)
	var outMu sync.Mutex
	send := func(m message) {
		outMu.Lock()
		defer outMu.Unlock()
		json.NewEncoder(out).Encode(m)
		out.Flush()
	}
	go openings.Load() // ready before the first move needs it
	emit = func(event string, data any) {
		send(message{Event: event, Data: data})
	}
	mgr := game.NewManager(emit)
	analyzer = analysis.New(emit)
	// Your own Lichess game on the board keeps it: games followed elsewhere
	// (watched, a tournament, the bot's) wait.
	playOnBoard := func() bool {
		_, kind, live := mgr.ExternalKind()
		return kind == "play" && live
	}
	bot = lichess.NewBot(lichess.Hooks{
		Emit: emit,
		Show: func(v game.ExternalView) {
			if bot.Watching() == v.ID && !playOnBoard() {
				mgr.ShowExternal(v)
			}
		},
		AutoWatch: func() bool {
			_, kind, live := mgr.ExternalKind()
			return !mgr.Busy() && !spectator.Active() && !tourney.Watching() && !(kind == "play" && live)
		},
		Save: func(text string) { saveToDatabase("lichess", text) },
	})
	spectator = lichess.NewSpectator(emit, func(v game.ExternalView) {
		if spectator.Active() && !playOnBoard() {
			mgr.ShowExternal(v)
		}
	})
	player = lichess.NewPlayer(lichess.PlayHooks{
		Emit: emit,
		Show: func(v game.ExternalView, takeOver bool) {
			if takeOver || mgr.ExternalID() == v.ID {
				mgr.ShowExternal(v)
			}
		},
		Save: func(text string) { saveToDatabase("lichess", text) },
	})
	// On the way out: stop the game and the analysis, then make sure no
	// engine process is left behind.
	defer uci.CloseAll(2 * time.Second)
	defer analyzer.Stop()
	defer mgr.Shutdown()
	spectator.Save = func(text string) { saveToDatabase("watched", text) }
	var tourneySave sync.Mutex
	tourney = tournament.New(tournament.Hooks{
		Emit: emit,
		Show: func(v game.ExternalView) {
			if tourney.Watching() && !playOnBoard() {
				mgr.ShowExternal(v)
			}
		},
		Info: func(in game.EngineInfo) {
			if tourney.Watching() {
				emit("engineInfo", in)
			}
		},
		Done: func() {
			if tourney.Watching() {
				mgr.FreezeExternal("Tournament ended")
			}
		},
		Save: func(path, text string) error {
			tourneySave.Lock()
			defer tourneySave.Unlock()
			return appendPGN(path, text)
		},
	})
	reviewer = review.New(emit)
	defer reviewer.Stop()
	defer tourney.Wait(5 * time.Second)
	defer tourney.Stop()
	mgr.OnFinish(func(text string) { saveToDatabase("local", text) })
	defer bot.Disconnect(false)
	defer spectator.Stop()
	defer player.Disconnect()

	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for in.Scan() {
		var req request
		if err := json.Unmarshal(in.Bytes(), &req); err != nil {
			continue
		}
		reply := func() {
			data, err := handle(mgr, req)
			ok := err == nil
			resp := message{ID: req.ID, OK: &ok, Data: data}
			if err != nil {
				resp.Error = err.Error()
			}
			send(resp)
		}
		// Lichess requests wait on the network; the rest are answered in order.
		if strings.HasPrefix(req.Cmd, "lichess") || strings.HasPrefix(req.Cmd, "puzzle") {
			go reply()
		} else {
			reply()
		}
	}
}

// The PGN file opened last. Requests are handled one at a time, so this
// needs no lock.
var collection struct {
	c    *pgn.Collection
	name string
	path string
}

// database is the PGN file finished games are added to, and which games.
var database struct {
	mu                      sync.Mutex
	path                    string
	local, lichess, watched bool
}

// saveToDatabase appends a finished game to the database file, if games
// of this kind ("local", "lichess", "watched") are kept.
func saveToDatabase(kind, text string) {
	database.mu.Lock()
	defer database.mu.Unlock()
	on := map[string]bool{"local": database.local, "lichess": database.lichess, "watched": database.watched}[kind]
	path := database.path
	if path == "" || !on {
		return
	}
	err := appendPGN(path, text)
	ev := map[string]any{"path": path, "name": filepath.Base(path), "kind": kind}
	if err != nil {
		ev["error"] = err.Error()
	}
	emit("databaseSaved", ev)
}

// appendPGN adds a game to the end of a PGN file, a blank line after the
// game before it.
func appendPGN(path, text string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	sep := ""
	if info, err := f.Stat(); err == nil && info.Size() > 0 {
		tail := make([]byte, 2)
		n := int64(len(tail))
		if info.Size() < n {
			n = info.Size()
		}
		if _, err := f.ReadAt(tail[:n], info.Size()-n); err == nil {
			switch {
			case n == 2 && string(tail) == "\n\n":
			case tail[n-1] == '\n':
				sep = "\n"
			default:
				sep = "\n\n"
			}
		}
	}
	text = strings.TrimRight(text, "\n") + "\n"
	_, err = f.WriteString(sep + text)
	return err
}

func loadFromCollection(mgr *game.Manager, i int) error {
	g, err := collection.c.Read(i)
	if err != nil {
		return err
	}
	return mgr.LoadGame(g, collection.name, i)
}

// emit sends an event to the UI; set in main.
var emit func(event string, data any)

// analyzer runs the analysis engine, separate from any engine playing.
var analyzer *analysis.Analyzer

// bot plays games on Lichess.
var bot *lichess.Bot

// spectator follows another player's Lichess games, with no engine playing.
var spectator *lichess.Spectator

// player plays the person's own games on Lichess (Board API).
var player *lichess.Player

// playGame is the id of the person's live Lichess game on the board, or "".
func playGame(mgr *game.Manager) string {
	id, kind, live := mgr.ExternalKind()
	if kind == "play" && live {
		return id
	}
	return ""
}

// puzzleDB is the Lichess puzzle file opened for offline puzzles.
var puzzleDB struct {
	sync.Mutex
	db *puzzles.DB
}

// reviewer runs the computer analysis of finished games.
var reviewer *review.Reviewer

// tourney plays engine tournaments.
var tourney *tournament.Tournament

// stopWatching stops showing Lichess or tournament games when the board is
// wanted for something else.
func stopWatching(mgr *game.Manager) {
	bot.Unwatch()
	spectator.Stop()
	if tourney.Watching() {
		tourney.Watch(false)
		mgr.FreezeExternal("")
	}
}

func handle(mgr *game.Manager, req request) (any, error) {
	decode := func(v any) error {
		if len(req.Args) == 0 {
			return nil
		}
		return json.Unmarshal(req.Args, v)
	}
	switch req.Cmd {
	case "newGame":
		var cfg game.Config
		if err := decode(&cfg); err != nil {
			return nil, err
		}
		stopWatching(mgr)
		return nil, mgr.NewGame(cfg)
	case "move":
		var a struct{ UCI string }
		if err := decode(&a); err != nil {
			return nil, err
		}
		if id := playGame(mgr); id != "" {
			return nil, player.Move(id, a.UCI)
		}
		return nil, mgr.Move(a.UCI)
	case "resign":
		var a struct{ Side string }
		if err := decode(&a); err != nil {
			return nil, err
		}
		if id := playGame(mgr); id != "" {
			go player.Resign(id)
			return nil, nil
		}
		return nil, mgr.Resign(a.Side)
	case "draw":
		if id := playGame(mgr); id != "" {
			go player.Draw(id, true)
			return nil, nil
		}
		return nil, mgr.Draw()
	case "abort":
		if id := playGame(mgr); id != "" {
			go player.Abort(id)
			return nil, nil
		}
		mgr.Abort()
		return nil, nil
	case "state":
		return mgr.State(), nil
	case "pgn":
		var a struct{ Annotations *game.Annotations }
		if err := decode(&a); err != nil {
			return nil, err
		}
		return mgr.AnnotatedPGN(a.Annotations)
	case "positionInfo":
		// Legal moves of any position, for exploring variations and puzzles.
		var a struct{ FEN string }
		if err := decode(&a); err != nil {
			return nil, err
		}
		pos, err := chess.ParseFEN(a.FEN)
		if err != nil {
			return nil, err
		}
		legal := []string{}
		for _, m := range pos.LegalMoves() {
			legal = append(legal, m.UCI())
		}
		status := ""
		if len(legal) == 0 {
			status = "stalemate"
			if pos.InCheck() {
				status = "checkmate"
			}
		}
		return map[string]any{"fen": a.FEN, "legal": legal, "check": pos.InCheck(), "status": status}, nil
	case "applyMove":
		var a struct{ FEN, UCI string }
		if err := decode(&a); err != nil {
			return nil, err
		}
		pos, err := chess.ParseFEN(a.FEN)
		if err != nil {
			return nil, err
		}
		mv, err := pos.ParseUCIMove(a.UCI)
		if err != nil {
			return nil, err
		}
		next := pos.Make(mv)
		out := map[string]any{"uci": mv.UCI(), "san": pos.SAN(mv), "fen": next.FEN()}
		if o, ok := openings.Lookup(&next); ok {
			out["opening"] = o.String()
		}
		return out, nil
	case "bookMoves":
		var a struct{ FEN string }
		if err := decode(&a); err != nil {
			return nil, err
		}
		pos, err := chess.ParseFEN(a.FEN)
		if err != nil {
			return nil, err
		}
		moves := openings.Next(&pos)
		if moves == nil {
			moves = []openings.BookMove{}
		}
		return moves, nil
	case "pgnPosition":
		// The position at the end of a PGN game (a Lichess puzzle's game).
		var a struct{ PGN string }
		if err := decode(&a); err != nil {
			return nil, err
		}
		games, err := pgn.Parse(a.PGN)
		if err != nil || len(games) == 0 {
			return nil, fmt.Errorf("could not read the game: %v", err)
		}
		g := games[0]
		fen := g.Tag("FEN")
		if fen == "" {
			fen = chess.StartFEN
		}
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			return nil, err
		}
		last := ""
		for _, tok := range g.Moves {
			m, err := pgn.ParseMove(&pos, tok)
			if err != nil {
				return nil, fmt.Errorf("move %s: %v", tok, err)
			}
			last = m.UCI()
			pos = pos.Make(m)
		}
		return map[string]any{"fen": pos.FEN(), "lastMove": last, "plies": len(g.Moves)}, nil
	case "loadPgnText":
		// A game from elsewhere (an explorer game) shown on the board.
		var a struct{ PGN, Source string }
		if err := decode(&a); err != nil {
			return nil, err
		}
		games, err := pgn.Parse(a.PGN)
		if err != nil || len(games) == 0 {
			return nil, fmt.Errorf("could not read the game: %v", err)
		}
		stopWatching(mgr)
		return nil, mgr.LoadGame(games[0], a.Source, 0)
	case "openPgn":
		// Index every game in the file and show the first one that loads.
		// Only headers and file positions are kept, so any size works;
		// games are read from the file when selected.
		var a struct{ Path string }
		if err := decode(&a); err != nil {
			return nil, err
		}
		name := filepath.Base(a.Path)
		c, err := pgn.Open(a.Path, func(done, total int64) {
			emit("pgnProgress", map[string]any{"name": name, "done": done, "total": total})
		})
		if err != nil {
			return nil, fmt.Errorf("could not read %s: %w", name, err)
		}
		if c.Len() == 0 {
			return nil, fmt.Errorf("no games found in %s", name)
		}
		collection.c, collection.name, collection.path = c, name, a.Path
		stopWatching(mgr)
		errs := map[int]string{}
		loaded := -1
		for i := 0; i < c.Len(); i++ {
			if err := loadFromCollection(mgr, i); err != nil {
				errs[i] = err.Error()
				continue
			}
			loaded = i
			break
		}
		return map[string]any{"name": name, "total": c.Len(), "index": loaded, "errors": errs}, nil
	case "listGames":
		// The rows for the Games list: games matching every word of the
		// filter, at most limit of them, plus how many match in all.
		var a struct {
			Filter string
			Limit  int
		}
		if err := decode(&a); err != nil {
			return nil, err
		}
		if collection.c == nil {
			return map[string]any{"total": 0, "matched": 0, "games": []pgn.Entry{}}, nil
		}
		matched, rows := collection.c.Find(strings.Fields(a.Filter), a.Limit)
		return map[string]any{"total": collection.c.Len(), "matched": matched, "games": rows}, nil
	case "selectGame":
		var a struct{ Index int }
		if err := decode(&a); err != nil {
			return nil, err
		}
		if collection.c == nil {
			return nil, fmt.Errorf("no PGN file is open")
		}
		stopWatching(mgr)
		return nil, loadFromCollection(mgr, a.Index)
	case "closePgn":
		collection.c, collection.name, collection.path = nil, "", ""
		return nil, nil
	case "refreshPgn":
		// Index the open file again (games were added to it), keeping the
		// game on the board.
		var a struct{ Path string }
		if err := decode(&a); err != nil {
			return nil, err
		}
		if collection.c == nil || (a.Path != "" && !samePath(a.Path, collection.path)) {
			return map[string]any{"refreshed": false}, nil
		}
		c, err := pgn.Open(collection.path, nil)
		if err != nil {
			return nil, err
		}
		collection.c = c
		return map[string]any{"refreshed": true, "total": c.Len()}, nil
	case "setDatabase":
		var a struct {
			Path                    string
			Local, Lichess, Watched bool
		}
		if err := decode(&a); err != nil {
			return nil, err
		}
		database.mu.Lock()
		database.path, database.local, database.lichess, database.watched = a.Path, a.Local, a.Lichess, a.Watched
		database.mu.Unlock()
		return nil, nil
	case "analysisStart":
		var cfg analysis.Config
		if err := decode(&cfg); err != nil {
			return nil, err
		}
		return nil, analyzer.Start(cfg)
	case "analysisPosition":
		var a struct{ FEN string }
		if err := decode(&a); err != nil {
			return nil, err
		}
		return nil, analyzer.SetPosition(a.FEN)
	case "analysisStop":
		analyzer.Stop()
		return nil, nil
	case "lichessStatus":
		return bot.Status(), nil
	case "lichessConnect":
		var cfg lichess.Config
		if err := decode(&cfg); err != nil {
			return nil, err
		}
		return bot.Connect(cfg)
	case "lichessConfigure":
		var a struct {
			Engine lichess.EngineConfig
			Policy lichess.Policy
		}
		if err := decode(&a); err != nil {
			return nil, err
		}
		bot.Configure(a.Engine, a.Policy)
		return nil, nil
	case "lichessDisconnect":
		var a struct{ Resign bool }
		if err := decode(&a); err != nil {
			return nil, err
		}
		bot.Disconnect(a.Resign)
		if !spectator.Active() {
			mgr.FreezeExternal("Disconnected from Lichess")
		}
		return nil, nil
	case "lichessUpgrade":
		return bot.UpgradeToBot()
	case "lichessAccept", "lichessDecline", "lichessCancel", "lichessResign", "lichessAbort", "lichessWatch":
		var a struct{ ID, Reason string }
		if err := decode(&a); err != nil {
			return nil, err
		}
		switch req.Cmd {
		case "lichessAccept":
			return nil, bot.Accept(a.ID)
		case "lichessDecline":
			return nil, bot.Decline(a.ID, a.Reason)
		case "lichessCancel":
			return nil, bot.Cancel(a.ID)
		case "lichessResign":
			if player.Has(a.ID) {
				return nil, player.Resign(a.ID)
			}
			return nil, bot.Resign(a.ID)
		case "lichessAbort":
			if player.Has(a.ID) {
				return nil, player.Abort(a.ID)
			}
			return nil, bot.Abort(a.ID)
		default:
			spectator.Stop()
			return nil, bot.Watch(a.ID)
		}
	case "lichessPlay":
		var a struct{ ID string }
		if err := decode(&a); err != nil {
			return nil, err
		}
		return nil, bot.Play(a.ID)
	case "lichessAcctConnect":
		var a struct{ BaseURL, Token string }
		if err := decode(&a); err != nil {
			return nil, err
		}
		return player.Connect(a.BaseURL, a.Token)
	case "lichessAcctDisconnect":
		player.Disconnect()
		if id, kind, _ := mgr.ExternalKind(); kind == "play" && id != "" {
			mgr.FreezeExternal("Signed out of Lichess")
		}
		return nil, nil
	case "lichessAcctStatus":
		return player.Status(), nil
	case "lichessAcctSeek":
		var a lichess.LobbySeek
		if err := decode(&a); err != nil {
			return nil, err
		}
		return nil, player.Seek(a)
	case "lichessAcctSeekStop":
		player.StopSeek()
		return nil, nil
	case "lichessAcctChallenge":
		var a lichess.ChallengeParams
		if err := decode(&a); err != nil {
			return nil, err
		}
		return nil, player.Challenge(a)
	case "lichessAcctAccept", "lichessAcctDecline", "lichessAcctCancel", "lichessAcctShow", "lichessAcctResign", "lichessAcctAbort", "lichessAcctDraw", "lichessAcctTakeback":
		var a struct {
			ID  string
			Yes bool
		}
		if err := decode(&a); err != nil {
			return nil, err
		}
		switch req.Cmd {
		case "lichessAcctAccept":
			return nil, player.Accept(a.ID)
		case "lichessAcctDecline":
			return nil, player.Decline(a.ID)
		case "lichessAcctCancel":
			return nil, player.Cancel(a.ID)
		case "lichessAcctShow":
			return nil, player.Show(a.ID)
		case "lichessAcctResign":
			return nil, player.Resign(a.ID)
		case "lichessAcctAbort":
			return nil, player.Abort(a.ID)
		case "lichessAcctDraw":
			return nil, player.Draw(a.ID, a.Yes)
		default:
			return nil, player.Takeback(a.ID, a.Yes)
		}
	case "lichessAutoAccept":
		var a struct{ On bool }
		if err := decode(&a); err != nil {
			return nil, err
		}
		return nil, bot.SetAutoAccept(a.On)
	case "puzzleFileOpen":
		var a struct{ Path string }
		if err := decode(&a); err != nil {
			return nil, err
		}
		db, err := puzzles.Open(a.Path, func(done, total int64) {
			emit("puzzleFileProgress", map[string]int64{"done": done, "total": total})
		})
		if err != nil {
			return nil, err
		}
		puzzleDB.Lock()
		if puzzleDB.db != nil {
			puzzleDB.db.Close()
		}
		puzzleDB.db = db
		puzzleDB.Unlock()
		return map[string]any{"path": db.Path(), "count": db.Len()}, nil
	case "puzzleRandom":
		var a struct {
			Min, Max int
			Theme    string
		}
		if err := decode(&a); err != nil {
			return nil, err
		}
		puzzleDB.Lock()
		db := puzzleDB.db
		puzzleDB.Unlock()
		if db == nil {
			return nil, fmt.Errorf("open a puzzle file first")
		}
		return db.Random(a.Min, a.Max, a.Theme)
	case "takeback":
		if id := playGame(mgr); id != "" {
			go player.Takeback(id, true)
			return nil, nil
		}
		return nil, mgr.Takeback()
	case "reviewStart":
		var r review.Request
		if err := decode(&r); err != nil {
			return nil, err
		}
		return nil, reviewer.Start(r)
	case "reviewStop":
		reviewer.Stop()
		return nil, nil
	case "tournamentStart":
		var c tournament.Config
		if err := decode(&c); err != nil {
			return nil, err
		}
		return nil, tourney.Start(c)
	case "tournamentStop":
		tourney.Stop()
		return nil, nil
	case "tournamentStatus":
		return tourney.Status(), nil
	case "tournamentReport":
		return tourney.Report()
	case "tournamentWatch":
		var a struct{ On bool }
		if err := decode(&a); err != nil {
			return nil, err
		}
		if a.On {
			bot.Unwatch()
			spectator.Stop()
		} else if tourney.Watching() {
			mgr.FreezeExternal("")
		}
		tourney.Watch(a.On)
		return nil, nil
	case "tournamentGame":
		// Show a finished game from the list on the board.
		var a struct{ Number int }
		if err := decode(&a); err != nil {
			return nil, err
		}
		text, err := tourney.GamePGN(a.Number)
		if err != nil {
			return nil, err
		}
		games, err := pgn.Parse(text)
		if err != nil || len(games) != 1 {
			return nil, fmt.Errorf("could not read the game: %v", err)
		}
		stopWatching(mgr)
		return nil, mgr.LoadGame(games[0], "Tournament", a.Number-1)
	case "lichessSeek":
		var p lichess.SeekParams
		if err := decode(&p); err != nil {
			return nil, err
		}
		return nil, bot.StartSeek(p)
	case "lichessSeekStop":
		bot.StopSeek()
		return nil, nil
	case "lichessChallenge":
		var p lichess.ChallengeParams
		if err := decode(&p); err != nil {
			return nil, err
		}
		return nil, bot.Challenge(p)
	case "lichessBots":
		// Works without connecting: the list is public.
		var a struct{ BaseURL string }
		if err := decode(&a); err != nil {
			return nil, err
		}
		if bot.Status().State == "connected" {
			return bot.OnlineBots()
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		return lichess.NewClient(a.BaseURL, "").OnlineBots(ctx, 100)
	case "lichessSpectate":
		var a struct{ BaseURL, Username string }
		if err := decode(&a); err != nil {
			return nil, err
		}
		bot.Unwatch()
		return nil, spectator.Start(a.BaseURL, a.Username)
	case "lichessSpectateStop":
		if spectator.Active() {
			spectator.Stop()
			mgr.FreezeExternal("Stopped watching")
		}
		return nil, nil
	case "lichessSpectateStatus":
		return spectator.Status(), nil
	case "probe":
		var a struct {
			Path string
			Args []string
		}
		if err := decode(&a); err != nil {
			return nil, err
		}
		e, err := uci.Probe(a.Path, a.Args)
		if err != nil {
			return nil, err
		}
		return map[string]any{"name": e.Name, "author": e.Author, "options": e.Options}, nil
	}
	return nil, fmt.Errorf("unknown command %q", req.Cmd)
}

func samePath(a, b string) bool {
	ca, err1 := filepath.Abs(a)
	cb, err2 := filepath.Abs(b)
	return err1 == nil && err2 == nil && filepath.Clean(ca) == filepath.Clean(cb)
}
