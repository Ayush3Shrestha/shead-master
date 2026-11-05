import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UserProfile } from '@shead/shared';

export const STARTING_TOKENS = 1000;
export const DAILY_BONUS = 200;
export const DAILY_INTERVAL_MS = 20 * 60 * 60 * 1000; // claimable every 20h

export interface UserRecord {
  id: string;
  name: string;
  tokenHash: string;
  tokens: number;
  stats: UserProfile['stats'];
  createdAt: number;
  lastDailyAt: number;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return name.length >= 1 ? name : null;
}

/**
 * Tiny persistent user store (guest accounts + token wallets).
 * Writes are debounced to a JSON file; pass no path for an in-memory store (tests).
 * Swap for Postgres/Mongo when you outgrow a single server.
 */
export class Store {
  private users = new Map<string, UserRecord>();
  private byHash = new Map<string, string>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private file: string | null) {
    if (file) this.load();
  }

  private load() {
    try {
      const data = JSON.parse(readFileSync(this.file!, 'utf8')) as { users: UserRecord[] };
      for (const u of data.users) {
        this.users.set(u.id, u);
        this.byHash.set(u.tokenHash, u.id);
      }
    } catch {
      /* first run */
    }
  }

  private scheduleSave() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 500);
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ users: [...this.users.values()] }));
    renameSync(tmp, this.file);
  }

  createGuest(name: string): { user: UserRecord; token: string } {
    const token = randomBytes(32).toString('base64url');
    const user: UserRecord = {
      id: randomUUID(),
      name,
      tokenHash: hash(token),
      tokens: STARTING_TOKENS,
      stats: { games: 0, wins: 0, shitheads: 0, rankedGames: 0, rankedWins: 0, tokensWon: 0 },
      createdAt: Date.now(),
      lastDailyAt: 0,
    };
    this.users.set(user.id, user);
    this.byHash.set(user.tokenHash, user.id);
    this.scheduleSave();
    return { user, token };
  }

  authenticate(token: unknown): UserRecord | null {
    if (typeof token !== 'string' || token.length < 20) return null;
    const id = this.byHash.get(hash(token));
    return id ? (this.users.get(id) ?? null) : null;
  }

  get(id: string) {
    return this.users.get(id) ?? null;
  }

  rename(id: string, name: string) {
    const u = this.users.get(id);
    if (u) {
      u.name = name;
      this.scheduleSave();
    }
  }

  /** Adjust a wallet. Refuses to go negative. */
  adjustTokens(id: string, delta: number): boolean {
    const u = this.users.get(id);
    if (!u || u.tokens + delta < 0) return false;
    u.tokens += delta;
    this.scheduleSave();
    return true;
  }

  updateStats(id: string, fn: (s: UserRecord['stats']) => void) {
    const u = this.users.get(id);
    if (u) {
      fn(u.stats);
      this.scheduleSave();
    }
  }

  claimDaily(id: string, now = Date.now()): { ok: true } | { ok: false; nextAt: number } {
    const u = this.users.get(id);
    if (!u) return { ok: false, nextAt: 0 };
    const nextAt = u.lastDailyAt + DAILY_INTERVAL_MS;
    if (now < nextAt) return { ok: false, nextAt };
    u.lastDailyAt = now;
    u.tokens += DAILY_BONUS;
    this.scheduleSave();
    return { ok: true };
  }

  profile(u: UserRecord): UserProfile {
    return { id: u.id, name: u.name, tokens: u.tokens, stats: { ...u.stats }, nextDailyAt: u.lastDailyAt + DAILY_INTERVAL_MS };
  }

  leaderboard(limit = 20) {
    return [...this.users.values()]
      .filter((u) => u.stats.games > 0)
      .sort((a, b) => b.tokens - a.tokens || b.stats.wins - a.stats.wins)
      .slice(0, limit)
      .map((u) => ({ name: u.name, tokens: u.tokens, wins: u.stats.wins, games: u.stats.games, rankedWins: u.stats.rankedWins }));
  }
}
