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

- **Sorting** – click a column name (#, White, Black, Result, Event, Date, Round, Moves) to sort, again to reverse. **#** is file order. The choice is remembered.
- **Search** – filter by player, White, Black, event, result, date range (YYYY, YYYY.MM or YYYY.MM.DD) and length in moves, together with the filter box. **Clear** empties it.
- **Reload** (↻ beside Close) – reread the file.
- **Import…** – add every game from another PGN file.
- **Export…** – write the listed games to a new PGN file.
- **Binpack…** – turn the file's games into NNUE training data (see below).
- **Edit info…** – change the players, ratings, result, event, site, date and round of the game you clicked. Moves are not changed.
- **Delete** – remove the game you clicked, after asking. It cannot be undone. The **Delete** key (or Backspace) does the same for the selected game in the list.

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
