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
- **Edit info…** – change the players, ratings, result, event, site, date and round of the game you clicked. Moves are not changed.
- **Delete** – remove the game you clicked, after asking. It cannot be undone. The **Delete** key (or Backspace) does the same for the selected game in the list.

Changes are written safely: if saving fails part-way, the file is left as it was.
