import {
  ABILITIES,
  NORMAL_RANKS,
  RANKED_STAKES,
  TURN_TIMERS,
  WILD_ABILITIES,
  type Ability,
  type Card,
  type GameSettings,
  type NormalRank,
  type Rank,
  type StdSuit,
  SUITS,
} from './types.js';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 5;

export const RANK_VALUE: Record<NormalRank, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14,
};

export const DEFAULT_SPECIAL_RANKS: Record<Ability, NormalRank | null> = {
  reset: '2',
  invisible: '3',
  reverse: '7',
  skip: '8',
  burn: '10',
};

export function defaultSettings(overrides: Partial<GameSettings> = {}): GameSettings {
  return {
    mode: 'classic',
    stake: 0,
    maxPlayers: 5,
    visibility: 'private',
    specialsEnabled: true,
    specialRanks: { ...DEFAULT_SPECIAL_RANKS },
    fourOfAKindBurn: true,
    jokers: false,
    jokerAbility: 'reset',
    voluntaryPickup: false,
    skipStacking: false,
    turnTimer: 30,
    handSize: 3,
    allowSpectators: true,
    ...overrides,
  };
}

/** Ranked games always use the standard ruleset so stakes are fair; only stake/size/visibility vary. */
export function rankedSettings(base: Partial<GameSettings>): GameSettings {
  const stake = RANKED_STAKES.includes(base.stake as (typeof RANKED_STAKES)[number]) ? base.stake! : RANKED_STAKES[1];
  return defaultSettings({
    mode: 'ranked',
    stake,
    maxPlayers: clampInt(base.maxPlayers, MIN_PLAYERS, MAX_PLAYERS, 5),
    visibility: base.visibility === 'public' ? 'public' : 'private',
    allowSpectators: base.allowSpectators !== false,
    turnTimer: 30,
  });
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Validate untrusted settings from a client, filling gaps with defaults. */
export function sanitizeSettings(input: unknown): GameSettings {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<GameSettings>;
  if (raw.mode === 'ranked') return rankedSettings(raw);

  const d = defaultSettings();
  const specialRanks = { ...d.specialRanks };
  if (raw.specialRanks && typeof raw.specialRanks === 'object') {
    const used = new Set<string>();
    for (const ab of ABILITIES) {
      const r = (raw.specialRanks as Record<string, unknown>)[ab];
      if (r === null) specialRanks[ab] = null;
      else if (r === undefined) specialRanks[ab] = d.specialRanks[ab] && !used.has(d.specialRanks[ab]!) ? d.specialRanks[ab] : null;
      else if (typeof r === 'string' && (NORMAL_RANKS as readonly string[]).includes(r) && !used.has(r)) {
        specialRanks[ab] = r as NormalRank;
      } else specialRanks[ab] = null;
      if (specialRanks[ab]) used.add(specialRanks[ab]!);
    }
  }
  return {
    mode: 'classic',
    stake: 0,
    maxPlayers: clampInt(raw.maxPlayers, MIN_PLAYERS, MAX_PLAYERS, d.maxPlayers),
    visibility: raw.visibility === 'public' ? 'public' : 'private',
    specialsEnabled: raw.specialsEnabled !== false,
    specialRanks,
    fourOfAKindBurn: raw.fourOfAKindBurn !== false,
    jokers: raw.jokers === true,
    jokerAbility: (ABILITIES as readonly string[]).includes(raw.jokerAbility as string) ? raw.jokerAbility! : d.jokerAbility,
    voluntaryPickup: raw.voluntaryPickup === true,
    skipStacking: raw.skipStacking === true,
    turnTimer: (TURN_TIMERS as readonly number[]).includes(raw.turnTimer as number) ? raw.turnTimer! : d.turnTimer,
    handSize: raw.handSize === 4 ? 4 : 3,
    allowSpectators: raw.allowSpectators !== false,
  };
}

/** The ability a card carries under the given settings, if any. */
export function abilityOf(rank: Rank, s: GameSettings): Ability | null {
  if (rank === 'JOKER') return s.jokerAbility;
  if (!s.specialsEnabled) return null;
  for (const ab of ABILITIES) if (s.specialRanks[ab] === rank) return ab;
  return null;
}

export function isWild(rank: Rank, s: GameSettings): boolean {
  if (rank === 'JOKER') return true;
  const ab = abilityOf(rank, s);
  return ab !== null && WILD_ABILITIES.has(ab);
}

/**
 * The rank the next card must equal or beat, or null when anything may be played.
 * Invisible cards (and non-reset jokers) are transparent; a reset clears the requirement.
 */
export function requiredRank(discard: Card[], s: GameSettings): NormalRank | null {
  for (let i = discard.length - 1; i >= 0; i--) {
    const c = discard[i];
    const ab = abilityOf(c.rank, s);
    if (ab === 'reset') return null;
    if (c.rank === 'JOKER' || ab === 'invisible') continue;
    return c.rank as NormalRank;
  }
  return null;
}

export function canPlayOn(rank: Rank, discard: Card[], s: GameSettings): boolean {
  if (isWild(rank, s)) return true;
  const req = requiredRank(discard, s);
  if (req === null) return true;
  return RANK_VALUE[rank as NormalRank] >= RANK_VALUE[req];
}

/** Number of identical ranks stacked consecutively on top of the pile. */
export function topRunLength(discard: Card[]): number {
  if (discard.length === 0) return 0;
  const top = discard[discard.length - 1].rank;
  let n = 0;
  for (let i = discard.length - 1; i >= 0 && discard[i].rank === top; i--) n++;
  return n;
}

export function deckSize(s: GameSettings): number {
  return 52 + (s.jokers ? 2 : 0);
}

export function maxPlayersForSettings(s: GameSettings): number {
  return Math.min(MAX_PLAYERS, Math.floor(deckSize(s) / (6 + s.handSize)));
}

export function buildDeck(s: GameSettings, rng: () => number): Card[] {
  const ids = new Set<string>();
  const newId = () => {
    let id: string;
    do id = Math.floor(rng() * 36 ** 8).toString(36).padStart(8, '0');
    while (ids.has(id));
    ids.add(id);
    return id;
  };
  const deck: Card[] = [];
  for (const suit of SUITS as readonly StdSuit[]) for (const rank of NORMAL_RANKS) deck.push({ id: newId(), rank, suit });
  if (s.jokers) {
    deck.push({ id: newId(), rank: 'JOKER', suit: 'X' });
    deck.push({ id: newId(), rank: 'JOKER', suit: 'X' });
  }
  return shuffle(deck, rng);
}

export function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Sort key: normal cards by value, then specials, used for hand display and bots. */
export function cardSortValue(rank: Rank, s: GameSettings): number {
  if (rank === 'JOKER') return 100;
  const ab = abilityOf(rank, s);
  const base = RANK_VALUE[rank];
  if (!ab) return base;
  const order: Record<Ability, number> = { skip: 0, reverse: 0, invisible: 30, reset: 40, burn: 50 };
  return order[ab] === 0 ? base : order[ab] + base / 100;
}

export function sortCards(cards: Card[], s: GameSettings): Card[] {
  return [...cards].sort((a, b) => cardSortValue(a.rank, s) - cardSortValue(b.rank, s) || a.suit.localeCompare(b.suit));
}
