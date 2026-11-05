import { randomInt } from 'node:crypto';
import {
  applyAction,
  buildGameView,
  chooseBotAction,
  createGame,
  defaultSettings,
  getPlayer,
  logEvent,
  maxPlayersForSettings,
  MIN_PLAYERS,
  rankedSettings,
  sanitizeSettings,
  type ClientState,
  type GameAction,
  type GameMode,
  type GameResult,
  type GameSettings,
  type GameState,
  type MemberView,
  type PublicRoomSummary,
  type RoomStatus,
  type RoomView,
} from '@shead/shared';
import type { Store } from './store.js';

export interface Timings {
  botDelayMs: number;
  disconnectGraceMs: number;
  setupTimeoutMs: number;
  quickPlayCountdownMs: number;
  lobbyDisconnectMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  botDelayMs: 900,
  disconnectGraceMs: 30_000,
  setupTimeoutMs: 60_000,
  quickPlayCountdownMs: 8_000,
  lobbyDisconnectMs: 45_000,
};

export interface Transport {
  /** Deliver an event to every socket of a user. */
  toUser(userId: string, event: string, payload: unknown): void;
  isOnline(userId: string): boolean;
}

interface Member {
  userId: string;
  name: string;
  isBot: boolean;
  ready: boolean;
  connected: boolean;
  /** Auto-played by the server. */
  away: boolean;
  /** Left mid-game (seat continues on autopilot). */
  left: boolean;
  disconnectedAt: number | null;
}

interface Room {
  code: string;
  name: string;
  hostId: string;
  settings: GameSettings;
  quickPlay: boolean;
  status: RoomStatus;
  members: Member[];
  spectators: Map<string, string>;
  game: GameState | null;
  deadline: number | null;
  autoStartAt: number | null;
  pot: number;
  escrow: Map<string, number>;
  paidOut: boolean;
  lastResult: GameResult | null;
  timer: NodeJS.Timeout | null;
  lobbyTimer: NodeJS.Timeout | null;
  turnKey: string;
  turnStartedAt: number;
  setupStartedAt: number;
}

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const BOT_NAMES = ['Ace Bot', 'Lucky Bot', 'Burnie', 'Skippy', 'Deuce', 'Queenie', 'Jack Bot', 'Sir Shuffle'];
const rng = () => randomInt(0, 2 ** 32) / 2 ** 32;

export class RoomManager {
  private rooms = new Map<string, Room>();
  private userRoom = new Map<string, string>();

  constructor(
    private store: Store,
    private transport: Transport,
    private t: Timings = DEFAULT_TIMINGS,
  ) {}

  // ───────────────────────── lookups ─────────────────────────

  roomOf(userId: string): Room | null {
    const code = this.userRoom.get(userId);
    return code ? (this.rooms.get(code) ?? null) : null;
  }

  listPublic(): PublicRoomSummary[] {
    return [...this.rooms.values()]
      .filter((r) => r.settings.visibility === 'public' && r.status === 'WAITING' && this.seated(r).length < r.settings.maxPlayers)
      .map((r) => ({
        code: r.code,
        name: r.name,
        mode: r.settings.mode,
        stake: r.settings.stake,
        players: this.seated(r).length,
        maxPlayers: r.settings.maxPlayers,
        quickPlay: r.quickPlay,
      }));
  }

  roomCount() {
    return this.rooms.size;
  }

  private seated(r: Room) {
    return r.members.filter((m) => !m.left);
  }

  private member(r: Room, userId: string) {
    return r.members.find((m) => m.userId === userId);
  }

  private newCode(): string {
    let code: string;
    do code = Array.from({ length: 5 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    while (this.rooms.has(code));
    return code;
  }

  // ───────────────────── connection lifecycle ─────────────────────

  onConnect(userId: string) {
    const room = this.roomOf(userId);
    if (!room) {
      this.transport.toUser(userId, 'state', { room: null, game: null } satisfies ClientState);
      return;
    }
    const m = this.member(room, userId);
    if (m) {
      m.connected = true;
      m.disconnectedAt = null;
      if (!m.left) m.away = false; // back from autopilot
    }
    this.afterChange(room);
  }

  onDisconnect(userId: string) {
    if (this.transport.isOnline(userId)) return; // another tab still open
    const room = this.roomOf(userId);
    if (!room) return;
    const m = this.member(room, userId);
    if (m) {
      m.connected = false;
      m.disconnectedAt = Date.now();
    } else {
      room.spectators.delete(userId);
      this.userRoom.delete(userId);
    }
    this.afterChange(room);
  }

  // ───────────────────────── room actions ─────────────────────────

  create(userId: string, rawSettings: unknown, opts: { quickPlay?: boolean } = {}): Result<{ code: string }> {
    const user = this.store.get(userId);
    if (!user) return { ok: false, error: 'Unknown user' };
    const settings = sanitizeSettings(rawSettings);
    if (settings.mode === 'ranked' && user.tokens < settings.stake) return { ok: false, error: `You need ${settings.stake} tokens for this stake` };
    this.leave(userId);
    const room: Room = {
      code: this.newCode(),
      name: opts.quickPlay ? `${settings.mode === 'ranked' ? 'Ranked' : 'Quick'} table` : `${user.name}'s table`,
      hostId: userId,
      settings,
      quickPlay: !!opts.quickPlay,
      status: 'WAITING',
      members: [],
      spectators: new Map(),
      game: null,
      deadline: null,
      autoStartAt: null,
      pot: 0,
      escrow: new Map(),
      paidOut: false,
      lastResult: null,
      timer: null,
      lobbyTimer: null,
      turnKey: '',
      turnStartedAt: 0,
      setupStartedAt: 0,
    };
    this.rooms.set(room.code, room);
    this.addMember(room, userId, user.name);
    this.afterChange(room);
    return { ok: true, code: room.code };
  }

  join(userId: string, rawCode: unknown): Result<{ code: string; spectator: boolean }> {
    const user = this.store.get(userId);
    if (!user) return { ok: false, error: 'Unknown user' };
    const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
    const room = this.rooms.get(code);
    if (!room) return { ok: false, error: 'No table with that code' };
    if (this.member(room, userId) && !this.member(room, userId)!.left) {
      this.userRoom.set(userId, code);
      this.onConnect(userId);
      return { ok: true, code, spectator: false };
    }
    if (room.status !== 'WAITING') {
      if (!room.settings.allowSpectators) return { ok: false, error: 'That game has already started' };
      this.leave(userId);
      room.spectators.set(userId, user.name);
      this.userRoom.set(userId, code);
      this.afterChange(room);
      return { ok: true, code, spectator: true };
    }
    if (this.seated(room).length >= room.settings.maxPlayers) return { ok: false, error: 'That table is full' };
    if (room.settings.mode === 'ranked' && user.tokens < room.settings.stake) {
      return { ok: false, error: `You need ${room.settings.stake} tokens to join this ranked table` };
    }
    this.leave(userId);
    this.addMember(room, userId, user.name);
    this.afterChange(room);
    return { ok: true, code, spectator: false };
  }

  quickPlay(userId: string, mode: GameMode, stake: unknown): Result<{ code: string }> {
    const user = this.store.get(userId);
    if (!user) return { ok: false, error: 'Unknown user' };
    const settings = mode === 'ranked' ? rankedSettings({ stake: Number(stake), visibility: 'public' }) : defaultSettings({ visibility: 'public' });
    if (mode === 'ranked' && user.tokens < settings.stake) return { ok: false, error: `You need ${settings.stake} tokens for this stake` };
    const current = this.roomOf(userId);
    const open = [...this.rooms.values()].find(
      (r) =>
        r.quickPlay &&
        r !== current &&
        r.status === 'WAITING' &&
        r.settings.mode === settings.mode &&
        r.settings.stake === settings.stake &&
        this.seated(r).length < r.settings.maxPlayers,
    );
    if (open) return this.join(userId, open.code);
    return this.create(userId, settings, { quickPlay: true });
  }

  private addMember(room: Room, userId: string, name: string) {
    room.members.push({
      userId,
      name,
      isBot: false,
      ready: room.quickPlay,
      connected: this.transport.isOnline(userId),
      away: false,
      left: false,
      disconnectedAt: this.transport.isOnline(userId) ? null : Date.now(),
    });
    this.userRoom.set(userId, room.code);
  }

  leave(userId: string): Result {
    const room = this.roomOf(userId);
    if (!room) return { ok: true };
    this.userRoom.delete(userId);
    this.transport.toUser(userId, 'state', { room: null, game: null } satisfies ClientState);
    if (room.spectators.delete(userId)) {
      this.afterChange(room);
      return { ok: true };
    }
    const m = this.member(room, userId);
    if (!m) return { ok: true };
    if (room.status === 'PLAYING') {
      m.left = true;
      m.away = true;
      m.connected = false;
    } else {
      room.members = room.members.filter((x) => x !== m);
    }
    this.fixHost(room);
    if (!this.hasHumans(room)) {
      this.destroy(room);
      return { ok: true };
    }
    this.afterChange(room);
    return { ok: true };
  }

  setReady(userId: string, ready: boolean): Result {
    const room = this.roomOf(userId);
    const m = room && this.member(room, userId);
    if (!room || !m) return { ok: false, error: 'You are not at a table' };
    if (room.status !== 'WAITING') return { ok: false, error: 'The game has already started' };
    if (ready && room.settings.mode === 'ranked' && (this.store.get(userId)?.tokens ?? 0) < room.settings.stake) {
      return { ok: false, error: `You need ${room.settings.stake} tokens to play` };
    }
    m.ready = !!ready;
    this.afterChange(room);
    return { ok: true };
  }

  updateSettings(userId: string, raw: unknown): Result {
    const room = this.roomOf(userId);
    if (!room) return { ok: false, error: 'You are not at a table' };
    if (room.hostId !== userId) return { ok: false, error: 'Only the host can change settings' };
    if (room.status !== 'WAITING') return { ok: false, error: 'Settings are locked once the game starts' };
    if (room.quickPlay) return { ok: false, error: 'Quick-play tables use the standard rules' };
    const settings = sanitizeSettings(raw);
    if (settings.mode === 'ranked' && room.members.some((m) => m.isBot)) return { ok: false, error: 'Remove the bots before switching to ranked' };
    if (this.seated(room).length > Math.min(settings.maxPlayers, maxPlayersForSettings(settings))) {
      return { ok: false, error: 'More players are seated than that limit' };
    }
    room.settings = settings;
    for (const m of room.members) if (!m.isBot && m.userId !== room.hostId) m.ready = false;
    this.afterChange(room);
    return { ok: true };
  }

  addBot(userId: string): Result {
    const room = this.roomOf(userId);
    if (!room) return { ok: false, error: 'You are not at a table' };
    if (room.hostId !== userId) return { ok: false, error: 'Only the host can add bots' };
    if (room.status !== 'WAITING') return { ok: false, error: 'The game has already started' };
    if (room.settings.mode === 'ranked') return { ok: false, error: 'Bots cannot play ranked games' };
    if (this.seated(room).length >= room.settings.maxPlayers) return { ok: false, error: 'The table is full' };
    const used = new Set(room.members.map((m) => m.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) ?? `Bot ${room.members.length + 1}`;
    room.members.push({
      userId: `bot:${randomInt(1e9).toString(36)}`,
      name,
      isBot: true,
      ready: true,
      connected: true,
      away: false,
      left: false,
      disconnectedAt: null,
    });
    this.afterChange(room);
    return { ok: true };
  }

  kick(userId: string, targetId: unknown): Result {
    const room = this.roomOf(userId);
    if (!room) return { ok: false, error: 'You are not at a table' };
    if (room.hostId !== userId) return { ok: false, error: 'Only the host can remove players' };
    if (room.quickPlay) return { ok: false, error: 'Matchmade tables have no kicking' };
    const m = typeof targetId === 'string' ? this.member(room, targetId) : undefined;
    if (!m || m.userId === userId) return { ok: false, error: 'Unknown player' };
    if (room.status === 'PLAYING') {
      // Mid-game the seat stays and is auto-played (the GDD "automated player").
      m.away = true;
      if (!m.isBot) {
        m.left = true;
        m.connected = false;
        this.userRoom.delete(m.userId);
        this.transport.toUser(m.userId, 'kicked', { reason: 'The host replaced you with a bot' });
        this.transport.toUser(m.userId, 'state', { room: null, game: null });
      }
    } else {
      room.members = room.members.filter((x) => x !== m);
      if (!m.isBot) {
        this.userRoom.delete(m.userId);
        this.transport.toUser(m.userId, 'kicked', { reason: 'The host removed you from the table' });
        this.transport.toUser(m.userId, 'state', { room: null, game: null });
      }
    }
    this.afterChange(room);
    return { ok: true };
  }

  start(userId: string): Result {
    const room = this.roomOf(userId);
    if (!room) return { ok: false, error: 'You are not at a table' };
    if (room.hostId !== userId && !room.quickPlay) return { ok: false, error: 'Only the host can start the game' };
    return this.startRoom(room);
  }

  private startRoom(room: Room): Result {
    if (room.status !== 'WAITING') return { ok: false, error: 'The game has already started' };
    // Drop anyone who disconnected in the lobby.
    room.members = room.members.filter((m) => m.isBot || m.connected);
    this.fixHost(room);
    const seated = this.seated(room);
    if (seated.length < MIN_PLAYERS) return { ok: false, error: `At least ${MIN_PLAYERS} players are needed` };
    if (seated.some((m) => !m.ready)) return { ok: false, error: 'Everyone must be ready' };
    const s = room.settings;
    if (s.mode === 'ranked') {
      const broke = seated.find((m) => !m.isBot && (this.store.get(m.userId)?.tokens ?? 0) < s.stake);
      if (broke) return { ok: false, error: `${broke.name} doesn't have ${s.stake} tokens` };
      room.escrow.clear();
      for (const m of seated) {
        this.store.adjustTokens(m.userId, -s.stake);
        room.escrow.set(m.userId, s.stake);
      }
      room.pot = s.stake * seated.length;
      for (const m of seated) this.pushProfile(m.userId);
    } else room.pot = 0;

    room.game = createGame(seated.map((m) => ({ id: m.userId, name: m.name })), s, rng);
    room.status = 'PLAYING';
    room.paidOut = false;
    room.autoStartAt = null;
    room.setupStartedAt = Date.now();
    room.turnKey = '';
    this.afterChange(room);
    return { ok: true };
  }

  /** Back to the lobby after a game (host, or anyone at a quick-play table). */
  reset(userId: string): Result {
    const room = this.roomOf(userId);
    if (!room) return { ok: false, error: 'You are not at a table' };
    if (room.status !== 'FINISHED') return { ok: false, error: 'The game is still running' };
    if (room.hostId !== userId && !room.quickPlay) return { ok: false, error: 'Only the host can do that' };
    room.status = 'WAITING';
    room.game = null;
    room.pot = 0;
    room.escrow.clear();
    room.members = room.members.filter((m) => !m.left);
    for (const m of room.members) {
      m.ready = m.isBot || room.quickPlay;
      m.away = false;
    }
    // Spectators get first dibs on free seats.
    for (const [id, name] of room.spectators) {
      if (this.seated(room).length >= room.settings.maxPlayers) break;
      room.spectators.delete(id);
      this.addMember(room, id, name);
    }
    this.afterChange(room);
    return { ok: true };
  }

  action(userId: string, version: unknown, action: GameAction): Result {
    const room = this.roomOf(userId);
    const g = room?.game;
    const m = room && this.member(room, userId);
    if (!room || !g || !m || m.left) return { ok: false, error: 'You are not in a game' };
    if (typeof version === 'number' && version !== g.version) return { ok: false, error: 'Out of date — try again' };
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') return { ok: false, error: 'Bad action' };
    m.away = false;
    const res = applyAction(g, userId, action);
    if (!res.ok) return res;
    this.afterChange(room);
    return { ok: true };
  }

  // ─────────────────────── internals ───────────────────────

  private hasHumans(room: Room) {
    return room.members.some((m) => !m.isBot && !m.left);
  }

  private fixHost(room: Room) {
    const host = this.member(room, room.hostId);
    if (host && !host.left && !host.isBot) return;
    const next = room.members.find((m) => !m.isBot && !m.left && m.connected) ?? room.members.find((m) => !m.isBot && !m.left);
    if (next) room.hostId = next.userId;
  }

  private destroy(room: Room) {
    if (room.timer) clearTimeout(room.timer);
    if (room.lobbyTimer) clearTimeout(room.lobbyTimer);
    room.timer = room.lobbyTimer = null;
    if (room.status === 'PLAYING' && room.settings.mode === 'ranked' && !room.paidOut) {
      for (const [uid, amount] of room.escrow) {
        this.store.adjustTokens(uid, amount);
        this.pushProfile(uid);
      }
      room.escrow.clear();
    }
    for (const m of room.members) {
      if (this.userRoom.get(m.userId) === room.code) {
        this.userRoom.delete(m.userId);
        this.transport.toUser(m.userId, 'state', { room: null, game: null });
      }
    }
    for (const id of room.spectators.keys()) {
      this.userRoom.delete(id);
      this.transport.toUser(id, 'state', { room: null, game: null });
    }
    this.rooms.delete(room.code);
  }

  private pushProfile(userId: string) {
    const u = this.store.get(userId);
    if (u) this.transport.toUser(userId, 'profile', this.store.profile(u));
  }

  /** Called after every mutation: settle money, detect the end, broadcast, re-arm timers. */
  private afterChange(room: Room) {
    if (!this.rooms.has(room.code)) return;
    const g = room.game;
    if (g && room.status === 'PLAYING') {
      // Ranked: the first player out takes the whole pot immediately.
      if (room.settings.mode === 'ranked' && !room.paidOut && g.finishOrder.length > 0) {
        const winner = g.finishOrder[0];
        room.paidOut = true;
        this.store.adjustTokens(winner, room.pot);
        const stake = room.escrow.get(winner) ?? 0;
        this.store.updateStats(winner, (s) => {
          s.rankedWins++;
          s.tokensWon += room.pot - stake;
        });
        this.pushProfile(winner);
      }
      if (g.status === 'FINISHED') this.finish(room);
    }
    this.lobbyTick(room);
    if (!this.rooms.has(room.code)) return;
    this.schedule(room);
    this.broadcast(room);
  }

  private finish(room: Room) {
    const g = room.game!;
    room.status = 'FINISHED';
    const ranked = room.settings.mode === 'ranked';
    for (const p of g.players) {
      const m = this.member(room, p.id);
      if (!m || m.isBot) continue;
      this.store.updateStats(p.id, (s) => {
        s.games++;
        if (p.place === 1) s.wins++;
        if (g.shitheadId === p.id) s.shitheads++;
        if (ranked) s.rankedGames++;
      });
      this.pushProfile(p.id);
    }
    room.lastResult = {
      rankings: [...g.players]
        .sort((a, b) => (a.place ?? 99) - (b.place ?? 99))
        .map((p) => ({ userId: p.id, name: p.name, place: p.place ?? g.players.length, cardsLeft: p.hand.length + p.faceUp.length + p.faceDown.length })),
      shitheadId: g.shitheadId,
      durationMs: (g.finishedAt ?? Date.now()) - g.startedAt,
      mode: room.settings.mode,
      payout: ranked ? { pot: room.pot, winnerId: g.finishOrder[0] ?? null, refunded: false } : null,
    };
    room.escrow.clear();
  }

  /** Lobby housekeeping: drop long-disconnected members, run quick-play countdowns. */
  private lobbyTick(room: Room) {
    if (room.lobbyTimer) clearTimeout(room.lobbyTimer);
    room.lobbyTimer = null;
    if (room.status === 'PLAYING') {
      room.autoStartAt = null;
      if (!room.members.some((m) => !m.isBot && !m.left && (m.connected || m.disconnectedAt === null || Date.now() - m.disconnectedAt < 10 * 60_000))) {
        // Everyone vanished for 10 minutes — abandon (refunds ranked stakes if nobody won yet).
        this.destroy(room);
      }
      return;
    }
    const now = Date.now();
    let next = Infinity;
    // Remove people who dropped out of the lobby / results screen and never came back.
    for (const m of [...room.members]) {
      if (m.isBot || m.connected || m.disconnectedAt === null) continue;
      const due = m.disconnectedAt + this.t.lobbyDisconnectMs;
      if (due <= now) {
        room.members = room.members.filter((x) => x !== m);
        this.userRoom.delete(m.userId);
      } else next = Math.min(next, due);
    }
    this.fixHost(room);
    if (!this.hasHumans(room)) {
      this.destroy(room);
      return;
    }
    if (room.status === 'WAITING' && room.quickPlay) {
      const seated = this.seated(room).filter((m) => m.connected || m.isBot);
      const allReady = seated.length >= MIN_PLAYERS && seated.every((m) => m.ready);
      if (!allReady) room.autoStartAt = null;
      else {
        const full = seated.length >= room.settings.maxPlayers;
        const target = full ? now + 1500 : (room.autoStartAt ?? now + this.t.quickPlayCountdownMs);
        room.autoStartAt = Math.min(target, room.autoStartAt ?? Infinity);
        next = Math.min(next, room.autoStartAt);
      }
    }
    if (next !== Infinity) {
      room.lobbyTimer = setTimeout(() => {
        room.lobbyTimer = null;
        if (!this.rooms.has(room.code)) return;
        if (room.status === 'WAITING' && room.autoStartAt && Date.now() >= room.autoStartAt - 5) {
          room.autoStartAt = null;
          const res = this.startRoom(room);
          if (res.ok) return;
        }
        this.afterChange(room);
      }, Math.max(0, next - now));
    }
  }

  /** Arm the single game timer: bot moves, auto-play for the disconnected, and turn time-outs. */
  private schedule(room: Room) {
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
    room.deadline = null;
    const g = room.game;
    if (!g || room.status !== 'PLAYING') return;
    const now = Date.now();
    const arm = (at: number, fn: () => void) => {
      room.timer = setTimeout(() => {
        room.timer = null;
        if (this.rooms.has(room.code) && room.game === g) fn();
      }, Math.max(0, at - now));
    };

    if (g.status === 'SETUP') {
      const pending = g.players.filter((p) => !p.setupReady).map((p) => this.member(room, p.id)!);
      const auto = pending.filter((m) => m.isBot || m.away);
      if (auto.length) {
        arm(now + this.t.botDelayMs, () => {
          for (const m of auto) this.autoPlay(room, m.userId);
          this.afterChange(room);
        });
        return;
      }
      room.deadline = room.setupStartedAt + this.t.setupTimeoutMs;
      let at = room.deadline;
      for (const m of pending) if (!m.connected && m.disconnectedAt) at = Math.min(at, m.disconnectedAt + this.t.disconnectGraceMs);
      arm(at, () => {
        const t = Date.now();
        for (const m of pending) {
          const graceOver = !m.connected && m.disconnectedAt !== null && t >= m.disconnectedAt + this.t.disconnectGraceMs - 5;
          if (graceOver) m.away = true;
          if (graceOver || t >= room.deadline! - 5) this.autoPlay(room, m.userId);
        }
        this.afterChange(room);
      });
      return;
    }

    if (g.status !== 'PLAYING') return;
    const cur = g.players[g.currentIdx];
    const m = this.member(room, cur.id)!;
    const key = `${g.turnNumber}:${cur.id}`;
    if (key !== room.turnKey) {
      room.turnKey = key;
      room.turnStartedAt = now;
    }
    if (m.isBot || m.away) {
      arm(now + this.t.botDelayMs, () => {
        this.autoPlay(room, m.userId, m.isBot ? undefined : 'is away — auto-played');
        this.afterChange(room);
      });
      return;
    }
    if (!m.connected) {
      // Pause for the disconnected player, then hand their seat to the autopilot.
      room.deadline = Math.max(now, (m.disconnectedAt ?? now) + this.t.disconnectGraceMs);
      arm(room.deadline, () => {
        m.away = true;
        this.autoPlay(room, m.userId, 'disconnected — auto-played');
        this.afterChange(room);
      });
      return;
    }
    if (g.settings.turnTimer > 0) {
      room.deadline = room.turnStartedAt + g.settings.turnTimer * 1000;
      arm(room.deadline, () => {
        this.autoPlay(room, m.userId, 'ran out of time — auto-played');
        this.afterChange(room);
      });
    }
  }

  private autoPlay(room: Room, userId: string, reason?: string) {
    const g = room.game;
    if (!g) return;
    if (g.status === 'SETUP') {
      // Bots arrange their cards; humans who time out just keep their arrangement.
      const p = getPlayer(g, userId);
      const m = this.member(room, userId);
      for (let i = 0; i < 10 && p && !p.setupReady; i++) {
        const a = m?.isBot || m?.away ? chooseBotAction(g, userId, rng) : ({ type: 'setupReady', ready: true } as const);
        if (!a || !applyAction(g, userId, a).ok) break;
      }
      return;
    }
    const a = chooseBotAction(g, userId, rng);
    if (!a) return;
    const res = applyAction(g, userId, a);
    if (res.ok && reason) logEvent(g, { type: 'AUTO_PLAYED', playerId: userId, reason });
  }

  private roomView(room: Room, viewerId: string): RoomView {
    const members: MemberView[] = room.members
      .filter((m) => room.status === 'PLAYING' || !m.left)
      .map((m) => ({
        userId: m.userId,
        name: m.name,
        isBot: m.isBot,
        isHost: m.userId === room.hostId,
        ready: m.ready,
        connected: m.connected,
        away: m.away,
        tokens: room.settings.mode === 'ranked' && !m.isBot ? this.store.get(m.userId)?.tokens : undefined,
      }));
    return {
      code: room.code,
      name: room.name,
      status: room.status,
      hostId: room.hostId,
      quickPlay: room.quickPlay,
      settings: room.settings,
      members,
      spectators: [...room.spectators].map(([userId, name]) => ({ userId, name })),
      youAreSpectator: room.spectators.has(viewerId),
      autoStartAt: room.autoStartAt,
      deadline: room.deadline,
      pot: room.pot,
      lastResult: room.lastResult,
    };
  }

  private broadcast(room: Room) {
    const viewers = [
      ...room.members.filter((m) => !m.isBot && !m.left).map((m) => m.userId),
      ...room.spectators.keys(),
    ];
    for (const id of viewers) {
      const isPlayer = !!room.game && !!getPlayer(room.game, id);
      const state: ClientState = {
        room: this.roomView(room, id),
        game: room.game ? buildGameView(room.game, isPlayer ? id : null) : null,
      };
      this.transport.toUser(id, 'state', state);
    }
  }

  /** For graceful shutdown: refund any running ranked games. */
  shutdown() {
    for (const room of [...this.rooms.values()]) this.destroy(room);
  }
}

