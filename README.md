# Ponder

A desktop chess GUI for UCI engines. The window is Electron; the chess
rules, clocks and engine processes live in a Go backend that Electron
starts as a child process.

## Run it

You need [Node.js](https://nodejs.org) 18+ and [Go](https://go.dev/dl/) 1.21+.

```sh
npm install
npm start        # builds the Go backend into ./bin, then opens the app
npm test         # the Go tests
npm run package  # a standalone app in dist/
```

Packaging for other systems, signing and the code layout are in
[Development](docs/development.md).

## What it does

**Play and watch games** – [Playing games](docs/playing.md)
- Human vs human, human vs computer or computer vs computer, with clocks
  and time controls.
- Premoves, takebacks, arrows and circles on the board, keyboard shortcuts.
- Swap or reload an engine in the middle of a game.
- Versus and result screens, sounds, music, and opening and saving PGN files.

**Engines and analysis** – [Engines and analysis](docs/engines-and-analysis.md)
- Add any UCI engine and set its options. Two engines come bundled: Ponder
  Basic and Random Mover.
- Live analysis with an evaluation bar and best-move arrows.
- Computer analysis of a finished game, the opening explorer, Lichess
  puzzles, test positions, and annotating games.

**Lichess** – [Lichess](docs/lichess.md) and [Your engine on Lichess](docs/lichess-bot.md)
- Play on Lichess yourself, follow any player or Lichess TV, and watch
  several games at once as tiles.
- Run your engine as a Lichess bot: accept challenges by your rules,
  challenge random bots, and watch its games with its search live.

**AI** – [AI features](docs/ai.md)
- AI annotation, a chat about the game, live commentary read aloud, and a
  voice announcer.
- AI is off until you turn it on. It works with OpenAI, Claude, Google AI
  or a server of your own.

**Tournaments and games** – [Tournaments](docs/tournaments.md) and [Game database](docs/database.md)
- Engine tournaments.
- A database of the games you play and watch.
- PGN files to NNUE training data (Stockfish binpack).

**Looks** – [Appearance](docs/appearance.md)
- Themes, a glass look, and a 3D board.

## Not included yet

Chess960, and signed installers.

Type `nyan` anywhere outside a text box for a surprise.
