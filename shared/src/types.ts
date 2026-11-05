// ───────────────────────────── Cards ─────────────────────────────

export const SUITS = ['H', 'D', 'C', 'S'] as const;
export type StdSuit = (typeof SUITS)[number];
export type Suit = StdSuit | 'X'; // 'X' = joker

export const NORMAL_RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;
export type NormalRank = (typeof NORMAL_RANKS)[number];
export type Rank = NormalRank | 'JOKER';

export interface Card {
  /** Random per-game id. Never encodes rank/suit so ids leak nothing. */
  id: string;
  rank: Rank;
  suit: Suit;
}

// ─────────────────────────── Abilities ───────────────────────────

export const ABILITIES = ['reset', 'invisible', 'reverse', 'skip', 'burn'] as const;
export type Ability = (typeof ABILITIES)[number];

/** Wild abilities can be played on top of anything. */
export const WILD_ABILITIES: ReadonlySet<Ability> = new Set(['reset', 'invisible', 'burn']);

export const ABILITY_INFO: Record<Ability, { label: string; icon: string; description: string }> = {
  reset: { label: 'Reset', icon: '↺', description: 'Play on anything. The next player may play any card.' },
  invisible: { label: 'Invisible', icon: '👻', description: 'Play on anything. The pile keeps the rank of the card underneath.' },
  reverse: { label: 'Reverse', icon: '⇄', description: 'Reverses the direction of play (clockwise ⇄ anti-clockwise).' },
  skip: { label: 'Skip', icon: '⏭', description: 'The next player loses their turn.' },
  burn: { label: 'Burn', icon: '🔥', description: 'Play on anything. Burns the whole pile and you go again.' },
};

// ─────────────────────────── Settings ────────────────────────────

export type GameMode = 'classic' | 'ranked';
export type Visibility = 'private' | 'public';
export const TURN_TIMERS = [0, 15, 30, 45, 60] as const;
export type TurnTimer = (typeof TURN_TIMERS)[number];
export const RANKED_STAKES = [10, 50, 100, 250, 500] as const;

export interface GameSettings {
  mode: GameMode;
  /** Ranked only: tokens each player bets. The first player to finish takes the pot. */
  stake: number;
  maxPlayers: number; // 2–5
  visibility: Visibility;
  specialsEnabled: boolean;
  /** Which rank carries which ability. null = ability off. Each rank holds at most one ability. */
  specialRanks: Record<Ability, NormalRank | null>;
  fourOfAKindBurn: boolean;
  jokers: boolean;
  /** Jokers are always wild; this is the ability they carry. */
  jokerAbility: Ability;
  voluntaryPickup: boolean;
  /** Playing N skip cards skips N players (otherwise always 1). */
  skipStacking: boolean;
  /** Seconds per turn, 0 = no timer. */
  turnTimer: TurnTimer;
  handSize: number; // 3 (default) or 4
  allowSpectators: boolean;
}

// ─────────────────────────── Game state ──────────────────────────

/** Room-level status (WAITING lives in the room, the rest in the game). */
export type GameStatus = 'SETUP' | 'PLAYING' | 'FINISHED';

/** Which set of cards a player currently plays from. */
export type Zone = 'hand' | 'faceUp' | 'faceDown' | 'done';

/** GDD phase names, derived from the active player's zone. */
export type PhaseName = 'WAITING' | 'SETUP' | 'PLAYING_HAND' | 'PLAYING_FACE_UP' | 'PLAYING_FACE_DOWN' | 'FINISHED';

export interface PlayerState {
  id: string;
  name: string;
  hand: Card[];
  faceUp: Card[];
  faceDown: Card[];
  setupReady: boolean;
  /** 1-based finishing place, null while still playing. */
  place: number | null;
}

export type GameEventType =
  | 'GAME_STARTED'
  | 'CARDS_DEALT'
  | 'CARDS_EXCHANGED'
  | 'TURN_STARTED'
  | 'CARD_PLAYED'
  | 'FACE_DOWN_REVEALED'
  | 'CARD_DRAWN'
  | 'PILE_PICKED_UP'
  | 'SPECIAL_ABILITY_TRIGGERED'
  | 'PILE_BURNED'
  | 'PLAYER_SKIPPED'
  | 'DIRECTION_REVERSED'
  | 'PLAYER_FINISHED'
  | 'GAME_FINISHED'
  | 'AUTO_PLAYED';

export interface GameEvent {
  type: GameEventType;
  /** Monotonic sequence number within a game, so clients can spot new events. */
  seq?: number;
  playerId?: string;
  /** Public cards involved (played / revealed). */
  cards?: Card[];
  count?: number;
  ability?: Ability;
  place?: number;
  reason?: string;
  /** Who was skipped. */
  targetId?: string;
}

export interface GameState {
  status: GameStatus;
  settings: GameSettings;
  players: PlayerState[]; // seat order, clockwise
  drawPile: Card[];
  discard: Card[]; // last element = top
  burnedCount: number;
  currentIdx: number;
  /** 1 = clockwise, -1 = anti-clockwise. */
  direction: 1 | -1;
  /** Player ids in finishing order. */
  finishOrder: string[];
  shitheadId: string | null;
  /** Incremented on every accepted action; clients echo it to prevent double-submits. */
  version: number;
  turnNumber: number;
  log: GameEvent[];
  eventSeq?: number;
  startedAt: number;
  finishedAt: number | null;
}

// ─────────────────────────── Actions ─────────────────────────────

export type GameAction =
  | { type: 'swap'; handCardId: string; faceUpCardId: string }
  | { type: 'setupReady'; ready: boolean }
  | { type: 'play'; cardIds: string[] }
  | { type: 'playFaceDown'; index: number }
  | { type: 'pickup' };

export type ActionResult = { ok: true; events: GameEvent[] } | { ok: false; error: string };

// ───────────────────── Client-facing views ───────────────────────

export interface PublicPlayerView {
  id: string;
  name: string;
  handCount: number;
  faceUp: Card[];
  faceDownCount: number;
  setupReady: boolean;
  place: number | null;
  zone: Zone;
}

export interface MyView {
  hand: Card[];
  zone: Zone;
  /** Card ids (hand or face-up, depending on zone) that may legally be played right now. */
  playableIds: string[];
  canPickup: boolean;
  /** True when the player has no legal play and must pick up. */
  mustPickup: boolean;
  isMyTurn: boolean;
}

export interface GameView {
  status: GameStatus;
  phase: PhaseName;
  version: number;
  turnNumber: number;
  direction: 1 | -1;
  currentPlayerId: string | null;
  drawCount: number;
  discard: Card[];
  burnedCount: number;
  /** Rank the next card must meet or beat; null = anything goes. */
  requiredRank: NormalRank | null;
  players: PublicPlayerView[];
  me: MyView | null; // null for spectators
  log: GameEvent[];
  finishOrder: string[];
  shitheadId: string | null;
  startedAt: number;
  finishedAt: number | null;
  settings: GameSettings;
}

// ───────────────────────── Room views ────────────────────────────

export type RoomStatus = 'WAITING' | 'PLAYING' | 'FINISHED';

export interface MemberView {
  userId: string;
  name: string;
  isBot: boolean;
  isHost: boolean;
  ready: boolean;
  connected: boolean;
  /** Being auto-played by the server (left or timed out while disconnected). */
  away: boolean;
  tokens?: number;
}

export interface RankedPayout {
  pot: number;
  winnerId: string | null;
  refunded: boolean;
}

export interface GameResult {
  rankings: { userId: string; name: string; place: number; cardsLeft: number }[];
  shitheadId: string | null;
  durationMs: number;
  mode: GameMode;
  payout: RankedPayout | null;
}

export interface RoomView {
  code: string;
  name: string;
  status: RoomStatus;
  hostId: string;
  quickPlay: boolean;
  settings: GameSettings;
  members: MemberView[];
  spectators: { userId: string; name: string }[];
  youAreSpectator: boolean;
  /** Epoch ms when a quick-play countdown will auto-start the game. */
  autoStartAt: number | null;
  /** Epoch ms deadline for the current turn / setup phase, if any. */
  deadline: number | null;
  pot: number;
  lastResult: GameResult | null;
}

export interface ClientState {
  room: RoomView | null;
  game: GameView | null;
}

export interface PublicRoomSummary {
  code: string;
  name: string;
  mode: GameMode;
  stake: number;
  players: number;
  maxPlayers: number;
  quickPlay: boolean;
}

export interface UserProfile {
  id: string;
  name: string;
  tokens: number;
  stats: { games: number; wins: number; shitheads: number; rankedGames: number; rankedWins: number; tokensWon: number };
  nextDailyAt: number;
}
