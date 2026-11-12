# Board

A desktop chess GUI for UCI engines. The window is Electron; the chess rules,
clocks and engine processes live in a Go backend that Electron starts as a
child process.

## Run it

You need [Node.js](https://nodejs.org) 18+ and [Go](https://go.dev/dl/) 1.21+.

```sh
npm install
npm start        # builds the Go backend into ./bin, then opens the app
```

`npm test` runs the Go tests (move generation perft, clocks, full games).

## Using it

The window opens maximised and is laid out for a full screen (F11, or ⌃⌘F
on macOS, for true full screen): the board takes the full height, and the
rest holds the moves or game list beside engine analysis and game details.

- **New game** – choose Human vs Human, Human vs Computer or Computer vs
  Computer, pick engines, and set the time control.
- **Settings → Engines** – add any UCI engine (Stockfish, Lc0, …) by
  picking its executable, then set its options (Threads, Hash, Skill Level,
  …). **Command line** sets the options the program is started with (for
  engines that need e.g. `--uci` or a network file); spaces separate them
  and quotes keep spaces in one, and Board checks that the engine starts
  with them. They apply everywhere the engine plays: games, analysis,
  tournaments and Lichess. Two engines are bundled so everything works straight away: **Board
  Basic**, a small real engine (alpha-beta search, a few moves deep, MultiPV)
  and **Random Mover**, which plays random legal moves.
- **Analysis** (toolbar) – an engine analyses the position on the board and
  shows its best lines with evaluations, an evaluation bar beside the board
  and an arrow for the best move, with the other lines' first moves as
  thinner arrows in their own colours (marked beside each line in the
  Analysis window; turn them off in Settings → Analysis). It follows the board as you play, step
  back through the moves or browse games from a file. Choose the engine and
  the number of lines (1–5) in **Settings → Analysis**; it runs as its own
  process, separate from engines playing a game, and pauses while an engine
  is playing. **⏸ Pause** in the Analysis window (or the **P** key) stops the
  engine thinking and keeps its lines on screen; **▶ Resume** analyses the
  position then on the board.
- **Moves list** – one row per move number as on Lichess (number, White,
  Black), with the result at the end; click a move to go to it. Each move
  starts with an icon of the piece that moved (in the board's piece theme;
  castling shows the king) and ends with the score after it, from White's
  side: the computer analysis once it has run, otherwise the evaluation the
  engine that played the move reported (in italics; hover for its depth).
  Both can be turned off in Settings → General → Moves list.
- **Computer analysis** – after a game (or for a game from a PGN file),
  **Computer analysis** in the Moves tab has the analysis engine evaluate
  every position (Fast 0.2 s, Normal 0.6 s or Deep 1.5 s a move). Then, as on
  Lichess: an advantage chart (click to jump), inaccuracies **?!**, mistakes
  **?** and blunders **??** in the moves list with the better move, and each
  player's counts, average centipawn loss and accuracy.
- **Side variations** – once a game is over (or opened from a file), moves
  played on the board become variations, as on Lichess's analysis board:
  they appear under the move they replace, nested lines in parentheses.
  Click a move to go to it, ← → walk through a line, ✕ deletes one. Playing
  the game's own move just follows the game.
- **Saved analysis** – **Save…** and **Copy** include the computer analysis
  in Lichess's form (`{ [%eval 0.35] }` after each move, `$6 $2 $4` for
  ?! ? ??, with the better move) and the side variations.
- **Opening explorer** – the **Explorer** tab shows, for the position on the
  board, the moves played from it with how often and how they scored:
  **Masters** (titled players since 1952) or **Lichess** games filtered by
  speed and rating, from the Lichess explorer (needs a Lichess API token in
  Settings → Lichess), or **Book**, Board's built-in opening book, offline.
  Hover a move to see it on the board, click to play it; click a top game to
  open it.
- **Puzzles** – the **Puzzles** tab plays Lichess puzzles on the board: the
  next puzzle by theme and difficulty, or the daily puzzle, from lichess.org;
  or offline from the Lichess puzzle database (`lichess_db_puzzle.csv` from
  database.lichess.org, decompressed), by rating and theme. Wrong moves are
  taken back, the opponent's replies come by themselves; Hint, View the
  solution, Try again. A puzzle rating, streak and counts are kept.
- **Drawing on the board** – right-drag an arrow, right-click a circle;
  green, or red with Shift, blue with Alt, yellow with both. A left click
  clears them.
- **Premoves** – against an engine, move during its turn; the move is
  played the moment it is your turn (if still legal). Right-click cancels.
- **Takeback** – against an engine, take back your last move (and its
  reply); in a game between people, the last move.
- **Keyboard** – ← → move by move, ↑ ↓ / Home End to the start and end, F
  flip, Z zen mode (only the board and players), L analysis, P pause it, B
  takeback, ? the list of shortcuts.
- **Captured pieces** – each player's bar shows the pieces they have taken
  and their lead in material (pawn 1, knight and bishop 3, rook 5, queen 9),
  for the position shown, so it follows you as you step through a game.
- **Engine windows** – the Analysis window and a window for each engine
  playing (its evaluation, current line, a log of its search for every move,
  and its messages) sit beside the move list. Drag the handle between the
  list and the windows to change their width, and the handle under each
  window to change its height; sizes are remembered, and double-clicking a
  handle resets it.
- **Fits the window** – the board takes the window's height, and the side
  panel uses the rest without empty space: the moves list keeps to the width
  it needs, with the engine windows, the computer analysis and the Game card
  in a column beside it, the last engine window stretching to the bottom.
  The tabs stay on one row; any that do not fit go into a **More ▾** menu.
  The other tabs (Games, Tournament, …) get more room, and on a narrow side
  panel the windows go below them instead. Text grows with the screen.
  Before a game starts, the tabbed panel takes the whole side.
- Move by clicking or dragging. Arrow keys step through the game.
- **Copy** puts the game on the clipboard as PGN; **Save…** (Ctrl/⌘+S)
  saves it to a `.pgn` file. Both work during or after a game.
- **Open…** (Ctrl/⌘+O) loads every game in a `.pgn` file. They are listed
  in the **Games** tab beside **Moves**; click one to show it, and step
  through it with the arrow keys. The first game is shown on opening.
  Comments and variations are skipped, games with an illegal move are
  marked in the list, and loaded games can't be played on. There is no size
  limit: the backend reads the file once to list its games, keeping only
  their headers, and reads a game's moves from disk when you select it.
- The opening is named from a built-in book of about 3,800 ECO-coded lines
  (Lichess's public-domain `chess-openings` data), so no engine is needed.
  Positions are matched, not move orders, so transpositions are recognised;
  the name follows you as you step through the moves, and saved games get
  `ECO` and `Opening` tags. See `backend/openings/NOTICE.md`.
- Engine `info string` messages appear under each engine's analysis. When a
  message names an opening (`Opening: …`, `ECO: …`, or text starting with an
  ECO code such as `B20 Sicilian Defense`), it is shown when the book has no
  name for the position. The bundled Random Mover reports
  common openings this way.

### Tournaments (SPRT)

The **Tournament** tab plays many games between two engines to tell
whether one is stronger, like cutechess-cli or fastchess:

- **Engines** – engine 1 is the one tested, engine 2 the base. Each opening
  is played twice with colours reversed (a pair).
- **Time control** – a clock (seconds + increment, e.g. 10+0.1), a fixed
  time per move, or a fixed number of nodes per move. An engine that runs
  over its time (by more than 100 ms) loses on time.
- **Games** and **Games at once** – how many games (0 plays until the SPRT
  decides) and how many run side by side; each game runs its own pair of
  engine processes, reused from game to game.
- **Openings** – the built-in book (about 1,900 lines, cut to the plies you
  set), an EPD file (one position per line) or a PGN file (the first plies
  of each game), in random or file order; or the start position.
- **SPRT** – tests H0: Elo = Elo0 against H1: Elo = Elo1 (logistic Elo) with
  error rates α and β, on pair results (pentanomial), and stops when the
  log-likelihood ratio (LLR) crosses a bound.
- **Adjudication** – a draw when both engines see the position within
  ±10 cp for 8 moves each from move 40; a win when both agree on ±1000 cp
  for 3 moves each; optionally a draw at a move limit.
- **Save games** to a PGN file (by default a new file in
  `Documents/Board/Tournaments`).

While it runs, the tab shows W–L–D, score, Elo with its 95% margin, LOS,
draws, the LLR between its bounds, the pair results, speed and time left,
the games in progress and the finished games (click one to view it).
**Show on board** follows one of the games live with both engine windows.
Analysis pauses while a tournament runs. **Stop** ends it; games in
progress are not counted.

**Report** (or **Report so far** while it runs) writes a detailed match
report as a single web page next to the games file and opens it. It works
offline, can be shared or printed, and has five views:

- **Summary** – games, W–L–D, Elo ± margin, LOS, draw rate, LLR; pair
  results; results with each colour; how games ended; all settings.
- **Progress** – the LLR between its bounds, the Elo estimate with its 95%
  band, and the score, after each pair.
- **Engines** – time per move and average depth for each engine, by move
  number; time losses and crashes; game lengths.
- **Openings** – every opening with each engine's results, sortable and
  searchable; click one to see its games.
- **Games** – every game, sortable and filterable; click one to replay it
  on a board with both engines' evaluations and times per move.

Every chart has a **Show data** table, and the report has light and dark
themes. **Save…** (Ctrl/⌘+S) in the report saves it anywhere as a web page,
**Save as PDF…** as one PDF with every view; **Save as…** in the Tournament
tab does the same for the last report. Opened in a browser, the saved page
can save itself too (and print to PDF). Moves are kept for the last 2,000 games of a match.

### Game database

**Settings → Database** can save finished games to a PGN file (by default
`Documents/Board/Games.pgn`; **Choose…** picks another, and an existing file
is added to, never replaced). Choose which games: games played here (human
and engine games that end with a result; aborted games are not saved),
Lichess games your engine plays, and Lichess games you watch to the end.
Each game is written with its players, ratings, time control, opening,
result and how it ended. **Open game database** in the Games tab (or **Show
in Games list** in Settings) lists them; while the file is open, new games
appear in the list as they finish.

### Sounds and resigning

Moves, captures, castling, check, promotion, the start and end of a game
(a win or loss when you play the computer), your clock dropping under 10
seconds, and illegal moves each have a sound. They are generated in code
(`app/renderer/sounds.js`), with a wooden set for the minimalist theme and a
synth set for cyberpunk. **Settings** turns them off or changes the volume.

While a game is being played, its controls sit on the player bars beside
the board: each person has **⚑ Resign** on their own bar, and the bar
nearest you has **½ Draw** (between two people) and **✕ Abort**. They ask
before acting, and are hidden when no game is in progress.

### Playing on Lichess yourself

**Play on Lichess** (at the top of the Lichess tab) plays people on
[Lichess](https://lichess.org) with your own account, moving on Board's board,
through Lichess's [Board API](https://lichess.org/api#tag/Board).

- **Sign in with Lichess** opens Lichess in your browser to approve Board
  (it asks to play games and to send and answer challenges). No app
  registration or password is involved, and the sign-in is kept, encrypted
  with the system keychain, until you **Sign out**. You can paste a personal
  API token with the `board:play` permission instead (**Use an API token
  instead**). Lichess has no way for apps to play without an account, so
  anonymous games are not possible here.
- **Quick pairing** (10+0, 10+5, 15+10, 30+0, 30+20, rated or casual) looks
  for an opponent in the Lichess lobby until one is found; press it again or
  **Cancel** to stop. Lichess lets apps seek **rapid and slower** games only;
  for blitz or bullet, **challenge a friend** by username with any time,
  increment and colour. Challenges sent to you are listed with Accept and
  Decline.
- The game takes over the board: you move on your turn (premoves work), the
  clocks are Lichess's, and your bar has **⚑ Resign**, **½ Draw** (offer),
  **↶ Takeback** (ask) and **✕ Abort** before both sides have moved. Your
  opponent's draw offers and takeback requests show on your bar with
  **Accept** and **Decline**. Your games are listed in the tab; **Play**
  brings a game back to the board.
- Lichess forbids outside help in these games, so while one is being played
  the analysis engine is off, the opening explorer is hidden and the computer
  analysis waits until the game is over.
- Finished games are added to the game database with your engine's Lichess
  games (Settings → Database).

### Playing on Lichess with your engine

Your engine can play on [Lichess](https://lichess.org) through the
[Bot API](https://lichess.org/api#tag/Bot). It needs a **Bot account**:

1. Create a new Lichess account for the engine (one that has never played a
   game) and, signed in to it, create an API token with the `bot:play`,
   `challenge:read` and `challenge:write` permissions (**Settings → Lichess →
   Create a token on Lichess** opens the page with these ticked).
2. Paste the token in **Settings → Lichess**, choose the engine and press
   **Connect**. The token is encrypted with the system keychain when one is
   available, and never shown again.
3. If the account is not a Bot account yet, Settings offers **Upgrade to Bot
   account**. This cannot be undone, so it only happens when you press it and
   confirm.

The **Lichess** tab beside the moves lists challenges to your bot (Accept or
Decline), lets you challenge any player or one of the bots online now
(time, increment, colour, rated), and lists the bot's games. Each game is
played by its own copy of the engine, on the Lichess clock. **Watch** shows
a game on the board, live, from your engine's side, with **⚑ Resign** and
**✕ Abort** on its bar; the first game takes the board by itself unless you
are playing one here. Analysis pauses while the bot is playing.

**Watch a player** (at the top of the Lichess tab) follows any player's
games — another bot, say — live on the board, one game after another, from
that player's side. No engine plays and no token or connection is needed;
you can turn Analysis on while you watch. **Stop** leaves the last position
on the board. Lichess shows other people's games a few moves behind.

**Challenge random bot** picks a bot online at random whose rating, at the
speed of the chosen clock (bullet, blitz, rapid…), is within the range you
set, and challenges it. If it declines or does not answer within 30
seconds, the challenge is cancelled and another bot is tried, until one
accepts; when every matching bot has been asked, it starts over after a
short wait. **Stop** ends the search.

Connecting never plays by itself: it lists challenges and games, nothing
more. Your engine plays only games you start here (Accept, or a challenge
you send). Games already going when you connect, or started elsewhere, are
listed as *Not played* with a **Play** button to hand them to the engine.

**Accept automatically** (in the Lichess tab, off after every connect)
accepts challenges that match your rules in Settings → Lichess
(rated/casual, people/bots, minutes, games at once) and declines the rest
with the matching Lichess reason, including variants and correspondence
games. Disconnecting while your engine is playing resigns those games,
after asking.

To try it without an account, run the stand-in server used by the tests:
`cd backend && go run ./lichess/testdata/fakelichess -addr 127.0.0.1:8765`,
set **Server** to `http://127.0.0.1:8765` and the token to `test` (add
`-notbot` to sign in as a person: **Sign in with Lichess** then works against
it too, and its lobby pairs you with a random-moving player), then send
challenges with `curl 'http://127.0.0.1:8765/_fake/challenge?from=Alice&limit=180&inc=2'`,
or start a game between two stand-in bots to watch with
`curl 'http://127.0.0.1:8765/_fake/autogame?white=maia1&black=SlowBot'`.

### Themes

**Settings** switches between themes; the choice is remembered. Each theme
changes the pieces, the board and the rest of the window:

- **Minimalist** (default): flat white and charcoal pieces on a light grey
  board, light UI.
- **Cyberpunk**: neon-outlined pieces on a navy board, dark UI.

A theme's pieces come from its folder in `svg/` (all twelve
`<color>-<name>.svg` files, e.g. `svg/minimalist/white-king.svg`); its colours
are CSS variables under `[data-theme="<name>"]` in `app/renderer/style.css`.
Pieces are scaled so each set's tallest piece fills 84% of a square, and any
glow (an SVG blur filter) is given room so it isn't clipped. To add a theme,
add a folder of pieces and a matching colour block.

### Time controls

Each side can have its own control, or both can share one.

| Type | Meaning |
| --- | --- |
| Clock | One or more stages: *N moves in M minutes + S seconds per move*. Leave the move count empty for "rest of the game". Presets cover bullet to classical, plus multi-stage tournament controls such as 40/90 then 30 with a 30 s increment. |
| Fixed time per move | Every move has the same budget. |
| Fixed search depth | Engines only. |
| No clock | Humans only. |

Running out of time loses, unless the opponent has no way to mate (draw).
Engines on a fixed time per move are trusted to keep it and are not flagged.

## Layout

```
app/                 Electron main process, preload and renderer (plain JS)
backend/             Go module
  chess/             rules: move generation, FEN, SAN, draw detection
  uci/               UCI engine process driver
  game/              game manager, players, clocks
  analysis/          the analysis engine, following the shown position
  pgn/               PGN reading and indexing of large files
  openings/          the embedded opening book
  lichess/           Lichess Bot API client and bot (fake/: stand-in server)
  cmd/basicengine/   the bundled "Board Basic" UCI engine
  cmd/randomengine/  the bundled random-move UCI engine
  main.go            JSON-lines server on stdin/stdout
svg/<theme>/         piece sets, one folder per theme: <color>-<name>.svg
scripts/             build helper
```

The renderer talks to the backend through Electron IPC; the main process
relays JSON lines such as `{"id":1,"cmd":"move","args":{"uci":"e2e4"}}` and
forwards events such as `state`, `engineInfo`, `analysis` and `lichess` back to the
window.

## Not included yet

Pondering, Chess960, and installers (the app runs from
source with `npm start`).
