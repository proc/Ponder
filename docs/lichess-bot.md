# Your engine on Lichess

Your engine can play on [Lichess](https://lichess.org) through the [Bot API](https://lichess.org/api#tag/Bot), from the **Bot** part of the Lichess tab. For playing and watching yourself, see [Lichess](lichess.md).

## Connecting

1. Create a new Lichess account that has never played a game. Signed in to it, create a token with `bot:play`, `challenge:read` and `challenge:write` (**Settings → Lichess → Create a token on Lichess** ticks these).
2. Paste it in **Settings → Lichess**, choose the engine and press **Connect**. The token is encrypted with the system keychain when available and never shown again.
3. If needed, press **Upgrade to Bot account** and confirm. This cannot be undone.

Connecting answers no challenge by itself. Games the bot account is already playing when you connect are taken over: your engine goes on from the position and clock they stand at, moves at once when it is its turn, and the game shows on the board (with several, the one where it is your engine's move). The same happens after a lost connection comes back, for games that started meanwhile; games your engine was playing simply go on. Correspondence and variant games are left alone. Apart from those, your engine plays the games you start here (**Accept**, or a challenge you send). A game started elsewhere while connected (by another program, say) is listed as *Not played* with **Play** to hand it to the engine. Disconnecting mid-game resigns the games your engine plays, after asking.

### Several accounts

You can save tokens for several bot accounts and switch between them. Paste another account's token under **Add a token** (Settings → Lichess) to add it; a token for an account already saved replaces its old one. Choose the account under **Account**, or in the Lichess tab's **Bot** part, where the account menu shows once two are saved. Switching while connected disconnects (asking first, and resigning games your engine is playing) and connects again as the other account. **Forget** removes the chosen account's token.
## Engine and account

- The **Engine** menu under **Your engine on Lichess** picks the bot's engine (same as Settings → Lichess); **Options…** opens its UCI options. A different engine plays from the next game; games in progress keep theirs. Saved options reach games in progress too, before the engine's next search. To restart the engine of a game in progress (a stuck engine, say), use **⇄ Engine** → **↻ Reload** on your engine's bar beside the board.
- **Games at once**, under the Engine menu, is how many games your engine plays at the same time (1–8). It counts games being played, accepted challenges not yet started, and your engine's own waiting challenge. **Accept automatically** and the random-bot challenger both keep within it; a challenge you accept or send by hand isn't held back. Changes apply at once.
- **Engine and bot account** shows the engine's name, program, command line and UCI options, and the bot's ratings per speed, record, peak and lowest, and rating history, refreshed after each game.

## Accepting challenges

Challenges to your bot (or your own account) are listed in the tab and float up in a window at the bottom right, each with **Accept**, **Decline**, the challenger's ratings, games, record and bio (**More…** for full record and rating history), and **Decline with** to pick Lichess's reason (too fast, rated only, no bots, …). **Hide** (or ✕) shrinks it to a corner button with the count; the next challenge brings it back. When Lichess will not take an answer (a network error, Lichess failing, a token without challenge rights), the error shows on that challenge's row with **Dismiss**, which takes it off the list here without asking Lichess again; the same goes for a challenge you sent that cannot be cancelled. A challenge Lichess no longer has (cancelled or expired meanwhile) is taken off the list as soon as you try to answer it, with a note saying so.

**Accept automatically** (off after every connect) accepts challenges matching the **Auto-accept rules** and declines the rest with the matching reason. The rules set:

- speeds (UltraBullet to Classical), rated and casual, people and bots, set-up positions;
- minutes and increment, and challenger rating (from – to; unrated challengers pass).

A challenge that would go over **Games at once** is declined with "later".

An empty limit means any; changes apply at once, and rules that would decline everything are flagged. Variants and correspondence are always declined.

## Challenging

You can challenge any player or online bot (time, increment, colour, rated). One challenge waits at a time; Challenge buttons are off until it is answered or cancelled. An unanswered challenge is withdrawn after 30 seconds (change it, or 0 for never, in **Settings → Lichess**). A failed, declined or unanswered challenge raises a notification at the top right saying why; hover to keep it, ✕ to dismiss it.

### Online bots

**Online bots**, at the bottom of **Bot**, lists up to 300 bots online now, no connection needed: title, flag, rating at the chosen speed (**?** for provisional), games, other ratings, and free or playing (refreshed every 20 seconds). Search by name, bio or country, filter by rating or free only, and sort by rating, games, time played, name or newest. Hover a name for the player card; click a bot for its details. Each row has **Challenge** (your engine, with *Challenge a player*'s settings), **Play** (you, with *Challenge a friend*'s settings), **TV** (watch it on the board) and **Profile**.

### Random bot

**Challenge random bot** challenges a random online bot matching these settings, kept between runs:

- **Clock** – time and increment; ratings are read at its speed.
- **Your engine plays** – either color, White or Black.
- **Random clock** – a random pairing per challenge from chosen minutes and increments (default 1 and 3 minutes, 1 or 2 seconds), like lichess-bot's `challenge_initial_time` and `challenge_increment`.
- **Rated** – *Casual*, *Rated* or *Random*.
- **Their rating** – *Between* two values (empty: any), or *Around yours* by that many points, re-read every few minutes.
- **Skip provisional ratings** and **At least … games** at the speed.
- **Prefer** – *Any rating*, *Higher rated* or *Lower rated* among the bots that fit, like lichess-bot's `rating_preference`: the far end of the range is about twice as likely as the near end.
- **Skip bots that declined** – like lichess-bot's `challenge_filter`, for a day (until Ponder closes): *Never*; *Always* (`coarse`: a bot that declined is not challenged again); or *Only what it declined* (`fine`: that speed for "too fast", "too slow" or "time control", rated or casual for those, anything for other reasons; after its hour of rest).
- **Never challenge** – comma-separated bot names (lichess-bot's `block_list`).

With **Random clock** or **Rated: Random**, each challenge picks its settings at random, as lichess-bot's matchmaking does, and the challenges window shows the picked clock and mode with "picked at random". Ponder's engine plays standard chess with a clock only, so there is no `challenge_variant` or `challenge_days` (correspondence) setting.

A bot that declines or does not answer in 30 seconds is replaced by another, at most one challenge a minute, until one accepts. Each bot is challenged once: one that declines or does not answer, or whose challenge fails, is not challenged again for an hour, at any clock, whatever **Skip bots that declined** says, and even if you stop and start again. Asking again would only bring another decline, and Lichess limits how many challenges a bot may send. A bot that accepts may be challenged again for the next game. Only a challenge Lichess refuses with "too many requests" does not count, since it never reached the bot. When every bot that fits has been challenged, the challenger says when the first can be asked again, and meanwhile challenges any new bot that comes online. **Stop** ends it. **Games** keeps it going until that many games have started (0: until **Stop**), holding back only while **Games at once** is full; it can start while your engine plays.

### Auto challenge

The **Auto challenge** switch runs the random-bot challenger without end. It starts when turned on and each time the engine connects, and ends when turned off or with **Stop**. It is off by default. Settings changed while it runs apply from its next look at the bots.

### Rate limits

When Lichess refuses a challenge for too many requests (including the daily bot-games limit, which can last hours), nothing goes out until the wait ends: Lichess's time, or 1, 2, 4, 8, up to 10 minutes, reset on success. Restarting does not shorten it. Bots that have used up their daily bot games are skipped.

## The challenge window

Every challenge you send, including ones made on the Lichess website, shows in a small floating window: waiting (with countdown and **Cancel**), accepted, declined with reason, no answer, withdrawn, or **Not sent** with the error. Answered challenges go after a few seconds.

While the random-bot challenger runs, the window stays up with its latest challenge, an **Auto challenge** switch or the game count with **Stop**, and "1 of 2 games at once". Above the switch, a line always says what the challenger is doing now, with a countdown when it waits:

- "Looking for an opponent…"
- "Challenged maia1 to 3+2 blitz casual: waiting for an answer (12 s so far; withdrawn in 18 s if there is no answer)."
- "grumpy declined: later. Next challenge in 42 s." (or "did not answer", or why it could not be sent)
- "No bot online fits your settings at blitz right now (52 online). Trying again in 30 s."
- "Lichess refused a challenge for too many requests: none until 12:34 (in 9 min)."
- "Your engine is playing: the next challenge goes out when the game ends."

That line stays when the window is folded, so the window is never blank while the challenger runs. While it waits for your engine's game to end, click the line (**Show the game**) to put that game on the board; with several, each click shows the next. Click an accepted challenge whose game is being played to show that game. Drag, fold or hide it (✕); a **Challenges** button at the bottom right brings it back. It is hidden in zen mode.

## Watching your engine play

Each game uses its own copy of the engine, on the Lichess clock; Analysis pauses meanwhile.

- **Watch** shows a game live from your engine's side, with **✕ Abort** before the second move. There's no Resign for a game your engine plays: it plays it out (a *Not played* game can still be resigned from its row). The first game takes the board by itself, but only when the board shows nothing of yours. If you are playing a game here, or have a game open from the Games list (or a finished game still on the board), your engine's game does not replace it: it appears in the row of small boards above the board instead, live, as if you were watching several games. Click it there to put it on the board (a game you are playing here is abandoned, after you confirm).
- The side panels show the engine's window, the Game card, the chat and an **Opponent** card.
- A solid arrow shows the move the engine intends, a dashed one the reply it expects; that piece wears a thought bubble. Arrows show only on the live position.

### Several engine games at once

With **Games at once** above one, a row of small boards appears, as when [watching several games](lichess.md#several-games-at-once), and **Tiles** works too. Click a game to switch the board; a new game takes the board unless you turn off **Switch the board to your engine's new game when it starts another** (Settings → General). When the game on the board ends, another takes over three seconds later (after up to 12 seconds for a rating change).

### Match history

A floating **Match history** window lists finished games, newest first, with a win/draw/loss tally: final position, **Won** / **Lost** / **Draw** and how, opponent, moves, colour, clock and date. Click one to view it. The last 60 are kept; **Clear history** empties it. It moves, folds and hides like the chat.

## The engine window

While your engine's game is on the board, its window floats: drag, resize, fold or hide it (a button with the engine's name and depth brings it back). Its place and size are remembered, and each new game shows it again. It shows:

- **Depth** – a large badge beside the engine's name.
- **Statistics** – average depth, nodes a move, speed, **Ponder hits**, moves searched, and **Hash**: the hash table's size and how full it is, when the engine says.
- **Win/draw/loss chances** – for engines with `UCI_ShowWDL`, a bar for the best line and one beside each line.
- **Live search** – up to 25 updates a second; a **ponder** row while pondering, and a **hit** mark on moves that began as ponder hits.
- **Scores** – on the evaluation bar, in the moves list and on each row, kept for the whole game.

See [Engines and analysis](engines-and-analysis.md) for engines in general.

## Pondering

Your engine thinks on its opponent's time when it supports the `Ponder` option. A ponder hit is called out over the moved piece with **PONDER HIT!** and a short sound (it follows the Sounds setting, also in zen mode). **Settings → Lichess → Think on the opponent's time** turns this off.

## Draws

Under **Settings → Lichess → Draws** (lichess-bot's `offer_draw_*` options):

- *Offer and accept draws* turns it on or off.
- *Score within … centipawns of zero*, *for … moves in a row*, *with at most … pieces on the board* set when a draw is offered.
- *Also when the Lichess tablebase says the position is a draw* offers one in drawn positions of seven pieces or fewer, looked up at `tablebase.lichess.ovh` (only the position is sent).

The same rules accept the opponent's offers. Defaults: on, 0, 10 moves, 10 pieces, tablebase on; changes apply at once, also to games under way. When the rules do not accept an offer, a small window at the top asks you to **Accept draw** or **Decline**; the offer lapses at your engine's next move.

## Hello and goodbye

Your engine greets its opponent and spectators when a game starts and says goodbye when it ends. **Settings → Lichess → Chat messages** sets the four messages (`{me}` and `{opponent}` are replaced); an empty message is not sent, and **Say nothing** turns them all off. There is no hello in a game already under way and no goodbye after an abort.

Each engine can have its own messages: pick it under **Messages of** (it starts on the bot's engine) and change one. An engine without its own says those of **Every engine**; **Use the messages for every engine** takes an engine's own away. A game keeps the messages of the engine playing it, even after you choose another engine for the bot.

### Talking during the game

With **Engine chat** on (in the AI panel's Commentary view, off at first), your engine also answers its opponent's moves in the game chat every few moves, in character. Each message goes to both rooms: the players' room for its opponent, and the spectators' room for the people watching. If Lichess refuses it in one room, it still goes to the other. The AI model writes each message from what the engine thinks of the position. Set how often, and the engine's name and personality, in the same place. The engine plays its move first, and the message follows. The engine remembers who it has played: its record against the opponent on Lichess (the head-to-head score on the player card) goes with its first message of the game, and isn't brought up again. When its opponent writes to it, in either room, it answers in that room, in character (at most eight answers a game). When the game is over, it sends a last message: the result and how the game ended, as the winner or the loser, with a quick recap of the game. A message may be up to 400 characters; Lichess takes 140 at a time, so a longer one goes in up to three parts, split between sentences. At most one message every 10 seconds in a game, and six a minute over all games (each part counting as one); a message due sooner waits, and goes out about the latest move. See [Engine chat](ai.md#engine-chat).
