# Ponder

A desktop chess GUI for UCI engines. The window is Electron; the chess rules,
clocks and engine processes live in a Go backend that Electron starts as a
child process.

Ponder was called **Board** before. The first time it starts under the new
name it brings your engines, Lichess settings and game database settings
along, and it keeps using `Documents/Board` for games and tournaments when
that folder is already there. Lichess tokens saved encrypted have to be
entered again, because the system keychain keeps them under the app's name.

## Run it

You need [Node.js](https://nodejs.org) 18+ and [Go](https://go.dev/dl/) 1.21+.

```sh
npm install
npm start        # builds the Go backend into ./bin, then opens the app
```

## Packaging

```sh
npm run package            # dist/Ponder-<platform>-<arch>/ (on macOS: Ponder.app)
npm run package -- --zip   # macOS: also dist/Ponder-<version>-mac-<arch>.zip
npm run package -- --arch=x64   # for the other processor (arm64, x64)
npm run package -- --platform=win32 --arch=x64 --zip   # for Windows, from a Mac
```

This builds the Go backend and the two bundled engines for that processor
and puts them, the window's files and the piece sets into an Electron
bundle that runs without Go, Node or the source. The package is for the
system it is made on unless `--platform=` names another (`win32`, `darwin`,
`linux`): Go and Electron's packager both build across systems, so a Windows
package (`dist/Ponder-win32-x64/Ponder.exe`) can be made on a Mac. The first
time, Electron for that system is downloaded. A Windows package made this
way is not code-signed, so Windows SmartScreen warns before running it. On macOS the bundle is
signed ad hoc, which is enough to run it on the computer that built it;
another Mac will refuse it as from an unidentified developer until it is
signed with a Developer ID and notarized. Its icon is made from `icon.svg`: after changing the drawing, run
`scripts/make-icons.sh` (needs librsvg and ImageMagick) to make the icon
files again.
Your settings, engines and game database are kept where they were.

`npm test` runs the Go tests (move generation perft, clocks, full games).

## Using it

The window opens maximised and is laid out for a full screen (F11, or ⌃⌘F
on macOS, for true full screen): the board takes the full height, and the
rest holds the moves or game list beside engine analysis and game details.

- **New game** – choose Human vs Human, Human vs Computer or Computer vs
  Computer, pick engines, and set the time control.
- **Settings → Engines** – add any UCI engine (Stockfish, Lc0, …) by
  picking its executable. The engines are listed on the left, one short
  line each, sorted by name (the built-in engine first), with a
  **Find an engine** box that searches names, paths and command lines; a
  hollow dot marks an engine with options or a command line set, a solid
  one an engine used for analysis or on Lichess. Arrow keys, Home and End
  move through the list. The chosen engine's details show on the right:
  its name, full program path, command line, the options set and
  **Remove engine**. Its options open as soon as it is added, and
  later under **Options** (Threads, Hash, Skill Level, …): every option the engine offers, grouped (Basics,
  Evaluation and opening book, Endgame tablebases, Logging, Search and
  tuning), each with its default and range, a slider for small ranges,
  **Browse…** for files and folders (Syzygy path, network, book, log), a
  reset, a search box and **Changed only**. Out-of-range numbers are caught
  before saving; only options changed from the engine's defaults are sent,
  and saved options take effect at once: the analysis engine restarts with
  them, and a copy of the engine playing now (the game on the board, the
  Lichess bot's games) is sent the changes right away, or just before its
  next search when it is thinking (UCI engines take options only between
  searches); an option reset to its default gets the engine's default back.
  Tournaments keep the options they started with. **Command line** sets the options the program is started with (for
  engines that need e.g. `--uci` or a network file); spaces separate them
  and quotes keep spaces in one, and Ponder checks that the engine starts
  with them. They apply everywhere the engine plays: games, analysis,
  tournaments and Lichess. Two engines are bundled so everything works straight away: **Ponder
  Basic**, a small real engine (alpha-beta search, a few moves deep, MultiPV)
  and **Random Mover**, which plays random legal moves.
  The options are sent each time the engine is loaded (a game, the
  analysis, the computer analysis, test positions, a tournament, a Lichess
  game), right after it starts and before anything else: in the order the
  engine lists them, under its own names, numbers kept within their range,
  and the engine is asked to confirm it is ready, so one that stops over an
  option is reported then.
- **Analysis** (toolbar) – an engine analyses the position on the board and
  shows its best lines with evaluations, an evaluation bar beside the board
  (a line marks its middle, where the score is level, with the score on a
  plate just above it, signed from White's side; a face at each end,
  White's and Black's, smiles as the score favours its
  side, goes flat when it is level and frowns as it turns against it)
  and an arrow for the best move, with a small tag of the depth reached
  (plus a thinner dashed arrow for the reply
  it expects to that move, its ponder move), with the other lines' first moves as
  thinner arrows in their own colours (marked beside each line in the
  Analysis window; turn them off in Settings → Analysis). It follows the board as you play, step
  back through the moves or browse games from a file. Choose the engine and
  the number of lines (1–5) in **Settings → Analysis**; it runs as its own
  process, separate from engines playing a game, and pauses while an engine
  is playing. **⏸** in the Analysis window (or the **P** key) stops the
  engine thinking and keeps its lines on screen; **▶** analyses the
  position then on the board. While the analysis is on, the Analysis button
  shows an activity icon, which turns while the engine is thinking and
  stands still while it is paused, and a meter marked CPU of the computer's
  processor load (all cores, every program) with the figure beside it, read once a
  second; while the analysis is paused the meter reads **Paused** instead. When a game you are
  watching ends (someone's on Lichess, your engine's, a tournament game),
  the analysis pauses by itself (as soon as the result is in) and takes up
  again when the next game starts, or when a game it lost the connection
  to comes back; not if you had paused it yourself, and not once you turn it off.
- **Moves list** – one row per move number as on Lichess (number, White,
  Black), with the result at the end; click a move to go to it. Each move
  starts with an icon of the piece that moved (in the board's piece theme;
  castling shows the king) and ends with the score after it, from White's
  side: the computer analysis once it has run, otherwise the evaluation the
  engine that played the move reported (in italics; hover for its depth).
  Both can be turned off in Settings → Appearance → Moves list.
- **Start screen** – before the first move the Moves tab shows ways to
  begin: New game, Lichess, Puzzles, Openings, Open PGN and Analyse; the five
  latest games in the open file (your game database, usually), a click away;
  and a box to paste a PGN or a FEN onto the board. It gives way to the
  moves as soon as a piece moves.
- **Computer analysis** – after a game (or for a game from a PGN file),
  **Computer analysis** in the Moves tab has the analysis engine evaluate
  every position (Fast 0.2 s, Normal 0.6 s or Deep 1.5 s a move). Then, as on
  Lichess: an advantage chart (click to jump), inaccuracies **?!**, mistakes
  **?** and blunders **??** in the moves list with the better move, and each
  player's counts, average centipawn loss and accuracy. **Stop** keeps what
  was analysed so far: the chart, marks and figures cover the moves reached.
  **Continue** picks up after the last move analysed, and **Start over**
  runs it all again. With **Comment the
  moves** ticked, each inaccuracy, mistake and blunder also gets a written
  comment (the better move and its line, mates missed or allowed, and how
  the evaluation moved) and its mark, as annotations you can edit and save;
  any comment or mark already on a move (yours, the file's, the AI's, an
  earlier analysis's) is left as it is, an evaluation the file carries is
  kept, and **Remove its comments** takes the analysis's off again.
- **Versus screen** – when a game you are watching starts (a Lichess
  player's, or your engine's), the whole window dims and the two players'
  cards come in from either edge of it to face each other across a **VS**: colour, name,
  title, flag and rating, with their games, record and recent form once
  Lichess has answered, the event underneath and their score against each
  other. A 1990s arcade fighting-game fanfare plays as they arrive (a thud,
  three rising chords and a crash, in place of the usual game-start sound;
  it follows the Sounds setting). After a few seconds they go off the way
  they came; a click or Esc
  sends them away at once. The next match of a player you are already watching gets it too, even
  when it is picked up a few moves in, and so does a new game of a player
  you watch who is in several at once: its cards come up over the game on
  the board, marked *Another game*. When a game starts while a result
  screen is up, its cards wait for that to go. A game you join part way through, tournament
  games and your own games do not show it. Turn it off under **Settings →
  General**.
- **Result screen** – when a game ends (one you play, your engine's, or
  one you watch; not a tournament's games), the result fills the window in
  the manner of a 1990s fighting game: a word slams in with a flash
  (**CHECKMATE**, **TIME OVER**, **K.O.** for a resignation or anything
  else decisive, **DRAW GAME**), then who won ("You win", "Your engine
  loses", "Magnus wins"; for a draw, why: "Threefold repetition",
  "Stalemate", "Fifty-move rule", "Insufficient material", "By agreement"),
  then both players' cards with the score between
  them, the winner's lit and the loser's greyed and knocked askew, with
  ratings and their changes once Lichess sends them, and how the game
  ended. It goes after about five seconds, or at once on a click or Esc,
  leaving the result card. When your engine plays several Lichess games at
  once, or the player you watch is in several, one that ends while another
  is on the board gets the screen too, marked *Another game*, with its
  sound; the board stays on the game it shows. When the board's game ends
  and the next one takes the board straight away, the screen stays up for
  its few seconds. An **Analyze with AI** button under the result
  goes straight to the AI's analysis of the game (not for another game's
  result: put that game on the board first). Turn the screen off under
  **Settings → Appearance**.
- **Captures** – a captured piece lifts off its square and flies, spinning,
  shrinking and fading, into the captured pieces on the bar of the player who took it,
  where it lands in its place. It follows the move animation setting (off:
  no flight).
- **Pieces under attack** – a piece that more enemy pieces attack than its
  own side defends wears a red target on its corner with the difference
  (+1: one more attacker than defenders), for the position shown (live,
  stepping through a game, or in a variation). A piece defended as often as
  it is attacked has no mark. It goes by how the pieces move, so a pinned
  piece still counts and a piece lined up behind another does not. Turn it
  off under **Settings → Appearance**; zen mode hides it.
- **Side variations** – once a game is over (or opened from a file), moves
  played on the board become variations, as on Lichess's analysis board:
  they appear under the move they replace, nested lines in parentheses.
  Click a move to go to it, ← → walk through a line, ✕ deletes one. Playing
  the game's own move just follows the game.
- **Saved analysis** – **Save…** and **Copy** include the computer analysis
  in Lichess's form (`{ [%eval 0.35] }` after each move, `$6 $2 $4` for
  ?! ? ??, with the better move) and the side variations.
- **Opening card** – point at an opening's name (beside the status line, in
  the Game card, in the Explorer tab or in a tournament's game list) and a
  card comes up with the moves that make the opening, its history, its
  strengths and its weaknesses. The write-ups are built in (no connection
  needed) and cover the opening families and their best-known variations;
  a line deeper in the book gets the write-up of the nearest one above it,
  and says so. A few rare openings have none yet.
- **Opening explorer** – the **Explorer** tab shows, for the position on the
  board, the moves played from it with how often and how they scored:
  **Masters** (titled players since 1952) or **Lichess** games filtered by
  speed and rating, from the Lichess explorer (needs a Lichess API token in
  Settings → Lichess), or **Book**, Ponder's built-in opening book, offline.
  Hover a move to see it on the board, click to play it; click a top game to
  open it.
- **Puzzles** – the **Puzzles** tab plays Lichess puzzles on the board: the
  next puzzle by theme and difficulty, or the daily puzzle, from lichess.org;
  or offline from the Lichess puzzle database (`lichess_db_puzzle.csv` from
  database.lichess.org, decompressed), by rating and theme. Wrong moves are
  taken back, the opponent's replies come by themselves; Hint, Solution,
  Try again, Leave. Your puzzle rating, solved and failed counts and streak
  are kept, and shown at the top of the tab; the puzzle being played shows
  who is to move (a tick when solved, a cross on a wrong move) and the
  moves so far.
- **Drawing on the board** – right-drag an arrow, right-click a circle;
  green, or red with Shift, blue with Alt, yellow with both. A left click
  clears them.
- **Premoves** – against an engine, move during its turn; the move is
  played the moment it is your turn (if still legal). Right-click cancels.
- **Takeback** – against an engine, take back your last move (and its
  reply); in a game between people, the last move.
- **Swap or reload an engine** – mid-game, **⇄ Engine** on an engine's
  bar opens a menu: **↻ Reload** starts it again (with its options as now
  saved under Settings → Engines, so a changed option or a stuck engine is
  fixed without a new game), or pick another engine to take over from the
  position reached, on the same side and clock. Its clock waits while the
  new engine starts; if that one can't be started, the engine before comes
  back.
  In your engine's Lichess game, its bar has **⇄ Engine** too, with
  **↻ Reload** only: the engine starts again with its options as saved now,
  and goes on from the position. Swapping for another engine isn't offered
  there.
- **Keyboard** – ← → move by move, ↑ ↓ / Home End to the start and end, F
  flip, Z zen mode (only the board and players). Flip and zen mode are also the two
  icons at the board's bottom right corner, L analysis, P pause it, B
  takeback, U classical music, ? the list of shortcuts.
- **Menu** – the application menu holds Ponder's commands: **File** (New
  Game ⌘N, Open PGN ⌘O, Open Game Database ⇧⌘O, Test Positions, Save Game
  ⌘S, Copy Game as PGN ⇧⌘C, Copy Position as FEN ⌥⌘C, Paste Game or
  Position ⇧⌘V: a PGN or a FEN from the clipboard), **Game** (takeback, move
  by move, flip, annotate), **Analysis** (analyse, pause, explorer, the AI
  chat ⌘J, engine and analysis settings), **Lichess** (play, TV, your bot,
  puzzles), **View** (the tabs ⌘1–⌘6, zen mode, appearance, sounds, music,
  zoom, full screen) and **Help** (keyboard shortcuts, links). On Windows and
  Linux the menu bar shows with Alt. (Ctrl in place of ⌘ there.)
- **Classical music** – the note button beside the board (or U) plays
  classical music in the background: a live radio station (Radio Swiss
  Classic, Venice Classic Radio, BR-Klassik, Klassik Radio, Radio Classique,
  NPO Radio 4, WQXR or Classical KUSC, streamed from the internet), any
  internet radio station you add, or the music files in a folder of your
  own, shuffled. To add a station choose **Add a station…** in the list and
  give its stream address (MP3, AAC or Ogg) or a .pls or .m3u playlist
  link, as the station's site or a directory such as radio-browser.info
  gives it, and a name if you like; it is checked, then plays, and stays on
  your list until you press **Remove**. Streams over plain http play too.
  HLS streams (.m3u8) cannot be played. Choose it and its volume
  (apart from the game sounds) in Settings → General → Music; it starts
  again with the app if it was playing when you closed it.
- **Captured pieces** – each player's bar shows the pieces they have taken
  and their lead in material (pawn 1, knight and bishop 3, rook 5, queen 9),
  for the position shown, so it follows you as you step through a game.
- **Engine windows** – the Analysis window and a window for each engine
  playing sit beside the move list, kept compact. The Analysis window is as
  tall as its lines, one row each however long the line gets: hover a line
  for all of it, or click it to wrap it in full. An engine's window (for
  each engine playing, and for your engine when you watch its Lichess game)
  is built the same way: its name, depth, nodes and speed on one row, then
  one row per move it searched, newest first, with the move number, the
  score and the line it had in mind. It is as tall as its rows up to eight,
  then older rows scroll inside it; its messages sit underneath. Drag the
  handle between the list and the windows to change their width; the width
  is remembered, and double-clicking the handle resets it.
- **Game card** – beside the moves, the Game card sums up the game on the
  board: the event and result, the two players, the time control, opening
  and other details. For a game that is over or opened from a file (eight
  plies or more), it also shows a large board with the position from the
  middle of the game, in the current theme, beside the details (above them
  in a narrow card). **Middle / End** under it switches to the final
  position; click the board to go to that move.
- **Fits the window** – the board takes the window's height, and the side
  panel uses the rest without empty space: the moves list keeps to the width
  it needs, with the engine windows, the computer analysis and the Game card
  in a column beside it.
  The tabs stay on one row; any that do not fit go into a **More ▾** menu.
  The other tabs (Games, Tournament, …) get more room, and on a narrow side
  panel the windows go below them instead. Text grows with the screen.
  Before a game starts, the tabbed panel takes the whole side.
- **When a game ends** a card in the middle of the window says who won and how (a draw with its reason, such as threefold repetition; Lichess
  says only that a game was drawn, so Ponder reads the reason off the final
  position, and a draw the board does not explain is given as by agreement): *You
  won!* (green), *You lost* (red) or *Draw* when you played (or *Your engine
  won/lost* for its Lichess games), otherwise *White wins* / *Black wins*
  with the players' names. It has **Computer analysis**, **Analyze with AI**
  (opens the AI panel on a new chat and asks the model to go over the game:
  how it went, the opening, the turning points and each side's decisive
  mistakes; you can carry the conversation on from its answer), **New game**
  and **Close** (or Esc, or click beside it); each player bar shows its score (1,
  0 or ½), a win or loss sound plays, and if Ponder is not the window in
  front, a desktop notification says the result. After a **rated Lichess
  game** (yours, your engine's, or one you watch), the card, the
  notification and the player bars also show each player's rating change
  (e.g. *−8 rating · 1500 → 1492*), as soon as Lichess has worked it out. The card can be turned off
  in **Settings → Appearance → Board**.
- **Positions…** opens test positions to analyse: the 300 **Win at Chess
  (WAC)** positions are built in, and **Open EPD…** adds any EPD file
  (Bratko-Kopec, Arasan, your own). Find one by number or name, see it in
  the preview, and double-click (or Enter, or **Analyse**) to put it on the
  board with the side to move at the bottom and the analysis on. A bar over
  the moves shows its number, the side to move, **Show solution** (hidden
  until asked), whether the analysis plays the solution yet, and ◀ ▶ to go
  through the set.
- **Test an engine** (in **Positions…**) runs any engine on the whole set
  (**Test all**) or the selected position, for a set time per position
  (**Time**, 1000 ms by default; it is remembered), with several positions
  searched at once if you like (**At once**, each by its own copy of the
  engine). Each position shows ✓ with the engine's move, when it settled on
  it and the depth, or ✗ with the move it played; a bar counts solved
  positions and the time left, and **All / Solved / Missed** filters the
  list. **Test engine** on the bar over the moves tests the position on the
  board. Your engine's options apply (MultiPV and Ponder are left out).
  When a run of several positions ends (or is stopped), a **Test results**
  screen opens: solved and missed counts with percentages, the average,
  median and slowest time to solve, the average depth (and on the missed
  ones), search speed and nodes, and how long the run took. Under them is
  every position that was not solved, with a small board, the side to
  move, what was asked (the best move, or the move to avoid), the EPD's
  comment if it has one, and what the engine played with its depth, score,
  nodes and line. **Load on board** puts that position on the board;
  **Results…** on the test bar opens the screen again.
  After a run, **Review missed (N)** on the bar makes a set of just the
  missed positions: ◀ ▶ step through them, and the moves list shows the
  solution (green) and the engine's move with its line, depth and score
  (red) as side lines you can click through.
- Move by clicking or dragging. Arrow keys step through the game. Pieces
  slide to their new square and captured pieces fade out, also when stepping
  through a game one move at a time; set the speed (or turn it off) under
  **Settings → Appearance → Board**. A piece you drag is not animated again.
- **Open…**, **Save…** and **Copy** sit under the moves list, in the Moves
  tab.
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
- Engine `info string` messages appear under each engine's analysis: the
  newest one only, until you click it to show them all (click again for less). When a
  message names an opening (`Opening: …`, `ECO: …`, or text starting with an
  ECO code such as `B20 Sicilian Defense`), it is shown when the book has no
  name for the position. The bundled Random Mover reports
  common openings this way.

### Annotating a game

**Annotate** under the moves (or **A**) opens a panel for the move shown, in
the game or in a variation:

- **Marks** on the move: `!` `?` `!!` `??` `!?` `?!`. Your mark stands in for
  the computer analysis's on that move.
- **Evaluations** of the position: `=` `∞` `⩲` `⩱` `±` `∓` `+−` `−+`.
- **A comment**, shown under the move; with no move selected (the start
  position) it is the comment before the first move.
- **Variations**: once the game is over or opened from a file, play a move
  on the board to start a line; its moves take marks and comments too.

The annotation of the move shown opens up: larger type, more room and a
stronger tint, so it reads at a glance as you step through the game.

An annotation written by the AI model (AI annotate, the live commentary)
wears an **AI** badge in the moves list and its own look: italic, a dashed
edge and a wash of the accent colour. It is marked `[%ai]` in the saved PGN,
so it is still known as the AI's when the game is opened again; edit it and
it becomes yours, without the badge.

In the moves list an annotation takes the colour of its mark: green for
good and brilliant moves, purple for interesting, blue for inaccuracies and
dubious moves, amber for mistakes, red for blunders; a comment with no mark
is grey.

Annotations are **saved by themselves**, a moment after they change:
comments and marks, and those the computer analysis, AI annotate and the
live commentary add. Variations do not count: a line you try on the board
is not saved by itself (the button reads **Save** until you save it by
hand), though a line the file already had is always kept, and a
comment or mark on a move of a tried line makes that line the game's, up to
that move, and saves it. The game is written with all of it (and the
computer analysis's evaluations, if there is one) over itself in its PGN,
as standard PGN (`$` glyphs, `{ }` comments, `( )` variations): the file it
was opened from, or, for a game played or watched here, its entry in the
game database it was added to when it ended (found by its players and
moves while that file is the one listed in the Games tab; its tags stay as
they were). The button in the Annotate panel reads **Saved** when
everything is saved and **Save** when something is waiting (its tooltip
names the file), and saving by hand writes every line on the board. A game that is in no open file has **Save as…**
instead, to save it as a new one. Opening a
game brings its comments, marks and variations back; `[%clk]` and the like
are kept as they were.

### AI annotate

**AI annotate** in the Annotate panel sends the game on the board to an AI
model and turns its commentary into annotations: a summary before the first
move, and a comment and a mark (`!`, `?`, …) on the moves it picked out.
They are ordinary annotations, so you can edit them and **Save** writes them
into the PGN (with an `Annotator "AI (model)"` tag). Your own comments and
marks are never replaced, and neither is any other annotation already on
the game (from its file, the computer analysis, or an earlier AI run): the
AI only fills in moves that have none, and says how many it left as they
are. To have it annotate afresh, take its earlier ones off first. **Remove the AI's
annotations** takes them off. There is no time limit: it waits for the
answer however long the model takes (a local model can need many minutes on
a long game), showing how long it has waited, until you press **Stop**.

The model is chosen under **Settings → AI**:

- **Provider** – who runs the model:
  - **Local or other server**, the default: any OpenAI-compatible API.
  - **OpenAI**.
  - **Claude (Anthropic)**.
  - **Google AI (Gemini)**.

  Each provider keeps its own model and API key, so you can switch between
  them without typing either again.
- **Endpoint** – for a local or other server only: `http://localhost:8000/v1`
  by default, for a local server such as oMLX, LM Studio, Ollama, llama.cpp
  or vLLM (`localhost:8000` is enough to type); any other OpenAI-compatible
  address works too.
- **Model** – the model to ask, chosen from a list of the models the
  provider offers you, fetched when the settings open; **Refresh** asks
  again (for OpenAI only its chat models, for Google its Gemini and Gemma
  models, and from a server that says what each model is for, such as
  oMLX, not its speech or embedding models). With the first choice,
  Ponder chooses:
  - a local server: the first model it lists;
  - Claude: `claude-opus-5-5`;
  - Google: a Gemini Flash model;
  - OpenAI: none, so pick one.
- **Context window** – how many tokens the model takes in, for the AI
  panel's context meter. Leave it empty to use what the provider reports.
- **API key** – needed for OpenAI (platform.openai.com), Claude (the Claude
  Console, platform.claude.com) and Google AI (Google AI Studio,
  aistudio.google.com). Local servers usually need none. Keys are kept
  encrypted with the system keychain where there is one, and are never shown
  again.

AI is off until you turn on **Use an AI model** at the top of Settings → AI.
While it's off, the AI button, AI annotate and live commentary are hidden,
and nothing is sent anywhere. Settings from before the switch existed count
as on if a model or key was already chosen. The speech server has its own
switch, **Use a speech server**, also off by default. While it's off, the
commentary and the announcer use the computer's own voices.

Even when AI is on, without a key Ponder doesn't contact OpenAI, Claude,
Google AI or any server outside this computer and its local network
(localhost, a private address or a `.local` name). AI annotation, the chat
and the live commentary say that a key is missing instead. The speech
server follows the same rule.

How each provider is reached:

- **OpenAI** and **Google AI** are reached through their OpenAI-compatible
  chat APIs; Google AI uses the Gemini API's OpenAI compatibility endpoint.
  OpenAI's newer models only work at their own default temperature, so
  Ponder sends OpenAI none.
- **Claude** is reached through Anthropic's official SDK, `@anthropic-ai/sdk`,
  which has to be installed once with `npm install @anthropic-ai/sdk` in
  Ponder's folder. Until then, choosing Claude says so.
  - Answers stream in as they are written.
  - Claude's summarized reasoning shows like the thinking of local models.
  - On the models that offer it (Claude Fable 5.2 and 5.1, Opus 5.5 and 5,
    Sonnet 5.5), a request Claude declines on safety grounds is answered by
    another Claude model in the same call (Anthropic's server-side fallback).

What is sent, only when you press the button: the game's full PGN, with
its tags (the players' names and ratings as `WhiteElo` and `BlackElo`, the
event, the date, the time control, the opening) and any annotations and
computer-analysis evaluations already on it. Its moves are also sent
numbered, and the players' names, ratings and the result are repeated at
the top. The AI chat and the live commentary send the same full PGN. With OpenAI, Claude,
Google AI or any other hosted endpoint, that leaves your computer.

### AI chat

The AI chat is a panel that floats over the right of the window: open it
with the spark button in the toolbar or the **AI** handle on the window's
right edge, and collapse it back to the handle with its ⇥ button, **Esc**,
the toolbar button again, or a click anywhere outside the panel. The
**pin** in its top row keeps it open when you click elsewhere (so you can
work on the board with the chat beside it); the pin is remembered. Drag its left edge to change its width
(double-click to reset); whether it is open, and its width, are remembered.
While it is collapsed the handle's spark turns as the model answers and
shows a dot when an answer has arrived.

It is a conversation with the same model about the game on the
board: ask why a move was played, what the plan is, where the game turned.
Each message goes with the game as PGN (annotations and engine evaluations
included), the position the board shows and whose move it is, and, when
Analysis is running on that position, the engine's top lines, so "here" and
"this move" mean what you are looking at. While the model works a spark turns beside *Thinking…*, with
the last lines of its thinking underneath when it shares them; afterwards
*Thought for N s* opens the whole of it. The answer flows onto the page
at an even pace however unevenly the model sends it, each new run of words
fading in softly, with its lists, bold and code set as such, and a copy button under
it; **Stop** ends it where it is, **Enter** sends (Shift+Enter for a
new line), and **+ New chat** opens another conversation in its own tab inside the panel, named
after its first question. Tabs keep their conversations (and what you were
typing) until closed with ✕ or the app is closed; one answer is written at
a time, and its tab shows a dot while it is. A language model can be wrong about tactics; it is told to
go by the engine's evaluations where there are any.

Hovering a message shows small buttons under it. Under one of yours:
**copy**, and **go back** (the pencil), which takes that message and
everything after it out of the conversation and puts its words in the box
to change and send again. Under an answer: **copy**, and **ask again**,
which replaces that answer, and what followed it, with a new one.

**Context meter.** The AI panel's top bar shows how much of the model's
context the last request used, for example `13k / 200k` with a small bar.
In the Chat view it is the chat shown; in the Commentary view, the last
comment. The count is what was sent (the instructions, the game as PGN and
the conversation) plus the answer, which the next message sends again. The
bar turns amber at 75% and red at 95%; hovering gives the exact numbers.

- **Where the counts come from:** the provider reports the tokens used.
  OpenAI-compatible servers are asked for them at the end of the answer
  (`stream_options.include_usage`); a server that refuses that is asked
  again without it, and then shows no meter.
- **Where the window size comes from:** Claude's Models API, Google's model
  information, and from a local server LM Studio, llama.cpp or Ollama (the
  context as loaded).
- **When it is not known** (OpenAI does not report it), the meter shows the
  tokens alone; set **Context window** under Settings → AI to see how full
  it is. A number set there also wins over what the provider reports.

The conversation's typeface and text size are set under **Settings →
Appearance → AI chat**: **Font** (System, Serif, Rounded, Monospace, or **Other…** with the
name of any font on the computer) and **Text size** (80–150%), with a
sample line showing the choice.

### Live commentary

With **Live commentary** on (the AI panel's **Commentary** view), the AI
model comments on a game as it is played, like a commentator on a
broadcast: your own game, an engine's, a Lichess game, or a tournament game
on the board. Every few moves (**every** move, 2, 3, 5 or 8 moves; 2 to
begin with) it is sent the players with their ratings, the game so far as
full PGN (its tags, among them the players' names and ratings, and its moves), the moves since
its last comment, the position now as FEN, the engine's evaluation when
there is one, and a couple of its own earlier comments, and answers in one short sentence.
When the game ends it is asked for a summary of two or three sentences.

The latest comment shows in a **Commentary** card beside the board, written
as it comes, and stays there while the next is being thought of (**All…** opens the whole commentary in the AI panel, **Off**
turns it off); the panel's Commentary view keeps every comment of the game.
Above each comment is a row of the moves played since the comment before
it, the last of them (the move the comment is about) picked out in the
accent colour; a click on a move shows it on the board. The summary is set
apart at the end, with the last moves of the game. A new game
starts a new commentary. It runs beside the chat without interrupting it,
uses the model from **Settings → AI**, and turns itself off with a
notification if the endpoint does not answer. The comment that failed has
a **Retry** button (on the card and in the Commentary view): it asks again,
covering the moves the failed comment would have and any played since, and
turns commentary back on; a summary that failed is asked for again the same
way. Comments are not saved with
the game.

**The commentator.** The comments are said by a little pixel-art chess
piece floating over the window, in place of the Commentary card. It is on
unless you turn it off. It shows only while live commentary is on: turn
commentary off and the character goes; turn it on again and it comes back
with its last comment. Choose who says them under **Settings → AI →
Commentator**, where each one has a card:

- **Esper**: a white pawn in a headset and a blue scarf, the announcer and the default.
- **Onyx**: a black pawn with a gold scarf.
- **Bastion**: a stone rook.
- **Mitzi**: a bishop in a lavender mitre.
- **Rex**: a king with a gold crown.
- **Regina**: a queen with a tiara and long hair.

Picking one while the commentator is off turns it on. Each comment comes out
of the character in a large comic-book speech bubble with a yellow caption
giving the move it is about. The bubble pops out and the character hops.
Each comment stays until it has been read: while it is read aloud, or else
for a few seconds by its length (about a third of a second a word). A
comment that comes sooner waits its turn. While the model thinks of the next
comment, the last one stays in the bubble and a little thought bubble of
dots appears beside the character's head; only before the first comment
does the bubble itself say "Hmm…". The mouth moves while the words come in
or are read aloud, and the character blinks and bobs while waiting. The
summary at the end is its **Final word**, said with a big smile. The bubble
puts itself away some seconds after a comment is complete (not while it is
being read aloud or the pointer is over it). Click the character to bring it
back or put it away; drag the character anywhere, and it stays there. The
bubble opens towards the side of the window with more room. Its buttons read
aloud, open all of the commentary (**All**), and retry a comment that
failed. Turn the commentator off with **Show a commentator character that
says the live commentary** under Settings → AI, or **A commentator character
says the commentary in a speech bubble** in the Commentary view, and the
card comes back. With reduced motion, the character stays still.

**Annotate the game with the commentary** (in the Commentary view) puts
each comment on the move it followed as an annotation, and the summary
before the first move: they show in the moves list, can be edited under
**Annotate**, and are in the PGN when you **Save** or **Copy** the game.
Turning it on part way through a game adds the comments made so far. Your
own comments, and any other annotation already on a move, are left as
they are, and **Remove the AI's annotations** (under
Annotate) takes the commentary off again. When the game ends and is added
to the game database, the commentary's annotations are saved into it by
themselves (while the database is the file listed in the Games tab).

**Read aloud** (in the Commentary view, or the speaker on the card) speaks
each comment and the summary as soon as it is complete, with the
computer's own speech: choose the **voice** and the **speed**, and **Test**
to hear it. Moves are said as words ("Nf3" as "knight f3", "O-O" as
"castles kingside"). A comment is never cut off: the next one waits
for it to finish, and no further comment is asked for while one is
waiting, so the next covers all the moves played since and the voice keeps
up with the game. A new game does not cut off the last game's summary; ▶ on a comment in the list reads that
one again. With a voice of the computer, the speech is made on the
computer: no audio or text is sent anywhere for it.

The voice can instead be a **speech server**: any OpenAI-compatible
text-to-speech endpoint (`POST …/v1/audio/speech`), OpenAI's own or one you
run, such as Kokoro-FastAPI, openedai-speech or LocalAI. Set it under
**Settings → AI → Commentary voice**: the endpoint (`localhost:8880` is
enough for a local server), the model and the voice, each chosen from a
list, an optional speaking style for models that take one
(gpt-4o-mini-tts), and the API key, kept encrypted like the AI keys (with
none, OpenAI's endpoint uses the OpenAI key above it). The model list is
the endpoint's speech models (when it lists others too, the ones it says
or whose names show are for speech), fetched when the settings open;
**Refresh** asks again. The voice list is the chosen model's voices,
where the server lists them (oMLX and Kokoro-FastAPI do; OpenAI's are
known), else OpenAI's names, which servers copying its API take. With the
first choice, the endpoint's first speech model and the model's own voice
are used (OpenAI's defaults at OpenAI). A server that cannot make MP3 is
asked for WAV. **Test** plays a sentence. Then choose **Speech server** as the voice in the Commentary
view: each comment's words, with the moves said as words, are sent to the
endpoint and the sound it answers with is played, at the speed chosen
there. If the server cannot be reached, the reason shows under the
commentary and the comment is skipped.

### Announcer

The **announcer** (**Settings → General → Announcer**, off at first) is a
quick voice for the game being played, with no AI: it says what happens as
it happens. Each part can be turned on or off:

- **Moves**: every move, only captures, checks, castling and promotions,
  or none. Said as words ("knight takes f7, check", "castles kingside",
  "e takes d5"), optionally with who moved ("Magnus: knight f3").
- **Score swings**: when the score moves by at least the amount chosen
  (0.7 to 3 pawns, or never) and who stands better changes: "White has a
  clear advantage", "The game is level". A swing of two pawns or more
  against the side that just moved is called a blunder. The score is the
  playing engines' own evaluation, or the analysis's when it is on (once
  it has searched to depth 12).
- **A mate found**: "Black has mate in 3!"
- **The opening**, as it gets its name early in the game.
- **Low on time**: a player at the board with under 10 seconds.
- **The players at the start**, and **how the game ended** ("Stockfish
  wins by checkmate", "Draw by threefold repetition").
- **The players' names** in place of White and Black.
- **Captions**: what is said shows over the foot of the board for a moment,
  for when the sound is off.

It speaks with the live commentary's voice, or a voice of its own (one of
the computer's, or the speech server of Settings → AI) at its own speed;
**Test** plays a sample. It follows games played on the board (yours, an
engine's, a Lichess game), not tournament games. When the AI's live
commentary is speaking too, they take turns, the announcer's short lines
first; only the latest two wait, and one that has waited six seconds is
dropped, so the voice keeps up with a quick game.

**Personality** sets how it puts things, each with several lines to pick
from so it doesn't repeat itself:

| Personality | Sounds like |
| --- | --- |
| Classic | "Magnus has a clear advantage." |
| Hype | "Oh no! A blunder! Hikaru is cruising to victory!" |
| Zen | "A misstep. It happens to us all." |
| Butler | "Oh dear. I do believe Hikaru is winning." |
| Robot | "Evaluation: Magnus plus 2.1. Significant." |
| Pirate | "Shiver me timbers! Treasure in sight for Hikaru!" |
| Snarky | "Wow. Bold choice. It's Hikaru's game. Wake me at the end." |
| Surprise me | a different one for each game |

Besides the start, the opening, score swings, mates, low time and the end,
some personalities now and then add a word to a capture, a check, castling
or a promotion ("Queen takes f7, checkmate! Game, set and match!"). Each
also shades the speed and, with a computer voice, the pitch.

### Keeping the screen awake

**Settings → General → Screen → Keep the screen awake** stops the
screensaver and the display going to sleep: **never**, **while a game is
played** (the default: a game on the board with a clock or an engine
moving, a live Lichess game, or a tournament running), or **always** while
Ponder is open. Keeping the display on also keeps the computer from
sleeping.

### Tournaments

The **Tournament** tab plays many games between engines, like cutechess-cli
or fastchess. **Format** chooses who plays whom:

- **Match** – two engines, to tell whether one is stronger, with Elo and an
  SPRT (below).
- **Round robin** – every engine plays a match against every other.
- **Gauntlet** – the first engine plays a match against each of the others.
- **Knockout** – the engines are seeded in the order listed (the best first;
  with a number that is not a power of two the top seeds get byes), and the
  loser of each match is out. A level match plays on two games at a time;
  after three such pairs the higher seed goes through.
- **Swiss** – a set number of rounds (0: enough to sort the field), each
  engine paired with one on the same points that it has not met. With an odd
  number of engines one sits each round out, for half the round's points.

For the formats other than a match, list the engines (up to 32; the same
engine may be listed more than once and is then numbered) and set **Games
per match** (even: each opening is played twice with colours reversed).
While they run, and afterwards, the tab shows:

- **Standings** – rank, games, a bar of games won, drawn and lost, points,
  score, Sonneborn–Berger (which splits ties on points) and the Elo
  difference the score stands for.
- **Points as the games went by** – a line for each engine; point at it for
  the points after any game. Each engine keeps one colour everywhere (the
  first eight; further engines are grey).
- **Matches** – every meeting of two engines with its score and a bar of how
  the games went; for a knockout the bracket round by round, for a Swiss the
  rounds.
- **Head to head** – each engine's points against each other, tinted by who
  is ahead.

The report (below) and the SPRT are for a match of two engines.

- **Engines** (a match) – engine 1 is the one tested, engine 2 the base. Each
  opening is played twice with colours reversed (a pair).
- **Time control** – a clock (seconds + increment, e.g. 10+0.1), a fixed
  time per move, or a fixed number of nodes per move. An engine that runs
  over its time (by more than 100 ms) loses on time.
- **Games** and **Games at once** – how many games (0 plays until the SPRT
  decides) and how many run side by side; each game runs its own pair of
  engine processes, reused from game to game (with more than two engines,
  only the two playing are kept running).
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
  `Documents/Ponder/Tournaments`).

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

**Pause** holds a running tournament: the pairs of games being played are
finished and counted (it shows *Pausing…* meanwhile), then no new game
starts and the engines sit idle until **Resume**, which carries on from the
same point. The time paused is not counted in the elapsed time or the
games-a-minute figure. **Stop** still works while it is paused.

**Engine options** lists the UCI options each engine runs with. Before an
engine's first game has finished it shows what is set to be sent; after, what
the engine was sent and confirmed when it was loaded (under its own names,
numbers within range). Each saved game carries them as `WhiteOptions` and
`BlackOptions` tags, and the match report's settings list them too.

**Search statistics** under the result give each engine's averages over the
moves it searched (book moves not counted): depth, selective depth, nodes a
move, speed in nodes a second and time a move, with the number of moves, and
the average game's length and thinking time. They fill in as games finish
and stay after the test ends, for a match (SPRT or a fixed number of games)
and for the other formats alike; a dash means the engine did not report it.

### Game database

**Settings → Database** can save finished games to a PGN file (by default
`Documents/Ponder/Games.pgn`; **Choose…** picks another, and an existing file
is added to, never replaced). Choose which games: games played here (human
and engine games that end with a result; aborted games are not saved),
Lichess games your engine plays, and Lichess games you watch to the end.
Each game is written with its players, ratings, time control, opening,
result and how it ended.

**Database** in the Games tab's header (and **Open game database** when no
file is open) lists the database's games whatever file was open before. The
board keeps the game it shows; click a game in the list to load it.

The database is listed in the **Games** tab as soon as Ponder starts (when
the file exists), without taking the board, and from its first game on.
Ponder opens on the Moves tab, whose start screen shows the database's
latest games; the whole list is a click away in the Games tab. The
list follows the file: a game added to it, by Ponder or by another program,
appears within a couple of seconds. With a file open in the Games tab (the
database, or any PGN file you opened):

- **Sorting** – click a column name (#, White, Black, Result, Event, Date,
  Round, Moves) to sort the list by it, and again to turn it round; the
  arrow shows the column and direction in use, and the choice is remembered.
  **#** is the order in the file.
- **Search** opens a panel of what the games must have: a player of either
  colour, White, Black, the event, the result (White won, Black won, draw,
  decisive, unfinished), a date range (YYYY, YYYY.MM or YYYY.MM.DD at either
  end) and a length in moves. Every part filled in must hold, together with
  the words in the filter box; the button shows how many parts are set, and
  the panel how many games match. **Clear** empties it.
- **Reload** (the ↻ button beside Close) reads the file again and shows its
  games as they are now. The list follows the file by itself; this is for
  when you want to be sure.
- **Import…** adds every game of another PGN file to it.
- **Export…** writes the games listed (all of them, or those matching the
  filter and the search) to a new PGN file.
- **Edit info…** changes the details of the game on the board: the
  players and their ratings, the result, event, site, date and round. The
  file is updated; the moves are left alone, and the result after the moves
  follows the new one.
- **Delete** removes the game on the board from the file, after asking. It
  cannot be undone. The **Delete** key (or Backspace) does the same for the
  game that has the keyboard in the list: the one you clicked, or reached
  with Tab.

Edit info and Delete are for the game you clicked in the list. The file is
rewritten beside itself and swapped in, so a failure part-way leaves it as
it was.

### Sounds and resigning

Moves, captures, castling, check, promotion, the start and end of a game
(a win or loss when you play the computer), your clock dropping under 10
seconds, and illegal moves each have a sound. They are generated in code
(`app/renderer/sounds.js`), with a wooden set for the minimalist theme, a
synth set for cyberpunk and a 1990s 16-bit arcade fighting-game set for dusk (FM-synth
brass, bass and bells with noise for the blows: a jab for a move, a hard
kick for a capture, a one-two for castling, a charge-up for a promotion, brass fanfares for the
start, a win and the versus screen, and at the end of a game a knockout blow whose cry
echoes away, followed by a short brass tune for a win, a loss, a draw or a
game you watched). **Settings** turns them off or changes the volume.

While a game is being played, its controls sit on the player bars beside
the board: each person has **⚑ Resign** on their own bar, and the bar
nearest you has **½ Draw** (between two people) and **✕ Abort**. They ask
before acting, and are hidden when no game is in progress. An engine's bar
also has **⇄ Engine**, to swap that engine for another or reload it.

### The players of a Lichess game

When the board shows a Lichess game — one you watch, your own, or your
engine's — the players' names on their bars are underlined: **hover a name**
(or tab to it) for that player's card: title, flag and profile link; their
rating at the game's speed (with recent progress, percentile and rank) and at
the other speeds; their record at this speed and overall as won / drawn /
lost bars; peak and lowest rating, win streaks, average opponent and time
played; when they joined and were last seen, and their bio; their score
against this opponent; and their **rating history**, at any speed over 3
months to all time, with the values on hover. The card stays open while the
pointer is on it; moving away or Esc closes it.

### Playing on Lichess yourself

The Lichess tab shows one part at a time, picked with the control at its
top: **Play** (your own account), **Watch** (a player or Lichess TV) and
**Bot** (your engine's Bot account, with the bots online below it).
A dot beside a part's name shows it is on: signed in, watching, or connected. The
tab opens on the part you last picked.

**Play** (the first part of the Lichess tab) plays people on
[Lichess](https://lichess.org) with your own account, moving on Ponder's board,
through Lichess's [Board API](https://lichess.org/api#tag/Board).

- **Sign in with Lichess** opens Lichess in your browser to approve Ponder
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

While your engine's game is live on the board, the side panels turn to
it: the moves keep a slim column, and the rest goes to the engine's window
(its lines, depth and speed), the Game card (speed, time control, rated or
casual, opening), the chat, and an **Opponent** card with the other
player's ratings, record and bio and both players' rating history. On a
wide window these sit in two columns. Opening another tab gives it its
usual room, and the usual layout comes back when the game ends.

On a ponder hit (the opponent plays the reply your engine was thinking
about) **PONDER HIT!** is called out over the piece that just moved, the
instant the move arrives (as the piece sets off, not when the engine next
reports), the way
a 1990s fighting game calls a hit: heavy italic capitals in fire with a dark
edge slam in at a tilt over a burst of rays, shake, then rise and fade (the
same in every theme), with a short rising two-note sound of its own
(in both sound sets; it follows the Sounds setting and is heard in zen mode
too).

Under the engine window's header a row of statistics covers the game so
far: average depth, nodes a move and speed over its moves, **Ponder hits**
(how often the opponent played the reply it was thinking about, as a
percentage and a count), and the number of moves searched.

When the opponent offers a draw in one of your engine's games and the
engine's own draw rules (Settings → Lichess) have not accepted it, a small
window at the top asks: **Accept draw** ends the game drawn, **Decline**
turns the offer down. The offer lapses when your engine makes its next move,
so there may be only a moment to answer.

The **Engine** menu under **Your engine on Lichess** chooses the engine your
bot plays with, connected or not (the same setting as in Settings →
Lichess), and **Options…** beside it opens that engine's UCI options. A new
engine plays from the bot's next game; games in progress keep the engine
they started with. Saved options are picked up the same way.

Once connected, **Engine and bot account** at the top of the bot's part of
the tab shows what is playing and as whom: the engine's name, what it calls
itself, its program, command line and UCI options (the ones you changed,
and all of them with their values; **Options…** edits them), and the bot's
rating at each speed with its recent change, its record, peak and lowest
ratings, and its rating history as a chart. The ratings are read again after
each game.

When a challenge cannot be sent (the bot does not take challenges from
bots, too many requests, not connected…), or is declined or goes unanswered,
a notification in the top right corner says why, whichever tab is open. It
goes by itself after a few seconds; hovering keeps it, ✕ dismisses it.

A challenge you or your engine sent is withdrawn when it has had no answer
for 30 seconds, so the next one can go out; the waiting challenge counts
down. Change the time, or set 0 to wait until it is answered or cancelled,
under **Settings → Lichess**.

When a challenge arrives (to your bot, or to your own account) a window
floats up in the bottom right corner, leaving the board usable, listing every challenge waiting, each with **Accept** and
**Decline**, the challenger's ratings at every speed with their recent
change, games, record and bio (**More…** adds the full record and rating
history), and **Decline with**, which picks the message Lichess shows the
challenger (too fast, rated only, no bots, …; Lichess allows only these).
**Hide** (or ✕) tucks it into a button in that corner showing how many
are waiting, which brings it back; they also stay in the Lichess tab, and the next new
challenge brings the window back. Challenges that **Accept automatically**
answers never show it.

The **Lichess** tab beside the moves lists challenges to your bot (Accept or
Decline), lets you challenge any player or one of the bots online now
(time, increment, colour, rated), and lists the bot's games. Each game is
played by its own copy of the engine, on the Lichess clock. **Watch** shows
a game on the board, live, from your engine's side, with **⚑ Resign** and
**✕ Abort** on its bar; the first game takes the board by itself unless you
are playing one here. Analysis pauses while the bot is playing. While you
watch your engine's game, arrows on the board show what it is thinking: a
solid arrow for the move it means to play and a thinner dashed one for the
reply it expects (its ponder move), following its search as it deepens. The
piece of the ponder move wears a small thought bubble with pulsing dots.
Once it has moved, the expected reply stays on the board until the opponent
answers; when the engine names a ponder move with its move, that one is
shown. The arrows only show on the live position, not while you step back
through the moves.

**Watch a player** (in the Watch part of the Lichess tab) follows any player's
games — another bot, say — live on the board, one game after another, from
that player's side. No engine plays and no token or connection is needed;
you can turn Analysis on while you watch. **Stop** leaves the last position
on the board. Lichess shows other people's games a few moves behind.

**Lichess TV** (just below) shows a tile for each channel: Top rated (the
main Lichess TV), Bullet, Blitz, Rapid, Classical, UltraBullet, Bot and
Computer, each with the player it has on now and their rating (refreshed
every 30 seconds while Watch is open). Click a tile to put that channel on
the board; the one being watched is outlined and marked **Live**. The game
is shown live, from the side Lichess TV shows it from, and when it ends its
result stays on the board for a few seconds before the channel's next game
comes on. Click another tile to switch, or **Stop** to end it, as for a
player. No token is needed, and games watched to the end are saved to the
database like those of a player followed.

**Several games at once** – a player in more than one game at a time (a
simul, correspondence games) has them all followed, up to six. A row of
small boards appears under the status line, one per game, each showing its
position as it is played, the opponent, the move number and, once it is
over, the result. One game is on the board, outlined in the row; click
another to put that one there. A game that starts while another is being
played joins the row (it is found within about a quarter of a minute) and
does not take the board. When the game on the board ends while another is
still being played, the newest game still going takes the board after
three seconds, once the result has shown. After a rated game, the board
waits for Lichess's rating changes, for up to 12 seconds, and then three
seconds more so you can read them. If nothing else is going, the
next new game takes the board when it starts. Clicking a game in the row
during those three seconds, even the finished one, keeps the board on that
game. Finished games leave the row when a new one starts. Every game
followed to its end is saved to the database, if watched games are kept.

**Tiles** – with several games going, the **Tiles** button at the start
of the row of small boards shows all of them at once, each on a board of
its own. Each tile has both players with their flags, titles, ratings and
running clocks, and how the game stands. A tile is marked when its game is
on the main board, and a finished game shows its result until a new game
starts. The boards are as large as lets every game fit in the window.
Click a tile to put that game on the main board and go back to it; Close
or Esc does the same without changing the game. Tiles stays on, and comes
back whenever several games are going, until you close it. While it is
showing, the versus and K.O. screens of the other games are left out. The
same works when your own engine plays several games at once.

**Several engine games at once** – when your engine plays more than one
game at a time (Games at once in its rules), the same row of small boards
appears under the status line as when you watch a player in several games:
one per game in progress, with the opponent, rating, move number and whose
move it is. The game on the board is outlined; click another to put it
there, with the engine's window, scores and chat following. A game that
starts while another is on the board takes the board, with the versus
screen, and the earlier one stays in the row; turn **Switch the board to
your engine's new game when it starts another** off in Settings → General
to have the new game only join the row. When the game on the board ends
while another is still being played, that one takes the board three
seconds later, once the result has shown. After a rated game, the board
first waits for the rating change to appear on the result card, for up to
12 seconds, and leaves it there for three seconds. If you click a game in
the row first, the board stays on your choice. A finished game stays in the row
only while it is the one on the board.

**Country flags** – Lichess players and bots show the flag from their
Lichess profile beside their name: on the player bars, the Game card, the
versus and result screens, the row of small boards, the match history, the
challenge window and the lists in the Lichess tab (challenges, games, bots
online). Hover a flag for the country's name. Ponder asks Lichess for the
flags of the names it shows, many at once, and keeps them for the session;
a player who has not set a flag has none. Players of local games (you, an
engine) have no country to show. The flags are emoji. macOS and Linux draw
them with their own emoji font. Windows' emoji font has no country flags,
so on Windows Ponder uses Twemoji's flags instead, from a font of flags only
(`app/renderer/vendor/flags`, from country-flag-emoji-polyfill; the art is
CC BY 4.0).

**Match history** – while your engine plays on Lichess (one of its games
on the board, or one in progress), a floating **Match history** window
lists its finished games, newest first: a small picture of the final
position, **Won** / **Lost** / **Draw** and how (checkmate, resignation, on
time…), the opponent and their rating, the number of moves, the colour it
played, the clock and when. A tally of wins, draws and losses heads it.
Click a game to put it on the board (or, once Ponder no longer has it, to
open it on Lichess). The last 60 games are kept on this computer, so the
history outlasts a restart; **Clear history** empties it. Like the chat
it moves, resizes, folds and hides (a **Match history** button at the
bottom right brings it back), and it comes back open each time your engine
starts playing again.

**Floating chat** – in your engine's Lichess games and your own, the
game's chat leaves the side panel and floats over the app in its own
window, at the top right at first. Drag it by its header to move it, drag
its bottom right corner to resize it (a double-click there gives it its own
size back), fold it down to its header with the arrow or a double-click on
the header (the rooms and their unread counts stay in view), and hide it
with ✕: a **Chat** button at the bottom right, with the number of unread
messages, brings it back. Where it is, its size and whether it is folded or
hidden are remembered; each new game shows it again, unfolded. A game you
only watch has no chat Ponder can show, so its note stays in the side panel.

**Challenge window** – a challenge sent to another bot or player (by your
engine, by you, or by the random-bot challenger) shows in a small window
floating over the app, with how it stands: waiting for an answer, with the
seconds left before it is withdrawn and a Cancel button; accepted; declined,
with the reason given; no answer; or withdrawn. A challenge that could not
be sent at all is listed as **Not sent**, with the error: for example
Lichess refusing it for too many requests, a bot that has played its bot
games for the day, or another challenge still waiting. The window lists
every challenge out, including those already waiting when Ponder connects,
such as ones sent on the Lichess website. An answered challenge stays
a few seconds (✕ dismisses it at once) and the window closes when none is
left. While your engine is challenging random bots, a challenge that was
declined or not answered stays in the window, marked so, until the next one
goes out, and the window counts down to it ("Next challenge in 42 s"). Its
bottom row turns **Auto challenge** off (the same switch as in the Lichess
tab), or, for a set number of random-bot games, says which game it is on
with a Stop button; the row stays when the window is folded. The
window opens at the bottom right of the app; drag it by its header to move it,
fold it with the arrow or a double-click. ✕ in its header hides it, and it
stays hidden, even after a restart, until you show it again. While it is
hidden, a **Challenges** button at the bottom right of the window says how
many challenges are waiting and brings it back. It is hidden in zen mode.

**Floating engine window** – while your engine's Lichess game is on the
board, the engine's window (its search, lines and messages) leaves the side
panel and floats over the app. Drag it by its header to move it anywhere in
the window; the arrow in the header, or a double-click on it, folds it down
to the header (name, depth, nodes and speed) and opens it again. Drag its
bottom right corner to resize it: the list of lines takes the room, and a
double-click on the corner gives the window its own size back. Where you
left it, its size and whether it is folded are remembered. The ✕ in its
header hides it: a button at the bottom right, with the engine's name and
the depth its search is at, brings it back. When your engine's next game
starts the window is shown again, unfolded, however you left it; its place
and size are kept.

**Depth** – every engine window shows the depth its search has reached in
large figures in a badge beside the engine's name, apart from the nodes and
speed. It starts at the bottom
right, goes back into the side panel when another kind of game is on the
board, and is hidden in zen mode.

**Win/draw/loss chances** – engines that can report them (Stockfish, Lc0
and others with the `UCI_ShowWDL` option) do, in the Analysis window and
in the engine windows of engine games: under the header a bar of White's
wins, draws and Black's wins with the percentages, for the best line (or
the engine's last move), and a small bar beside each line's score to
compare them. Ponder turns `UCI_ShowWDL` on for analysis and games when the
engine has it, unless you set it yourself under the engine's Options.
Engines without it show scores as before.

**Live search** – while your engine's Lichess game is on the board, its
engine window follows the search as it happens (up to 25 times a second):
the header shows the depth, nodes and speed, updated between lines too (as
the engine reports the depth it is on), and the top row its current line.
While it ponders on its opponent's time the header says *pondering* and a
row marked **ponder** shows that search, starting with the reply it
expects; the row goes once the opponent has moved. A move whose search began
as a ponder hit (the opponent played the expected reply) carries a small
**hit** mark after its score, and keeps it for the rest of the game.

**Scores** – while your engine's Lichess game is on the board, its own
evaluation shows in three places: on the bar beside the board (for the
position shown, so it follows you as you step through the moves; hover it
for the depth), after each of its moves in the moves list, and on each row
of its engine window. The scores are kept for the whole game, so a game you
put on the board part-way through shows them for the moves already played.
The bar follows *Evaluation bar* in Settings → Analysis; once the game is
over and Analysis is on, the bar is the analysis's again.

**Pondering** – your engine thinks on its opponent's time too, as UCI
engines are meant to. When it plays a move and names the reply it expects
(`bestmove e2e4 ponder e7e5`), Ponder sets up the position with that reply
played and sends `go ponder` with the clocks. If the opponent plays the
expected move, `ponderhit` turns that search into the real one; if not,
`stop` ends it (its answer is ignored) and a new search starts from the
move that was played. The engine's `Ponder` option is turned on, which is
how an engine says it can ponder; one without the option is left idle on
the opponent's time. **Settings → Lichess → Think on the opponent's time**
turns pondering off (used from the next game).

**Draws** – like lichess-bot, your engine can offer a draw and accept one.
Under **Settings → Lichess → Draws** (lichess-bot's `offer_draw_*` options):

- *Offer and accept draws* (`offer_draw_enabled`) turns it on or off.
- *Score within … centipawns of zero* (`offer_draw_score`), *for … moves in
  a row* (`offer_draw_moves`) and *with at most … pieces on the board*
  (`offer_draw_pieces`): once the engine's own score for the moves it chose
  stayed that close to zero that many times in a row, and no more pieces
  than that are left (kings and pawns count), its move is sent with a draw
  offer.
- *Also when the Lichess tablebase says the position is a draw*
  (`offer_draw_for_egtb_zero`): with seven pieces or fewer, the position is
  looked up at `tablebase.lichess.ovh` while the engine thinks, and a drawn
  one gets a draw offer whatever the score. Only the position is sent. The
  engine still chooses the move itself.

A move sent with a draw offer also accepts an offer the opponent made, so
the same rules decide both; an offer that does not meet them is declined by
playing on. The usual values are those of lichess-bot (on, 0, 10 moves, 10
pieces, tablebase on) and changes apply at once, also to games under way.

**Hello and goodbye** – like lichess-bot, your engine greets in the chat of
the games it plays: a hello to its opponent and one to the spectators when
a game starts, and a goodbye to each when it ends (not after an aborted
game, and no hello in a game already under way). **Settings → Lichess →
Chat messages** sets the four messages; `{me}` and `{opponent}` become the
two names, an empty message is not sent, and **Say nothing** turns them all
off. Changes apply from the next message, without reconnecting.

**Chat** – while a Lichess game of your engine or of your own account is
on the board, a **Chat** card sits above the Game card with the game's two
rooms: **Spectators**, where everyone watching the game talks, and
**Players**, between the two players. Messages arrive live (earlier ones
from the players' room are read when the game is opened), Lichess's own
notices are in italics, and the other room's button counts what you have
not read. Write up to 140 characters and press Enter; you speak as the
account in the game (your engine's Bot account, or your own). After the
game you can still say something, but answers no longer arrive. Lichess
gives a game's chat only to the accounts playing it, so for a game you
follow with *Watch a player* the card says so and links to the game on
Lichess, where its chat is. With the stand-in server,
`curl 'http://127.0.0.1:8765/_fake/chat?game=ID&from=Kibitzer&text=Hello'`
says something in a game (`room=player` for the players' room).

**Online bots** (at the bottom of Bot in the Lichess tab, no
connection needed; it fills in the first time you open it, or when your Bot
account connects) lists the bots
on Lichess right now — up to 300 — with their title, country flag and
rating at the chosen speed (provisional ratings marked **?**), their games
and their ratings at the other speeds, and whether each is free or playing
(and at what clock; refreshed every 20 seconds while the tab is open). Search
by name, bio or country, set a rating range, show only free bots, and sort
by rating, games, time played, name or newest. Hover a bot's name for the
same player card as in games (at the list's speed, with its rating
history). Click a bot for its bio,
every rating with games played and recent progress, when it joined, when it
was last seen and how long it has played. Each row has **Challenge** (with
your engine, using the time, colour and rated settings of *Challenge a
player*; needs your Bot account connected), **Play** (challenge it to play
you, when you are signed in, using *Challenge a friend*'s settings),
a **TV** button that watches the bot on the board (coloured while it is
playing; for a free bot it shows the last game and follows the next one
when it starts), and its **Profile** on Lichess.
One challenge waits for an answer at a time: while your engine's challenge
is open (or it is playing, or looking for a random bot), its Challenge
buttons are off until the challenge is answered or you cancel it; the same
goes for the challenges you send from your own account.

**Random bot** has settings of its own, a row each, kept between runs:

- **Clock** – initial time and increment; the speed it makes (bullet,
  blitz…) is shown under it, and the bots' ratings are read at that speed.
- **Your engine plays** – either color, White or Black.
- **Random clock** – a different clock for each challenge, the way
  lichess-bot's matchmaking does it with `challenge_initial_time` and
  `challenge_increment`. Turn it on and pick the minutes and increments to
  draw from as chips (lichess-bot's defaults, 1 and 3 minutes with 1 or 2
  seconds, to start with). Each challenge takes one pairing at random. If no
  bot in range is rated at that speed, it tries another pairing. Bots'
  ratings, and *Around yours*, are read at the speed of the clock drawn. A
  bot that declined one clock may still be asked at another speed.
- **Rated** – *Casual*, *Rated*, or *Random*: each challenge rated or casual
  at random (lichess-bot's `challenge_mode: random`).
- **Their rating** – *Between* a lowest and highest rating (empty: any), or
  *Around yours*: that many points either side of your bot's own rating at
  the speed, read from Lichess when the search starts and again every few
  minutes while it runs.
- **Skip provisional ratings** – passes over bots still new at the speed.
- **At least … games** – passes over bots with fewer games at the speed.
- **Never challenge** – bots to leave alone, by name, separated by commas.

Set **Games** to have it carry on: it goes on challenging
random bots until that many games have started (0: until you press
**Stop**). It only holds back while your engine is in as many games as its
rules allow at once (**Games at once**, whoever started them): with room
for two it challenges another bot while one game is being played, and the
next challenge goes out when a game ends. It can be started while your
engine is playing. The line under the button says which game it is on.

If Lichess refuses a challenge for too many requests, no challenge goes out
until the wait is over, as in lichess-bot. That includes Lichess's limit on
games against bots in a day, which can last hours. The wait is the time
Lichess gives; when it gives none, the wait is 1 minute, then 2, 4 and 8,
up to 10, resetting once a challenge goes through. Stopping and starting
the search, or Auto challenge starting again on reconnecting, doesn't cut
the wait short. The line under the button says when the next challenge
goes out. A bot that has played its own bot games for the day is skipped
until Lichess says it can play again, and another bot is asked.

**Auto challenge** – the switch above the button keeps the random-bot
challenger running by itself: while it is on your engine challenges
random bots without end (no number of games), with the settings above, as
many games at once as its rules allow. It starts when you turn it on and
again each time the engine connects (so also when Ponder starts, if it
connects automatically), and ends when you turn it off or press **Stop**,
which turns it off too. It is off until you turn it on. The settings can be
changed while it runs: switch **Their rating** to *Around yours* and set the
points, say, and it challenges only bots that close to your bot's rating
from its next look at the bots online, without stopping (a challenge
waiting for an answer is left be). The line under the button shows the
range it is using.

**Challenge random bot** picks a bot online at random that fits these
settings, and challenges it. If it declines or does not answer within 30
seconds, the challenge is cancelled and another bot is tried, until one
accepts. Challenges go out at most once a minute, however quickly a bot
answers; the status line counts down to the next one; when every matching bot has been asked, it starts over after a
short wait. **Stop** ends the search.

Connecting never plays by itself: it lists challenges and games, nothing
more. Your engine plays only games you start here (Accept, or a challenge
you send). Games already going when you connect, or started elsewhere, are
listed as *Not played* with a **Play** button to hand them to the engine.

**Accept automatically** (in Bot in the Lichess tab, off after every connect)
accepts challenges that match the **Auto-accept rules** just below it and
declines the rest with the matching Lichess reason. The rules open from a
line that sums them up, and choose the types of games to take: the speeds
(UltraBullet, Bullet, Blitz, Rapid, Classical), rated and casual, from
people and from bots, games from a set-up position, the minutes and the
increment (from – to), the challenger's rating (from – to; challengers
without a rating pass) and how many games at once. An empty limit means any;
each change is saved and applies at once, and a rule that would decline
everything is pointed out. The games-at-once limit counts every game your
engine is in or about to be in: games being played, challenges just
accepted whose games have not started yet, and a challenge your engine sent
(to another bot, say) that is still waiting for its answer. A challenge
that would go over the limit is declined with "later". Variants and
correspondence games are always declined. Disconnecting while your engine is playing resigns those games,
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

**Settings → Appearance** switches between themes; the choice is
remembered. Each theme changes the pieces, the board and the rest of the
window:

- **Minimalist** (default): flat white and charcoal pieces on a light grey
  board; a light window with a blue accent.
- **Obsidian**: pale and amber pieces on a charcoal board; a dark window
  with an amber accent.
- **Cyberpunk**: neon-outlined pieces on a navy board, dark UI.
- **Dusk**: flat teal and coral pieces on a slate-violet board, dark
  blue-grey UI with a lavender accent.

**Glass.** The side panel's tabs, the column beside the board, the floating
windows and the Settings window are frosted glass over a soft wash of the
accent and two warm tones: translucent cards that blur what is behind them,
with a bright hairline edge, settings as rows with switches. How
see-through the glass is is set with **Transparency** under **Settings →
Appearance → Glass** (Solid to Clear; double-click the slider for the usual
amount). Past the middle of the range the frosting thins too, so at 100%
the cards are nearly clear, only their edges and a light blur left. Dark
themes are a little clearer at the same setting. The AI panel
is glass too.

**3D board** (**Settings → Appearance → Board**, off at first) draws the
board and the pieces in 3D with three.js, seen from your side at an angle,
with light, reflections and soft shadows. The pieces are modelled in the
app (turned pieces on a common base, a carved head for the knight, turned
to show its profile), in the colours of the theme's own piece set: white
and black satin for Minimalist, pale and amber for Obsidian, teal and coral
for Dusk, and for Cyberpunk dark navy glowing at the edges in cyan and
magenta, with a neon line round the board. With **Glassify board** they are
glass in those colours. The squares take the theme's colours and the files
and ranks are on the frame. A theme sets these with `--piece3d-white`,
`--piece3d-black`, `--piece3d-finish` (matte, satin or gloss), and
optionally `--piece3d-white-rim`, `--piece3d-black-rim` and `--board3d-edge`
in `style.css`. Everything the flat board shows is there: pieces
slide (a knight hops), a taken piece lifts and shrinks away, the last move, the
selected piece and its legal moves, check, and the arrows. Click a piece and
its square, or drag it; flipping the board turns it round. Drag anywhere
that is not a piece (an empty square, the frame, around the board), or with
the middle button, to turn the board and tilt it; scroll or pinch to come
closer or go back; the reset button (the round arrow at the board's top
right, beside Auto) or a double-click on an empty spot faces it from your
side again. The view is kept for next time. **Auto camera** (the **Auto**
button at the board's top right, or the switch under 3D board) has the
camera follow the game: at each move it glides in on the move, lower and
closer and turned a little toward where the piece went, closer still for a
capture or a check, holds a moment, and glides back to your view; turning
or zooming the board yourself takes over until the next move. The camera keeps the whole board in
the space at any angle. It draws only when something changes, so an
idle board costs nothing. In zen mode the 3D board fills the whole window,
with the players' rows (names, clocks, board buttons) along its top and
bottom edges and the score bar down its left edge. **Capture effects** (the switch under Auto
camera, on at first) set off a burst where a piece is taken, picked at
random and never the same twice running: fire and smoke, magic plasma,
shadow clones of the piece taken, sparks, frost, or ice (the piece taken
freezes in a block of ice that cracks and shatters). The piece taking
leaves a trail of the same on its way (flames and smoke, spiralling
sparkles, a line of fading afterimages of itself, falling sparks, shed
frost and mist, icicles springing up from the board), going a little
slower than other moves so it can be seen, and the burst goes off as it
lands. Each effect has its own sound, synthesised like the game's sounds,
for its trail and for its burst: a crackling roar for fire, a chime of
bells and a falling sweep for plasma, a whoosh for each shadow and a dark
swell, an electric buzz and a zap for sparks, cold wind and high bells for
frost, creaking then a crack and tinkling shards for ice. They follow the
Sounds setting and volume.
three.js is in `app/renderer/vendor/three`.

**Glassify board** (**Settings → Appearance → Board**, off at first) puts
the board and the pieces in the same glass: the squares become see-through
tiles with a lit edge over a wash of colour, under a gloss and a bright rim;
each piece gets a body of glass in its own shape, clear for White and
smoked for Black, that lets the colour of the squares under it through, with the theme's drawing over it, a bright rim and a sheen across the
top. It follows the theme's colours and the Transparency setting. The
glass pieces are drawn once per theme into ordinary images, and nothing on
the board is a live blur, so pieces slide as smoothly as on the plain board.

**Settings → Appearance** holds everything about the look: the theme, the
glass, the board (piece animation, the attack marks, the result card, the
versus and result screens), the moves list (piece icons, scores) and the AI
chat's font and text size. **General** keeps the sounds and when the board
switches to your engine's new Lichess game.

The window follows the look of Apple's apps in every theme: the system
font, white cards on a soft grey ground, controls as borderless fills,
segmented controls for the tabs and choices, hairlines instead of boxes, and
sheets and pop-up cards with large corners. The shared pieces of that look
(corner sizes, fills, hairlines, the focus ring) are variables at the top of
`app/renderer/style.css`, made from each theme's own colours. On macOS the
window has no title bar: its buttons sit over a strip at the top of the
page, which also drags the window.

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
  cmd/basicengine/   the bundled "Ponder Basic" UCI engine
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

Chess960, and signed installers (see **Packaging** for an app bundle).

### Easter egg

Type `nyan` anywhere outside a text box: a pixel cat flies across the window
on a rainbow, among twinkling stars, to a little chiptune (heard when sounds
are on). The cat and the tune are Ponder's own, after the old internet meme.
