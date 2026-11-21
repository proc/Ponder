# Engines and analysis

## Adding engines

Add any UCI engine (Stockfish, Lc0, …) in **Settings → Engines** by picking its executable. The list is sorted by name, built-in engine first; **Find an engine** searches names, paths and command lines, and arrow keys, Home and End move through it. A hollow dot marks an engine with options or a command line set; a solid dot, one used for analysis or on Lichess. The right side shows the engine's name, path, command line, options and **Remove engine**.

Two engines are bundled: **Ponder Basic**, a small real engine (alpha-beta, a few moves deep, MultiPV), and **Random Mover**, which plays random legal moves.

## Engine options

Options open when you add an engine, and later under **Options** (Threads, Hash, Skill Level, …).

- Options are grouped (Basics, Evaluation and opening book, Endgame tablebases, Logging, Search and tuning) with default and range, a slider for small ranges, **Browse…** for files and folders, a reset, a search box and **Changed only**.
- Hovering over an option says what it does, for the options engines commonly have (Hash, Threads, MultiPV, Skill Level, EvalFile, the Syzygy options, …). A value in angle brackets, such as `<embedded>`, names a network built into the engine rather than a file. Any other option shows its type, range and default. Screen readers read the same text with the control.
- Out-of-range numbers are caught before saving. Only changed options are sent.
- Saved options apply at once: analysis restarts, and an engine playing now gets them before its next search. Tournaments keep the options they started with.

Options are sent each time the engine loads, and an engine that fails over one is reported then.

**Command line** sets the arguments the engine starts with (e.g. `--uci` or a network file); quotes keep spaces in one argument. Ponder checks the engine starts with them. They apply everywhere: games, analysis, [tournaments](tournaments.md) and [Lichess](lichess.md).

## Analysis

**Analysis** (toolbar) runs an engine on the board position as you play, step through moves or browse a file. You get:

- The best lines with evaluations.
- An evaluation bar: a middle line for a level score, the score (from White's side) on a plate above it, and a face at each end that smiles, goes flat or frowns with its side's chances. When the engine gives its win/draw/loss chances (UCI_ShowWDL, which Ponder turns on), a bar under the board shows them with their percentages: White's wins from the left, the draw in grey, Black's wins on the right. While the evaluation bar shows, the board is a little smaller to leave room for it. Your bot's own scores show them too while it plays.
- An arrow for the best move with a depth tag, a dashed arrow for the expected reply, and thinner coloured arrows for the other lines (turn these off in **Settings → Analysis**).

Set the engine and number of lines (1–5) in **Settings → Analysis**. Analysis runs separately from playing engines and pauses while one is playing.

- **⏸** (or **P**) stops the engine and keeps its lines; **▶** analyses the current position.
- **Auto pause:** when a game you are watching ends, analysis pauses and resumes with the next game or a reconnected one, unless you paused it or turned it off.
- The Analysis button shows an activity icon that turns while the engine thinks, and a CPU meter of total processor load, updated every second. It reads **Paused** while paused.

## Engine windows

The Analysis window and a window per playing engine sit beside the move list. Analysis lines take one row each: hover to see a whole line, click to wrap it. An engine window shows name, depth, nodes and speed, and among its statistics the hash table's size and how full it is (**Hash 64 MB (30%)**, for engines that report it; the Analysis window shows it too), then one row per search, newest first (move number, score, line); after eight rows it scrolls, with messages below. Drag the handle to resize (remembered); double-click it to reset.

## Computer analysis

After a game, or for a PGN game, **Computer analysis** in the Moves tab evaluates every position (Fast 0.2 s, Normal 0.6 s or Deep 1.5 s a move). As on Lichess, you get an advantage chart (click to jump), inaccuracies **?!**, mistakes **?** and blunders **??** with the better move, and each player's counts, average centipawn loss and accuracy.

**Stop** keeps what is done; **Continue** resumes; **Start over** reruns it. **Comment the moves** adds an editable comment and mark to each inaccuracy, mistake and blunder, leaving existing ones alone; **Remove its comments** removes them.

## Side variations

Once a game is over (or opened from a file), moves you play become variations under the move they replace, as on Lichess. Click a move to go to it, ← → walk a line, ✕ deletes one. Playing the game's own move just follows the game.

## Saved analysis

**Save…** and **Copy** include the computer analysis in Lichess's form (`{ [%eval 0.35] }`, `$6 $2 $4` for ?! ? ??, with the better move) and the side variations.

## Annotating a game

**Annotate** under the moves (or **A**) opens a panel for the move shown:

- **Marks**: `!` `?` `!!` `??` `!?` `?!`. Yours replaces the computer analysis's.
- **Evaluations**: `=` `∞` `⩲` `⩱` `±` `∓` `+−` `−+`.
- **A comment** under the move (at the start position, before the first move).
- **Variations**: after the game, play a move to start a line you can annotate too.

The current annotation is shown larger. Annotations are coloured by mark: green good, purple interesting, blue inaccuracies, amber mistakes, red blunders, grey unmarked comments. AI annotations carry an **AI** badge and `[%ai]` in PGN until you edit them; see [AI features](ai.md).

Annotations are **saved by themselves**, as standard PGN, to the source file or the game's [database](database.md) entry. Tried lines are not, until you **Save** or annotate a move in one. The button reads **Saved** or **Save** (tooltip names the file); a game in no open file has **Save as…**. Reopening a game restores everything.

## Opening card

Point at an opening's name (status line, Game card, Explorer tab, tournament game list) for a card with its moves, history, strengths and weaknesses. Write-ups are built in and work offline; deeper lines use the nearest write-up and say so. A few rare openings have none yet.

## Opening explorer

The **Explorer** tab shows moves played from the board position, with frequency and score, from **Masters** (titled players since 1952), **Lichess** (filtered by speed and rating) or **Book** (built-in, offline). Masters and Lichess need a Lichess API token in **Settings → Lichess**. Hover a move to preview it, click to play it, click a top game to open it.

## Puzzles

The **Puzzles** tab plays Lichess puzzles, online (by theme and difficulty, or the daily puzzle) or offline from `lichess_db_puzzle.csv` (database.lichess.org, decompressed) by rating and theme. Wrong moves are taken back; replies play themselves. Use Hint, Solution, Try again and Leave. Your rating, solved and failed counts and streak show at the top, and the puzzle shows who is to move, a tick or cross, and the moves so far.

## Test positions

**Positions…** opens the 300 built-in **Win at Chess (WAC)** positions; **Open EPD…** adds any EPD file. Find a position by number or name, then double-click, press Enter or **Analyse** to load it with analysis on. A bar over the moves shows its number, side to move, **Show solution**, whether the analysis finds it, and ◀ ▶ to move through the set.

## Test an engine

**Test an engine** (in **Positions…**) runs an engine on the set (**Test all**) or one position, for **Time** per position (1000 ms default, remembered), optionally several **At once**. Each position shows ✓ with the move, time and depth, or ✗ with the move played; filter with **All / Solved / Missed**. **Test engine** on the bar tests the board position. Your engine's options apply, except MultiPV and Ponder.

After a multi-position run, **Test results** shows solved and missed percentages, solve times, depth, speed, nodes and run time, plus each missed position with what was asked and what the engine played; **Load on board** opens one. **Results…** reopens it. **Review missed (N)** steps through misses with ◀ ▶, showing the solution (green) and the engine's line (red) as side lines.
