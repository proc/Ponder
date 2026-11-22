# Game database

## Saving games

**Settings → Database** saves finished games to a PGN file, by default `Documents/Ponder/Games.pgn` (**Choose…** picks another; an existing file is added to, never replaced). Choose which games to save:

- games played here that end with a result (aborted games are not saved)
- Lichess games your engine plays
- Lichess games you watch to the end

Each game includes players, ratings, time control, opening, result and how it ended.

## Browsing

The database is listed in the **Games** tab from startup, and the Moves tab's start screen shows its latest games. **Database** in the Games tab header (or **Open game database**) lists it again; click a game to load it. New games in the file appear within seconds.

## Working with a file

With the database or any PGN file open in the Games tab:

- **Sorting** – click a column name (#, White, Black, Result, Event, Date, Moves) to sort, again to reverse. **#** is file order. The choice is remembered.
- **Analysed** – a ✓ marks a game whose computer analysis is complete: one engine has analysed every position in it (hover for which). A stopped analysis gets no tick until it is finished. Analysed positions are remembered between sessions, so the ticks stay. The round is still shown on the Game card.
- **Search** – filter by player, White, Black, event, result, date range (YYYY, YYYY.MM or YYYY.MM.DD) and length in moves, together with the filter box. **Clear** empties it.
- **Reload** (↻ beside Close) – reread the file.
- **Import…** – add every game from another PGN file.
- **Export…** – write the listed games to a new PGN file.
- **Binpack…** – turn the file's games into NNUE training data (see below).
- **Computer analysis…** – with games chosen (see below), analyses them. Otherwise it opens a bar above the list where you pick what to analyse: the game on the board, the games listed that are not analysed yet (no ✓), or every game listed. The bar also has the analysis settings. **Start** analyses them in turn on the board, saving each into the file, and **Stop** ends it. Esc or ✕ closes the bar.
- **Edit info…** – change the players, ratings, result, event, site, date and round of the game you clicked. Moves are not changed.
- **Delete** – remove the game you clicked, after asking. It cannot be undone. The **Delete** key (or Backspace) does the same for the selected game in the list.
- **Several games at once** – **⌘-click** (Ctrl-click on Windows and Linux) adds a game to the choice, or takes it out again. **Shift-click** takes in every game between, and **⌘/Ctrl-A** chooses every game listed. A plain click shows one game as before, and **Esc** or **✕** lets go of the choice. A bar above the list then acts on all of them:
  - **Computer analysis** analyses each game in turn on the board. Its settings sit in the bar below the buttons: time a move, swarm, Comment the moves, and the analysis engine (chosen in Settings → Analysis). They are the same settings as in the Moves tab, so a change in one tab shows in the other. While it runs, the bar shows them in words. Each game takes them as it starts. Each game is saved into the file before the next one starts, its own annotations kept. Positions analysed before are not searched again. **Stop** ends it, keeping what the current game got through. Showing another game yourself also stops it after the current one.
  - **Export…** writes them to a new PGN file.
  - **Delete** (or the Delete key) removes them, after asking.

  Adding, deleting or importing games lets go of the choice. So does changing the filter, for games it hides.

Changes are written safely: if saving fails part-way, the file is left as it was.

## Training data (binpack)

**Binpack…** in the Games tab, or **File → Convert PGN to Binpack…**, writes the games of a PGN file as a Stockfish `.binpack`, the format [nnue-pytorch](https://github.com/official-stockfish/nnue-pytorch) trains NNUE networks from. Each position of every finished game becomes one entry: the position, the move played, a score and the game's result. Unfinished games (`*`) are left out, and a game with an illegal move is used up to it.

- **Scores from the games' evaluations** – `[%eval 0.25]` comments (as Lichess writes them: White's view of the position after the move) or engine comments such as `+0.25/18` (the mover's view of the position before the move). Positions without one are left out, or scored 0.
- **Scores searched by an engine** – any of your engines searches each position to a depth or a number of nodes, several at once if you like.
- **Score of a pawn** – 208, Stockfish's internal unit, is what nnue-pytorch expects; 100 keeps centipawns. Mates are written as Stockfish writes them.
- **Leave out** the first plies of each game (the opening), and positions in check or before a capture.

It runs in the background, with the dialog closed too; **Stop** keeps what was written, a valid file. The same converter is a command for scripts:

```sh
cd backend && go run ./cmd/pgn2binpack games.pgn games.binpack                       # scores from the PGN
go run ./cmd/pgn2binpack -engine /path/to/stockfish -depth 9 -threads 8 games.pgn out.binpack
go run ./cmd/pgn2binpack -dump out.binpack                                           # list the entries
```
