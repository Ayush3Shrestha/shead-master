import { applyAction, canPickup, getPlayer, playableCardIds, zoneOf } from './engine.js';
import { abilityOf, canPlayOn, cardSortValue, RANK_VALUE } from './rules.js';
import { NORMAL_RANKS, type BotLevel, type Card, type GameAction, type GameSettings, type GameState, type NormalRank, type PlayerState, type Rank } from './types.js';

/**
 * CPU players at three strengths. Every level only uses information a human in that seat
 * would have: its own hand, everything face-up on the table, and cards it has watched being
 * played, burned or picked up. Hidden cards (deck, face-down, unknown hand cards) are never read.
 *
 * Returns null when the player has nothing to do.
 */
export function chooseBotAction(
  state: GameState,
  playerId: string,
  rng: () => number = Math.random,
  level: BotLevel = 'hard',
): GameAction | null {
  const p = getPlayer(state, playerId);
  if (!p) return null;
  if (state.status === 'SETUP') return setupMove(state, p, rng, level);
  if (state.status !== 'PLAYING' || state.players[state.currentIdx]?.id !== playerId) return null;

  const zone = zoneOf(p);
  if (zone === 'done') return null;
  // Face-down cards are a blind guess for everyone.
  if (zone === 'faceDown') return { type: 'playFaceDown', index: Math.floor(rng() * p.faceDown.length) };

  const source = zone === 'hand' ? p.hand : p.faceUp;
  const playable = new Set(playableCardIds(state, playerId));
  const options = source.filter((c) => playable.has(c.id));
  if (options.length === 0) return canPickup(state, playerId) ? { type: 'pickup' } : null;

  const byRank = groupByRank(options, source);
  if (level === 'normal') return normalMove(state, byRank, rng);
  if (level === 'hard') return hardMove(state, byRank);
  return expertMove(state, p, byRank, rng);
}

// ───────────────────────────── setup ─────────────────────────────

function setupMove(state: GameState, p: PlayerState, rng: () => number, level: BotLevel): GameAction | null {
  if (p.setupReady) return null;
  const s = state.settings;
  // Normal bots sometimes don't bother arranging their cards.
  if (level === 'normal' && rng() < 0.5) return { type: 'setupReady', ready: true };
  // Keep the strongest cards face-up (they're played late, when you need them most).
  const value = (c: Card) => setupValue(c, s, level, [...p.hand, ...p.faceUp]);
  const all = [...p.hand, ...p.faceUp].sort((a, b) => value(b) - value(a) || (a.id < b.id ? -1 : 1));
  const wantFaceUp = new Set(all.slice(0, p.faceUp.length).map((c) => c.id));
  const handOut = p.hand.find((c) => wantFaceUp.has(c.id));
  const upOut = p.faceUp.find((c) => !wantFaceUp.has(c.id));
  if (handOut && upOut) return { type: 'swap', handCardId: handOut.id, faceUpCardId: upOut.id };
  return { type: 'setupReady', ready: true };
}

function setupValue(c: Card, s: GameSettings, level: BotLevel, six: Card[]): number {
  const base = cardSortValue(c.rank, s);
  if (level !== 'expert') return base;
  // Experts keep pairs together face-up so they can be dumped in one go later.
  const pair = six.filter((x) => x.rank === c.rank).length > 1 ? 3 : 0;
  return base + pair;
}

// ───────────────────────────── helpers ─────────────────────────────

interface RankOption {
  rank: Rank;
  cards: Card[]; // every copy in the zone, all playable
}

function groupByRank(options: Card[], source: Card[]): RankOption[] {
  const ranks = [...new Set(options.map((c) => c.rank))];
  return ranks.map((rank) => ({ rank, cards: source.filter((c) => c.rank === rank) }));
}

const isWildAbility = (rank: Rank, s: GameSettings) => {
  const ab = abilityOf(rank, s);
  return rank === 'JOKER' || ab === 'reset' || ab === 'invisible' || ab === 'burn';
};
const play = (cards: Card[]): GameAction => ({ type: 'play', cardIds: cards.map((c) => c.id) });

// ───────────────────────────── normal ─────────────────────────────

/** Casual: usually plays something low, but often just plays whatever, specials included. */
function normalMove(state: GameState, byRank: RankOption[], rng: () => number): GameAction {
  const s = state.settings;
  byRank.sort((a, b) => cardSortValue(a.rank, s) - cardSortValue(b.rank, s));
  const pick = rng() < 0.4 ? byRank[Math.floor(rng() * byRank.length)] : byRank[0];
  // Doesn't always remember to play all its copies.
  const cards = rng() < 0.3 ? pick.cards.slice(0, 1) : pick.cards;
  return play(cards);
}

// ───────────────────────────── hard ─────────────────────────────

/** Solid fundamentals: shed the cheapest cards, hold specials, burn big piles. */
function hardMove(state: GameState, byRank: RankOption[]): GameAction {
  return play(hardCards(state, byRank));
}

function hardCards(state: GameState, byRank: RankOption[], burnPile = 6, burnInstead = 11): Card[] {
  const s = state.settings;
  const sorted = [...byRank].sort((a, b) => cardSortValue(a.rank, s) - cardSortValue(b.rank, s));
  const normals = sorted.filter((o) => !isWildAbility(o.rank, s));
  const burn = sorted.find((o) => abilityOf(o.rank, s) === 'burn');

  // A big pile is worth burning rather than spending a high card on it.
  if (burn && state.discard.length >= burnPile && (!normals.length || RANK_VALUE[normals[0].rank as NormalRank] >= burnInstead)) {
    return burn.cards.slice(0, 1);
  }
  if (normals.length) return normals[0].cards;
  // Only wilds left: use the least valuable, one at a time while the deck lasts.
  return state.drawPile.length > 0 ? sorted[0].cards.slice(0, 1) : sorted[0].cards;
}

// ───────────────────────────── expert ─────────────────────────────

export const EXPERT_ROLLOUTS = 12;

/**
 * Card counting + look-ahead search (determinized Monte-Carlo).
 * The bot knows exactly which cards it has *not* seen (deck, face-down cards, opponents' unknown
 * hand cards) but not where they are. For each candidate play it deals those unseen cards out at
 * random many times, plays every scenario to the end with solid play from everyone, and picks the
 * move that finishes best on average. It never reads where a hidden card actually is.
 */
function expertMove(state: GameState, me: PlayerState, byRank: RankOption[], rng: () => number): GameAction {
  const base = hardCards(state, byRank, 5, 10);
  const candidates = uniqueCandidates([base, ...byRank.flatMap((o) => (o.cards.length > 1 ? [o.cards, o.cards.slice(0, 1)] : [o.cards]))]);
  if (candidates.length === 1) return play(candidates[0]);
  const unseen = unseenCounts(state, me);
  for (const cards of candidates) if (simulate(state, me, cards, unseen).finished) return play(cards);

  const totals = candidates.map(() => 0);
  for (let k = 0; k < EXPERT_ROLLOUTS; k++) {
    const world = determinize(state, me, rng); // same random world for every candidate (fair comparison)
    candidates.forEach((cards, i) => {
      totals[i] += rollout(world, me.id, cards, rng);
    });
  }
  let best = 0;
  // Small bias towards the fundamentally sound move to break near-ties.
  totals[0] += 0.25;
  for (let i = 1; i < candidates.length; i++) if (totals[i] > totals[best]) best = i;
  return play(candidates[best]);
}

function uniqueCandidates(list: Card[][]): Card[][] {
  const seen = new Set<string>();
  return list.filter((cards) => {
    const key = `${cards[0].rank}x${cards.length}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A copy of the game where every card hidden from `me` has been shuffled among the hidden slots.
 * Only the *set* of hidden cards is used, which is exactly what a card-counting human knows.
 */
function determinize(state: GameState, me: PlayerState, rng: () => number): GameState {
  const w = lightClone(state);
  const hidden: Card[] = [...w.drawPile];
  const slots: { arr: Card[]; idx: number }[] = w.drawPile.map((_, idx) => ({ arr: w.drawPile, idx }));
  for (const p of w.players) {
    p.faceDown.forEach((c, idx) => {
      hidden.push(c);
      slots.push({ arr: p.faceDown, idx });
    });
    if (p.id === me.id) continue;
    const known = new Set(p.known ?? []);
    p.hand.forEach((c, idx) => {
      if (known.has(c.id)) return;
      hidden.push(c);
      slots.push({ arr: p.hand, idx });
    });
  }
  // Canonical order first, so the result can't depend on where hidden cards really sit.
  hidden.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = hidden.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [hidden[i], hidden[j]] = [hidden[j], hidden[i]];
  }
  slots.forEach((slot, i) => (slot.arr[slot.idx] = hidden[i]));
  return w;
}

/** Play `cards`, then let everyone play solid moves until the end. 1 = went out first … 0 = Shithead. */
function rollout(world: GameState, meId: string, cards: Card[], rng: () => number): number {
  const sim = lightClone(world);
  if (!applyAction(sim, meId, play(cards)).ok) return -1;
  for (let steps = 0; sim.status === 'PLAYING' && steps < 400; steps++) {
    const actor = sim.players[sim.currentIdx];
    const a = fastPolicy(sim, actor, rng);
    if (!a || !applyAction(sim, actor.id, a).ok) break;
  }
  const n = sim.players.length;
  const mePlayer = getPlayer(sim, meId)!;
  if (mePlayer.place !== null) return (n - mePlayer.place) / (n - 1);
  // Unfinished (very long game): judge by how many cards we hold relative to the others.
  const mine = cardsLeft(mePlayer);
  const fewer = sim.players.filter((p) => p.id !== meId && p.place === null && cardsLeft(p) > mine).length;
  return (fewer / Math.max(1, n - 1)) * 0.5;
}

/** Hard-level policy without the allocation overhead, for rollouts. */
function fastPolicy(st: GameState, p: PlayerState, rng: () => number): GameAction | null {
  const zone = zoneOf(p);
  if (zone === 'done') return null;
  if (zone === 'faceDown') return { type: 'playFaceDown', index: Math.floor(rng() * p.faceDown.length) };
  const source = zone === 'hand' ? p.hand : p.faceUp;
  const options = source.filter((c) => canPlayOn(c.rank, st.discard, st.settings));
  if (!options.length) return { type: 'pickup' };
  return play(hardCards(st, groupByRank(options, source)));
}

interface Outcome {
  finished: boolean;
  burned: boolean;
  pStuck: number;
  nextDanger: boolean;
}

/** Play `cards` on a light copy of the state and read only public facts from the result. */
function simulate(state: GameState, me: PlayerState, cards: Card[], unseen: Map<Rank, number>): Outcome {
  const sim = lightClone(state);
  const res = applyAction(sim, me.id, play(cards));
  if (!res.ok) return { finished: false, burned: false, pStuck: 0, nextDanger: false };
  const burned = res.events.some((e) => e.type === 'PILE_BURNED');
  const finished = getPlayer(sim, me.id)!.place !== null;
  if (sim.status !== 'PLAYING') return { finished, burned, pStuck: 1, nextDanger: false };
  const next = sim.players[sim.currentIdx];
  const left = cardsLeft(next);
  const nextDanger = next.id !== me.id && (left <= 3 || (zoneOf(next) !== 'hand' && sim.drawPile.length === 0 && left <= 4));
  return { finished, burned, pStuck: probStuck(sim, next, unseen), nextDanger };
}

function cardsLeft(p: PlayerState) {
  return p.hand.length + p.faceUp.length + p.faceDown.length;
}

/** Copy just enough of the state for one simulated move (the log and burned list are dropped). */
function lightClone(st: GameState): GameState {
  return {
    ...st,
    players: st.players.map((p) => ({ ...p, hand: [...p.hand], faceUp: [...p.faceUp], faceDown: [...p.faceDown] })),
    drawPile: [...st.drawPile],
    discard: [...st.discard],
    burned: [],
    finishOrder: [...st.finishOrder],
    log: [],
  };
}

/** How much a card is worth keeping in hand (higher = spend reluctantly). */
function keepValue(rank: Rank, s: GameSettings, st: GameState, cardsLeft: number): number {
  const endgame = st.drawPile.length === 0 && cardsLeft <= 4 ? 0.5 : 1;
  if (rank === 'JOKER') return 2.2 * endgame;
  const ab = abilityOf(rank, s);
  if (ab === 'burn') return 2.0 * endgame;
  if (ab === 'reset') return 1.6 * endgame;
  if (ab === 'invisible') return 1.2 * endgame;
  return ((RANK_VALUE[rank] - 4) / 10) * 0.9 * endgame;
}

/** Cards the bot hasn't seen: deck composition minus everything visible or remembered. */
function unseenCounts(state: GameState, me: PlayerState): Map<Rank, number> {
  const counts = new Map<Rank, number>();
  for (const r of NORMAL_RANKS) counts.set(r, 4);
  if (state.settings.jokers) counts.set('JOKER', 2);
  const seen: Card[] = [...me.hand, ...state.discard, ...(state.burned ?? [])];
  for (const p of state.players) {
    seen.push(...p.faceUp);
    if (p.id !== me.id) {
      const known = new Set(p.known ?? []);
      seen.push(...p.hand.filter((c) => known.has(c.id)));
    }
  }
  for (const c of seen) counts.set(c.rank, Math.max(0, (counts.get(c.rank) ?? 0) - 1));
  return counts;
}

/** Estimated probability that `p` cannot legally play on the simulated pile. */
function probStuck(sim: GameState, p: PlayerState, pool: Map<Rank, number>): number {
  const s = sim.settings;
  const beats = (rank: Rank) => canPlayOn(rank, sim.discard, s);
  const zone = zoneOf(p);
  if (zone === 'done') return 0;
  if (zone === 'faceUp') return p.faceUp.some((c) => beats(c.rank)) ? 0 : 1;

  let total = 0;
  let good = 0;
  for (const [rank, n] of pool) {
    total += n;
    if (beats(rank)) good += n;
  }
  const pBeat = total ? good / total : 0.5;
  if (zone === 'faceDown') return 1 - pBeat;

  const known = new Set(p.known ?? []);
  const knownCards = p.hand.filter((c) => known.has(c.id));
  if (knownCards.some((c) => beats(c.rank))) return 0;
  const unknown = p.hand.length - knownCards.length;
  return Math.pow(1 - pBeat, unknown);
}

