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
  picking its executable; its options open as soon as it is added, and
  later under **Options** (Threads, Hash, Skill Level, …): every option the engine offers, grouped (Basics,
  Evaluation and opening book, Endgame tablebases, Logging, Search and
  tuning), each with its default and range, a slider for small ranges,
  **Browse…** for files and folders (Syzygy path, network, book, log), a
  reset, a search box and **Changed only**. Out-of-range numbers are caught
  before saving; only options changed from the engine's defaults are sent,
  and the analysis engine restarts with new options at once. **Command line** sets the options the program is started with (for
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
  second. When a game you are
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
  Both can be turned off in Settings → General → Moves list.
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
  sends them away at once. A game joined part way through, tournament
  games and your own games do not show it. Turn it off under **Settings →
  General**.
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
  off under **Settings → General**; zen mode hides it.
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
  flip, Z zen mode (only the board and players). Flip and zen mode are also the two
  icons at the board's bottom right corner, L analysis, P pause it, B
  takeback, ? the list of shortcuts.
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
- **When a game ends** a card over the board says who won and how: *You
  won!* (green), *You lost* (red) or *Draw* when you played (or *Your engine
  won/lost* for its Lichess games), otherwise *White wins* / *Black wins*
  with the players' names. It has **Computer analysis**, **New game** and
  **Close** (or Esc, or click beside it); each player bar shows its score (1,
  0 or ½), a win or loss sound plays, and if Ponder is not the window in
  front, a desktop notification says the result. After a **rated Lichess
  game** (yours, your engine's, or one you watch), the card, the
  notification and the player bars also show each player's rating change
  (e.g. *−8 rating · 1500 → 1492*), as soon as Lichess has worked it out. The card can be turned off
  in **Settings → General → Board**.
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
  **Settings → General → Board**. A piece you drag is not animated again.
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

The model is reached through an OpenAI-compatible API, set under **Settings
→ AI**:

- **Endpoint** – `http://localhost:8000/v1` by default, for a local server
  such as oMLX, LM Studio, Ollama, llama.cpp or vLLM (`localhost:8000` is
  enough to type); any other OpenAI-compatible address works too.
- **Model** – the model to ask; empty uses the first one the endpoint lists.
  **Check** asks the endpoint for its models.
- **API key** – only for endpoints that want one; kept encrypted with the
  system keychain where there is one.

What is sent, only when you press the button: the game's PGN (with any
annotations and computer-analysis evaluations already on it), its moves
numbered, and the players' names and the result. With a hosted endpoint
that leaves your computer.

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

The conversation's typeface and text size are set under **Settings → AI**:
**Chat font** (System, Serif, Rounded, Monospace, or **Other…** with the
name of any font on the computer) and **Chat text size** (80–150%), with a
sample line showing the choice.

### Live commentary

With **Live commentary** on (the AI panel's **Commentary** view), the AI
model comments on a game as it is played, like a commentator on a
broadcast: your own game, an engine's, a Lichess game, or a tournament game
on the board. Every few moves (**every** move, 2, 3, 5 or 8 moves; 2 to
begin with) it is sent the players, all the moves so far, the moves since
its last comment, the position now as FEN, the engine's evaluation when
there is one, and a couple of its own earlier comments, and answers in one short sentence.
When the game ends it is asked for a summary of two or three sentences.

The latest comment shows in a **Commentary** card beside the board, written
as it comes (**All…** opens the whole commentary in the AI panel, **Off**
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
"castles kingside"). A new comment takes over from one still being read,
so the voice keeps up with the game; ▶ on a comment in the list reads that
one again. The speech is made on the computer: no audio or text is sent
anywhere for it.

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
the file exists), without taking the board, and from its first game on. The
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
brass, bass and bells with noise for the blows: a jab for a move, a heavy
punch for a capture, a charge-up for a promotion, brass fanfares for the
start, a win and the versus screen, a sinking "K.O." for a loss). **Settings** turns them off or changes the volume.

While a game is being played, its controls sit on the player bars beside
the board: each person has **⚑ Resign** on their own bar, and the bar
nearest you has **½ Draw** (between two people) and **✕ Abort**. They ask
before acting, and are hidden when no game is in progress.

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

**Play on Lichess** (at the top of the Lichess tab) plays people on
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
about) a **Ponder hit** label in the theme's accent colour pops up over the piece that just moved,
floats upward and fades, with a short rising two-note sound of its own
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

**Watch a player** (at the top of the Lichess tab) follows any player's
games — another bot, say — live on the board, one game after another, from
that player's side. No engine plays and no token or connection is needed;
you can turn Analysis on while you watch. **Stop** leaves the last position
on the board. Lichess shows other people's games a few moves behind.

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

**Online bots** (in the Lichess tab, no connection needed; it fills in by
itself when your Bot account connects) lists the bots
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

Set **for N games** beside it to have it carry on: when a game ends,
another random bot is challenged, until that many games have been played (0:
until you press **Stop**). No challenge goes out while your engine has a
game in progress, whoever started it; the line under the button says which
game it is on.

**Challenge random bot** picks a bot online at random whose rating, at the
speed of the chosen clock (bullet, blitz, rapid…), is within the range you
set, and challenges it. If it declines or does not answer within 30
seconds, the challenge is cancelled and another bot is tried, until one
accepts. Challenges go out at most once a minute, however quickly a bot
answers; the status line counts down to the next one; when every matching bot has been asked, it starts over after a
short wait. **Stop** ends the search.

Connecting never plays by itself: it lists challenges and games, nothing
more. Your engine plays only games you start here (Accept, or a challenge
you send). Games already going when you connect, or started elsewhere, are
listed as *Not played* with a **Play** button to hand them to the engine.

**Accept automatically** (in the Lichess tab, off after every connect)
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

**Settings** switches between themes; the choice is remembered. Each theme
changes the pieces, the board and the rest of the window:

- **Minimalist** (default): flat white and charcoal pieces on a light grey
  board; a light window with a blue accent.
- **Obsidian**: pale and amber pieces on a charcoal board; a dark window
  with an amber accent.
- **Cyberpunk**: neon-outlined pieces on a navy board, dark UI.
- **Dusk**: flat teal and coral pieces on a slate-violet board, dark
  blue-grey UI with a lavender accent.

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
