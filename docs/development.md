# Development

## Build and run

You need [Node.js](https://nodejs.org) 18+ and [Go](https://go.dev/dl/) 1.21+.

```sh
npm install
npm start        # builds the Go backend into ./bin, then opens the app
npm test         # the Go tests: move generation (perft), clocks, full games
```

## Packaging

```sh
npm run package                                        # dist/Ponder-<platform>-<arch>/ (macOS: Ponder.app)
npm run package -- --zip                               # macOS: also a .zip
npm run package -- --arch=x64                          # for the other processor (arm64, x64)
npm run package -- --platform=win32 --arch=x64 --zip   # for Windows, from a Mac
```

The package holds the Go backend, the two bundled engines, the window's
files and the piece sets, and runs without Go, Node or the source. It is
for the system it is made on unless `--platform=` names another (`win32`,
`darwin`, `linux`). The first time, Electron for that system is downloaded.

- **Windows** packages made this way aren't code-signed, so SmartScreen
  warns before running them.
- **macOS** bundles are signed ad hoc: they run on the Mac that built them,
  but another Mac refuses them until they're signed with a Developer ID and
  notarized.
- **Icon** – made from `icon.svg`. After changing it, run
  `scripts/make-icons.sh` (needs librsvg and ImageMagick).

Settings, engines and the game database stay where they were.

## Code layout

```
app/                 Electron main process, preload and renderer (plain JS)
  renderer/vendor/   three.js (the 3D board) and the Windows flag font
backend/             Go module
  chess/             rules: move generation, FEN, SAN, draw detection
  uci/               UCI engine process driver
  game/              game manager, players, clocks
  analysis/          the analysis engine, following the shown position
  pgn/               PGN reading and indexing of large files
  openings/          the embedded opening book
  lichess/           Lichess Bot API client and bot (fake/: stand-in server)
  cmd/basicengine/   the bundled "Ponder Basic" UCI engine
  cmd/randomengine/  the bundled random-move UCI engine
  main.go            JSON-lines server on stdin/stdout
svg/<theme>/         piece sets, one folder per theme: <color>-<name>.svg
scripts/             build helpers
```

The renderer talks to the backend through Electron IPC. The main process
relays JSON lines such as `{"id":1,"cmd":"move","args":{"uci":"e2e4"}}` and
forwards events such as `state`, `engineInfo`, `analysis` and `lichess`
back to the window.

## Trying Lichess without an account

The tests use a stand-in Lichess server, which you can run yourself:

```sh
cd backend && go run ./lichess/testdata/fakelichess -addr 127.0.0.1:8765
```

Set **Server** (Settings → Lichess) to `http://127.0.0.1:8765` and the token
to `test`. Add `-notbot` to sign in as a person instead: **Sign in with
Lichess** then works against it, and its lobby pairs you with a
random-moving player. Then, for example:

```sh
curl 'http://127.0.0.1:8765/_fake/challenge?from=Alice&limit=180&inc=2'   # challenge your bot
curl 'http://127.0.0.1:8765/_fake/autogame?white=maia1&black=SlowBot'     # a game to watch
curl 'http://127.0.0.1:8765/_fake/chat?game=ID&from=Kibitzer&text=Hello'  # say something (room=player for the players' room)
```

## Formerly "Board"

Ponder used to be called **Board**. The first time it starts under the new
name it brings your engines, Lichess settings and game database settings
along, and keeps using `Documents/Board` for games and tournaments if that
folder exists. Lichess tokens saved encrypted have to be entered again,
because the system keychain keeps them under the app's name.
