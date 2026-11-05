import {
  abilityOf,
  buildDeck,
  canPlayOn,
  maxPlayersForSettings,
  MIN_PLAYERS,
  RANK_VALUE,
  shuffle,
  topRunLength,
} from './rules.js';
import type {
  ActionResult,
  Card,
  GameAction,
  GameEvent,
  GameState,
  GameSettings,
  NormalRank,
  PlayerState,
  Zone,
} from './types.js';

const LOG_LIMIT = 80;

export class GameError extends Error {}

// ─────────────────────────── Creation ────────────────────────────

export function createGame(
  seats: { id: string; name: string }[],
  settings: GameSettings,
  rng: () => number,
  now = Date.now(),
): GameState {
  if (seats.length < MIN_PLAYERS) throw new GameError(`Need at least ${MIN_PLAYERS} players`);
  if (seats.length > maxPlayersForSettings(settings)) throw new GameError('Too many players for this deck');

  const deck = buildDeck(settings, rng);
  const order = shuffle([...seats], rng);
  const players: PlayerState[] = order.map((s) => ({
    id: s.id,
    name: s.name,
    hand: [],
    faceUp: [],
    faceDown: [],
    setupReady: false,
    place: null,
  }));
  // Deal: 3 face-down, then 3 face-up, then the hand — one card at a time, round-robin.
  for (let i = 0; i < 3; i++) for (const p of players) p.faceDown.push(deck.pop()!);
  for (let i = 0; i < 3; i++) for (const p of players) p.faceUp.push(deck.pop()!);
  for (let i = 0; i < settings.handSize; i++) for (const p of players) p.hand.push(deck.pop()!);

  const state: GameState = {
    status: 'SETUP',
    settings,
    players,
    drawPile: deck,
    discard: [],
    burnedCount: 0,
    currentIdx: 0,
    direction: 1,
    finishOrder: [],
    shitheadId: null,
    version: 1,
    turnNumber: 0,
    log: [],
    startedAt: now,
    finishedAt: null,
  };
  pushLog(state, { type: 'GAME_STARTED' });
  pushLog(state, { type: 'CARDS_DEALT', count: players.length });
  return state;
}

// ─────────────────────────── Queries ─────────────────────────────

export function getPlayer(state: GameState, id: string): PlayerState | undefined {
  return state.players.find((p) => p.id === id);
}

export function zoneOf(p: PlayerState): Zone {
  if (p.hand.length) return 'hand';
  if (p.faceUp.length) return 'faceUp';
  if (p.faceDown.length) return 'faceDown';
  return 'done';
}

export function currentPlayer(state: GameState): PlayerState | null {
  if (state.status !== 'PLAYING') return null;
  return state.players[state.currentIdx] ?? null;
}

export function activePlayers(state: GameState): PlayerState[] {
  return state.players.filter((p) => p.place === null);
}

/** Ids of cards (from the player's current zone) that can legally start a play now. */
export function playableCardIds(state: GameState, playerId: string): string[] {
  const p = getPlayer(state, playerId);
  if (!p || state.status !== 'PLAYING') return [];
  const zone = zoneOf(p);
  if (zone !== 'hand' && zone !== 'faceUp') return [];
  const cards = zone === 'hand' ? p.hand : p.faceUp;
  return cards.filter((c) => canPlayOn(c.rank, state.discard, state.settings)).map((c) => c.id);
}

export function canPickup(state: GameState, playerId: string): boolean {
  const p = getPlayer(state, playerId);
  if (!p || state.status !== 'PLAYING' || currentPlayer(state)?.id !== playerId) return false;
  if (state.discard.length === 0) return false;
  const zone = zoneOf(p);
  if (zone !== 'hand' && zone !== 'faceUp') return false;
  return state.settings.voluntaryPickup || playableCardIds(state, playerId).length === 0;
}

// ─────────────────────────── Actions ─────────────────────────────

/**
 * Validate and apply an action. Mutates `state` only when the action is accepted.
 * This is the single authority for the rules — the server calls it for every move.
 */
export function applyAction(state: GameState, playerId: string, action: GameAction, now = Date.now()): ActionResult {
  try {
    const events: GameEvent[] = [];
    const emit = (e: GameEvent) => {
      events.push(e);
      pushLog(state, e);
    };
    switch (action.type) {
      case 'swap':
        doSwap(state, playerId, action.handCardId, action.faceUpCardId, emit);
        break;
      case 'setupReady':
        doSetupReady(state, playerId, action.ready, emit);
        break;
      case 'play':
        doPlay(state, playerId, action.cardIds, emit, now);
        break;
      case 'playFaceDown':
        doPlayFaceDown(state, playerId, action.index, emit, now);
        break;
      case 'pickup':
        doPickup(state, playerId, emit);
        break;
      default:
        throw new GameError('Unknown action');
    }
    state.version++;
    return { ok: true, events };
  } catch (err) {
    if (err instanceof GameError) return { ok: false, error: err.message };
    throw err;
  }
}

type Emit = (e: GameEvent) => void;

function requireSetup(state: GameState, playerId: string): PlayerState {
  if (state.status !== 'SETUP') throw new GameError('Card exchange is over');
  const p = getPlayer(state, playerId);
  if (!p) throw new GameError('You are not in this game');
  return p;
}

function doSwap(state: GameState, playerId: string, handCardId: string, faceUpCardId: string, emit: Emit) {
  const p = requireSetup(state, playerId);
  if (p.setupReady) throw new GameError('Un-ready to change your cards');
  const hi = p.hand.findIndex((c) => c.id === handCardId);
  const fi = p.faceUp.findIndex((c) => c.id === faceUpCardId);
  if (hi < 0 || fi < 0) throw new GameError('You can only swap your own hand and face-up cards');
  [p.hand[hi], p.faceUp[fi]] = [p.faceUp[fi], p.hand[hi]];
  emit({ type: 'CARDS_EXCHANGED', playerId });
}

function doSetupReady(state: GameState, playerId: string, ready: boolean, _emit: Emit) {
  const p = requireSetup(state, playerId);
  p.setupReady = !!ready;
  if (state.players.every((pl) => pl.setupReady)) beginPlay(state);
}

/** Leave SETUP: the holder of the lowest non-special card starts (ties → earliest seat). */
export function beginPlay(state: GameState) {
  if (state.status !== 'SETUP') return;
  let best = Infinity;
  let starter = 0;
  state.players.forEach((p, idx) => {
    for (const c of p.hand) {
      if (c.rank === 'JOKER' || abilityOf(c.rank, state.settings)) continue;
      const v = RANK_VALUE[c.rank as NormalRank];
      if (v < best) {
        best = v;
        starter = idx;
      }
    }
  });
  state.status = 'PLAYING';
  state.currentIdx = starter;
  state.turnNumber = 1;
  pushLog(state, { type: 'TURN_STARTED', playerId: state.players[starter].id });
}

function requireTurn(state: GameState, playerId: string): PlayerState {
  if (state.status !== 'PLAYING') throw new GameError('The game is not in progress');
  const p = currentPlayer(state);
  if (!p || p.id !== playerId) throw new GameError("It's not your turn");
  return p;
}

function doPlay(state: GameState, playerId: string, cardIds: string[], emit: Emit, now: number) {
  const p = requireTurn(state, playerId);
  if (!Array.isArray(cardIds) || cardIds.length === 0) throw new GameError('Select at least one card');
  if (new Set(cardIds).size !== cardIds.length) throw new GameError('Duplicate cards');
  const zone = zoneOf(p);
  if (zone === 'faceDown') throw new GameError('Choose one of your face-down cards');
  if (zone === 'done') throw new GameError('You have no cards left');
  const source = zone === 'hand' ? p.hand : p.faceUp;
  const cards = cardIds.map((id) => source.find((c) => c.id === id));
  if (cards.some((c) => !c)) {
    throw new GameError(zone === 'hand' ? 'You can only play cards from your hand' : 'Play your face-up cards now');
  }
  const played = cards as Card[];
  const rank = played[0].rank;
  if (played.some((c) => c.rank !== rank)) throw new GameError('All cards played together must share a rank');
  if (!canPlayOn(rank, state.discard, state.settings)) throw new GameError('That card is too low for the pile');

  for (const c of played) source.splice(source.indexOf(c), 1);
  emit({ type: 'CARD_PLAYED', playerId, cards: played });
  resolvePlay(state, p, played, emit, now);
}

function doPlayFaceDown(state: GameState, playerId: string, index: number, emit: Emit, now: number) {
  const p = requireTurn(state, playerId);
  if (zoneOf(p) !== 'faceDown') throw new GameError('Play your hand and face-up cards first');
  if (!Number.isInteger(index) || index < 0 || index >= p.faceDown.length) throw new GameError('Pick a face-down card');
  const [card] = p.faceDown.splice(index, 1);
  emit({ type: 'FACE_DOWN_REVEALED', playerId, cards: [card] });
  if (canPlayOn(card.rank, state.discard, state.settings)) {
    emit({ type: 'CARD_PLAYED', playerId, cards: [card] });
    resolvePlay(state, p, [card], emit, now);
  } else {
    // Failed blind flip: the revealed card goes onto the pile, then the player takes the lot.
    state.discard.push(card);
    takePile(state, p, emit, 'failed face-down');
    advance(state, 1);
  }
}

function doPickup(state: GameState, playerId: string, emit: Emit) {
  requireTurn(state, playerId);
  const p = getPlayer(state, playerId)!;
  if (state.discard.length === 0) throw new GameError('The pile is empty — play any card');
  const zone = zoneOf(p);
  if (zone === 'faceDown') throw new GameError('Flip one of your face-down cards');
  if (!canPickup(state, playerId)) throw new GameError('You have a playable card');
  takePile(state, p, emit);
  advance(state, 1);
}

function takePile(state: GameState, p: PlayerState, emit: Emit, reason?: string) {
  const count = state.discard.length;
  p.hand.push(...state.discard);
  state.discard = [];
  emit({ type: 'PILE_PICKED_UP', playerId: p.id, count, reason });
}

/** Everything that happens after cards land on the pile. */
function resolvePlay(state: GameState, p: PlayerState, played: Card[], emit: Emit, now: number) {
  const s = state.settings;
  state.discard.push(...played);
  const ability = abilityOf(played[0].rank, s);
  let extraTurn = false;
  let skips = 0;

  if (ability === 'reverse') {
    state.direction = state.direction === 1 ? -1 : 1;
    emit({ type: 'SPECIAL_ABILITY_TRIGGERED', playerId: p.id, ability });
    emit({ type: 'DIRECTION_REVERSED', playerId: p.id });
  } else if (ability === 'skip') {
    skips = s.skipStacking ? played.length : 1;
    emit({ type: 'SPECIAL_ABILITY_TRIGGERED', playerId: p.id, ability, count: skips });
  } else if (ability === 'reset' || ability === 'invisible') {
    emit({ type: 'SPECIAL_ABILITY_TRIGGERED', playerId: p.id, ability });
  }

  const fourKind = s.fourOfAKindBurn && played[0].rank !== 'JOKER' && topRunLength(state.discard) >= 4;
  if (ability === 'burn' || fourKind) {
    if (ability === 'burn') emit({ type: 'SPECIAL_ABILITY_TRIGGERED', playerId: p.id, ability });
    state.burnedCount += state.discard.length;
    emit({ type: 'PILE_BURNED', playerId: p.id, count: state.discard.length, reason: fourKind && ability !== 'burn' ? 'four of a kind' : 'burn' });
    state.discard = [];
    extraTurn = true;
    skips = 0; // burning gives the turn back to you; a skip has nobody to skip
  }

  // Draw back up to the hand size while the deck lasts.
  let drawn = 0;
  while (p.hand.length < s.handSize && state.drawPile.length) {
    p.hand.push(state.drawPile.pop()!);
    drawn++;
  }
  if (drawn) emit({ type: 'CARD_DRAWN', playerId: p.id, count: drawn });

  if (zoneOf(p) === 'done') {
    state.finishOrder.push(p.id);
    p.place = state.finishOrder.length;
    emit({ type: 'PLAYER_FINISHED', playerId: p.id, place: p.place });
    const remaining = activePlayers(state);
    if (remaining.length <= 1) {
      const loser = remaining[0];
      if (loser) {
        state.shitheadId = loser.id;
        loser.place = state.players.length;
      }
      state.status = 'FINISHED';
      state.finishedAt = now;
      emit({ type: 'GAME_FINISHED', playerId: loser?.id });
      return;
    }
    extraTurn = false;
  }

  if (extraTurn) {
    state.turnNumber++;
    return;
  }
  if (skips > 0) {
    let idx = state.currentIdx;
    for (let i = 0; i < skips; i++) {
      idx = nextActiveIdx(state, idx);
      if (idx === state.currentIdx) break;
      emit({ type: 'PLAYER_SKIPPED', playerId: p.id, targetId: state.players[idx].id });
    }
  }
  advance(state, 1 + skips);
}

function nextActiveIdx(state: GameState, from: number): number {
  const n = state.players.length;
  let idx = from;
  for (let k = 0; k < n; k++) {
    idx = (((idx + state.direction) % n) + n) % n;
    if (state.players[idx].place === null) return idx;
  }
  return from;
}

/** Move the turn `steps` active players along in the current direction. */
export function advance(state: GameState, steps: number) {
  let idx = state.currentIdx;
  for (let i = 0; i < steps; i++) idx = nextActiveIdx(state, idx);
  state.currentIdx = idx;
  state.turnNumber++;
}

function pushLog(state: GameState, e: GameEvent) {
  e.seq = (state.eventSeq ?? 0) + 1;
  state.eventSeq = e.seq;
  state.log.push(e);
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
}

/** Server-side note in the log (e.g. auto-play on timeout). */
export function logEvent(state: GameState, e: GameEvent) {
  pushLog(state, e);
}
