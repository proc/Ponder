# Lichess

The **Lichess** tab plays and watches games on [Lichess](https://lichess.org). It shows one part at a time, picked with the control at its top:

- **Play** – your own account.
- **Watch** – a player or Lichess TV.
- **Bot** – your engine's Bot account, with the bots online below it.

A dot beside a part's name shows it is on (signed in, watching or connected). The tab opens on the part you last picked.

To let your engine play on Lichess, see [Your engine on Lichess](lichess-bot.md).

## Signing in

**Play** uses Lichess's [Board API](https://lichess.org/api#tag/Board), so you move on Ponder's board.

- **Sign in with Lichess** opens your browser to approve Ponder (playing, sending and answering challenges, and reading the players you follow). No password is needed. The sign-in is kept, encrypted with the system keychain, until you **Sign out**.
- **Use an API token instead** takes a personal token with the `board:play` permission (**Create one ↗** also ticks `challenge:read`, `challenge:write` and `follow:read`).
- If you signed in before Ponder asked for `follow:read`, **Following** says so with **Sign in again**; everything else works meanwhile.
- Anonymous games are not possible: Lichess does not let apps play without an account.

## Your Lichess home

Once you are signed in, **Play** opens on your Lichess home, read again every minute while it is open (↻ reads it at once):

- **Profile** – your name, when you joined and time played, your ratings (Bullet, Blitz, Rapid, Classical, Correspondence, Puzzles, and any variant you have played) with games and recent progress (**?** for provisional), and your won / drawn / lost record. **Profile ↗** opens it on Lichess.
- **Lichess TV**, **Daily puzzle** and **Puzzles** – go to Watch, or to the Puzzles tab (today's puzzle starts at once). Beside them, who Lichess TV's top rated channel has on now, with **Watch**.
- **Challenges to you**, with **Accept** and **Decline**.
- **Your games** – every game you have going on Lichess, correspondence ones too: a small board, the opponent, speed, and whose move it is with the time left. **Resume** puts it on the board to play; a game Ponder was not following yet is followed from then on.
- **Quick pairing** and **Create a seek** – see below.
- **Lobby** – the correspondence seeks waiting in the Lichess lobby: player, rating, days a move, rated or casual, colour.
- **Challenge a friend**.
- **Following** – the players you follow, online ones first (**Online only** hides the rest): playing (with the clock), online, or when they were last seen, with **Watch** (their game on the board, in Watch), **Challenge** (fills in *Challenge a friend*) and **Profile ↗**.

### What Lichess does not let apps do

- **Join someone else's seek.** Lichess's API can post seeks but not accept them, so the lobby's **Join on Lichess ↗** opens Lichess's lobby; the game then shows under Your games. Real-time seeks are not listed at all (Lichess sends them only to its own page); Quick pairing and Create a seek are paired with a matching one instead.
- **Withdraw a correspondence seek.** It stays in the lobby until someone accepts it or it expires.
- **Seek blitz or faster.** Seeks are rapid, classical or correspondence; challenge someone for faster games.

## Playing on Lichess yourself

- **Quick pairing** (10+0, 10+5, 15+10, 30+0, 30+20, rated or casual) searches the Lichess lobby until an opponent is found. Press it again or **Cancel** to stop. Lichess lets apps seek **rapid and slower** games only.
- **Create a seek** sets your own: real time (minutes and increment, rapid or slower) or correspondence (1, 2, 3, 5, 7, 10 or 14 days a move), colour, rated, and **Opponent** within ±100 to ±500 of your rating at that speed. It is kept between runs. A real-time seek shows under Quick pairing with **Cancel**; a correspondence seek goes into the lobby, and its game starts when someone accepts it.
- For blitz or bullet, **challenge a friend** by username with any time, increment and colour.
- Challenges sent to you are listed with **Accept** and **Decline**, and float up in a window (see [Accepting challenges](lichess-bot.md#accepting-challenges)).

During the game:

- The game takes over the board. You move on your turn (premoves work) and the clocks are Lichess's.
- Your bar has **⚑ Resign**, **½ Draw** (offer), **↶ Takeback** (ask) and, before both sides have moved, **✕ Abort**.
- Your opponent's draw offers and takeback requests show on your bar with **Accept** and **Decline**.
- Your games are listed in the tab; **Play** brings one back to the board.
- Lichess forbids outside help, so while you play the analysis engine is off, the opening explorer is hidden and computer analysis waits until the game ends.
- Finished games are added to the game database along with your engine's Lichess games (Settings → Database).

## The players of a Lichess game

On any Lichess game (watched, yours or your engine's) the players' names on their bars are underlined. **Hover a name** (or tab to it) for that player's card:

- title, flag and profile link;
- rating at the game's speed (with recent progress, percentile and rank) and at the other speeds;
- record at this speed and overall, as won / drawn / lost bars;
- peak and lowest rating, win streaks, average opponent and time played;
- when they joined and were last seen, and their bio;
- their score against this opponent;
- their **rating history** at any speed, from 3 months to all time, with values on hover.

The card stays open while the pointer is on it. Moving away or Esc closes it.

## Watching a player

**Watch a player** (in **Watch**) follows any player's games, a bot's for example, live on the board, one after another, from that player's side.

No engine, token or connection is needed, and you can turn Analysis on. **Stop** leaves the last position on the board. Lichess shows other people's games a few moves behind.

## Lichess TV

Below it, **Lichess TV** shows a tile for each channel: Top rated (the main Lichess TV), Bullet, Blitz, Rapid, Classical, UltraBullet, Bot and Computer. Each tile shows the player on now and their rating, refreshed every 30 seconds while Watch is open.

- Click a tile to put that channel on the board. The one being watched is outlined and marked **Live**.
- The game is shown live, from the side Lichess TV shows. When it ends, the result stays for a few seconds before the channel's next game comes on.
- Click another tile to switch, or **Stop** to end it. No token is needed, and games watched to the end are saved to the database.

## Several games at once

When a player you follow is in more than one game (a simul, correspondence games), up to six are followed. A row of small boards appears under the status line, one per game, with its live position, the opponent, the move number and, once over, the result.

- The game on the board is outlined in the row. Click another to put it on the board.
- A game that starts while another is being played joins the row (found within about a quarter of a minute) without taking the board.
- When the game on the board ends and another is still going, the newest one takes the board three seconds after the result shows. After a rated game the board first waits up to 12 seconds for the rating changes, then three seconds more.
- If nothing else is going, the next new game takes the board when it starts.
- Clicking a game in the row during those three seconds, even the finished one, keeps the board on it.
- Finished games leave the row when a new one starts. Every game followed to its end is saved to the database, if watched games are kept.

Your engine's own games work the same way; see [Several engine games at once](lichess-bot.md#several-engine-games-at-once).

### Tiles

With several games going, the **Tiles** button at the start of the row shows all of them at once, each on its own board, as large as fits the window.

- Each tile shows both players (flags, titles, ratings, running clocks) and how the game stands. The main board's game is marked; a finished game shows its result until a new one starts.
- Click a tile to put that game on the main board and return to it. **Close** or Esc returns without changing the game.
- Tiles stays on, and comes back whenever several games are going, until you close it.
- While it shows, the versus and K.O. screens of the other games are left out.

This also works when your engine plays several games at once.

## Country flags

Lichess players and bots show the flag from their Lichess profile beside their name: on the player bars, the Game card, the versus and result screens, the row of small boards, the match history, the challenge window and the lists in the Lichess tab (challenges, games, bots online). Hover a flag for the country's name.

Players without a flag, and local players, show none. On Windows, Ponder uses Twemoji's flags (CC BY 4.0).

## Chat

While a Lichess game of your own or your engine's is on the board, a **Chat** card above the Game card has the game's two rooms:

- **Spectators** – everyone watching the game.
- **Players** – between the two players.

Messages arrive live (earlier players'-room messages are read when the game opens). Lichess's own notices are in italics, and the other room's button counts unread messages. Write up to 140 characters and press Enter; you speak as the account in the game (yours or your engine's Bot account). After the game you can still write, but answers no longer arrive.

Lichess gives a game's chat only to its players, so for a game you follow with **Watch a player** the card says so and links to the game on Lichess.

### Floating chat

In your games and your engine's, the chat floats over the app in its own window, at the top right at first.

Drag the header to move it and the bottom right corner to resize it (double-click the corner to reset). Fold it to its header (rooms and unread counts stay visible) with the arrow or a double-click. ✕ hides it; a **Chat** button at the bottom right, with the unread count, brings it back. Its place, size and state are remembered, and each new game shows it again, unfolded. A game you only watch keeps its chat note in the side panel.
