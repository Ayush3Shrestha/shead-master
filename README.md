# Shithead — Online Multiplayer Card Game

A real-time, mobile-first web game of **Shithead** (a.k.a. Palace / Karma / Shed) for 2–5 players.
It runs in any phone or desktop browser and installs to the home screen as a PWA. Friends join
with a 5-letter code or an invite link, with no app store and no sign-up.

```
shared/   Rules engine (pure TypeScript): dealing, validation, specials, views, bot
server/   Node + Express + Socket.IO. Authoritative game state, rooms, wallets
client/   React + Vite single-page app (mobile-first, PWA)
```

## Quick start

```bash
npm install
npm run dev        # server on :3001, client on http://localhost:5173 (proxied)
```

Production (one process serves the API, websockets and the built client):

```bash
npm run build
npm start          # http://localhost:3001  (PORT, DATA_FILE, CORS_ORIGIN env vars)
```

Or with Docker: `docker build -t shead . && docker run -p 3001:3001 -v shead-data:/app/data shead`

Tests: `npm test` runs the engine unit tests, 500 simulated bot games and the socket integration tests.
Type-check everything with `npm run typecheck`.

## Features

| Area | What's in |
|---|---|
| Modes | **Quick Play** (auto-matchmaking, auto-start), **Private Party** (room code + invite link), **Custom Game** (host edits every rule), **Ranked** (token stakes), **Play vs CPU** (single player) |
| Rules | 3 down / 3 up / 3 hand, card exchange before play, multi-card plays, draw to 3, pickup, face-up then blind face-down phase, finishing order, Shithead |
| Specials (host-configurable) | 2 Reset · 3 Invisible · **7 Reverse** · 8 Skip · 10 Burn · four-of-a-kind burn · optional Jokers with a chosen power |
| House rules | Skip stacking, voluntary pickup, jokers, hand size 3/4, turn timer off/15/30/45/60s, spectators, public/private |
| Multiplayer | Server-authoritative, every move validated, per-player views (no hidden-card leakage), version check against double submits |
| Resilience | Reconnect to your seat with the same session; a disconnected player's turn pauses 30s, then the autopilot plays; host can hand a seat to a bot; host migration |
| CPU players | Three levels (**Normal**, **Hard**, **Expert**) for single player or to fill empty seats in a party |
| Extras | action history, burn/skip/reverse animations, haptics on your turn, results + share, leaderboard, stats |

### Single player and CPU levels

**Play vs CPU** starts a private table against 1–4 bots of the chosen level straight away (no timer by default; house rules can be changed), and **Rematch** deals again instantly. Hosts can also add bots of any level to a party lobby. Bots are not allowed in ranked games.

| Level | How it plays |
|---|---|
| 🙂 **Normal** | Casual. Often plays a random card, wastes specials, sometimes forgets to play all its copies, and doesn't always arrange its cards before the game. |
| 😈 **Hard** | Solid fundamentals. Sheds its cheapest cards first (all copies together), keeps wild cards back, burns big piles instead of spending high cards, and puts its strongest cards face-up. |
| 🧠 **Expert** | Counts cards and searches ahead. It tracks every card it has seen played, burned or picked up, so it knows exactly which cards are still unseen. For each possible play it deals those unseen cards out at random a dozen times, plays each scenario to the end, and picks the move that finishes best on average. It goes out whenever it can. |

**Bots don't cheat.** They only use what a human in that seat could know: their own hand, everything face-up, and cards they have watched move. A test checks this by moving hidden cards around and confirming the Expert's decision doesn't change.

Measured strength (`npx tsx scripts/bot-arena.ts`, standard rules):

| Match-up | Result |
|---|---|
| Hard vs Normal (2 players, 400 games) | Hard goes out first 70% of the time |
| Expert vs Hard (2 players, 400 games) | Expert goes out first 71% of the time |
| Expert vs 3 Hard (4 players, 200 games) | Expert is the Shithead in 10% of games (Hard bots: ~30% each) |

Games that include bots are recorded in a separate per-level record ("vs Expert: 3/10 won") and don't count towards the leaderboard or public stats, so nobody can pad them by beating Normal bots.

### Ranked mode

* Every player bets the same **stake** (10/50/100/250/500 tokens), escrowed when the game starts.
* **The first player to go out takes the whole pot** immediately. Everyone else loses their stake.
* Ranked tables always use the standard ruleset with a 30s timer and **no bots**, so stakes stay fair.
* Leaving mid-game forfeits your stake (an autopilot plays your cards). If a table is abandoned before
  anyone finishes, every stake is refunded. Stakes are also refunded on server shutdown.
* New players start with 1,000 tokens and can claim +200 every 20 hours.

> Tokens are play money with no cash value. If you ever let players **buy** tokens or cash them out,
> ranked mode becomes real-money gambling (app-store and legal rules apply), so keep it that way.

### Rule decisions (GDD §12)

| Question | Decision |
|---|---|
| Special assignments | Host can put any ability on any rank; one ability per rank. Abilities can be turned off. |
| Which specials are wild? | Reset, Invisible and Burn can go on anything. **Reverse (7) and Skip (8) follow normal rank rules.** Jokers are always wild. |
| Reset | Clears the requirement: the next player may play anything. |
| Invisible | Transparent: the requirement comes from the card below, including "anything" after a reset. |
| Reverse | Flips clockwise ⇄ anti-clockwise once per play (several 7s together still reverse once). With 2 players it has no turn effect. |
| Burn | Always grants another turn, unless the burner just finished. |
| Four-of-a-kind | Four consecutive same-rank cards at the top of the pile, from any players. Any different card (including an invisible) breaks the run. |
| Skip stacking | Off by default (N skips skip one player). When on, N skips skip N players. Two-player skip gives the turn back. |
| Face-down failure | The revealed card goes onto the pile and the player picks up everything. |
| Face-up play | Several face-up cards of the same rank may be played together. If none can be played, pick up the pile. |
| Finishing | Finished players leave the rotation, and play continues until one player is left. |
| Turn timeout | The autopilot makes a sensible move for you (lowest playable card, otherwise pick up, or a random blind flip). |
| First player | Whoever holds the lowest non-special card in hand (ties go to the earliest seat). Seats are shuffled. |

## Architecture notes

* **`shared/src/engine.ts`** is the single source of truth for rules. `applyAction(state, playerId, action)`
  validates and mutates; the server calls nothing else to change a game.
* **`shared/src/view.ts`** builds each player's view: opponents' hands and all face-down cards become counts,
  and card ids are random per game, so ids leak nothing either.
* **`server/src/rooms.ts`** handles room lifecycle, the ready system, quick-play countdowns, one timer per room
  (bot moves, disconnect grace, turn timer), ranked escrow and payouts, and stats.
* **`server/src/store.ts`** keeps guest accounts and wallets in a JSON file (token hashes only). Swap in
  Postgres or Mongo when you scale past one server instance. Rooms live in memory, so horizontal scaling
  would need sticky sessions plus a shared room store.

## Roadmap ideas

Run Expert's search in a worker thread if many CPU tables run at once · registered accounts (email/OAuth) so wallets survive device changes · chat and emotes · sound effects ·
ranked rating/ELO alongside tokens · game history · a native wrapper (Capacitor) for app stores · Redis-backed
rooms for multiple instances.
