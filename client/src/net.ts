import { useSyncExternalStore } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ClientState, GameAction, GameMode, GameSettings, PublicRoomSummary, UserProfile } from '@shead/shared';

const TOKEN_KEY = 'shead.token';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

interface Snapshot {
  ready: boolean; // finished the initial auth check
  profile: UserProfile | null;
  connected: boolean;
  state: ClientState;
  toasts: Toast[];
}

type Ack = { ok: boolean; error?: string; [k: string]: unknown };

function safeGet(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

class Net {
  private snap: Snapshot = { ready: false, profile: null, connected: false, state: { room: null, game: null }, toasts: [] };
  private listeners = new Set<() => void>();
  private socket: Socket | null = null;
  private token: string | null = safeGet(TOKEN_KEY);
  private toastId = 0;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  get = () => this.snap;

  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  toast(text: string, kind: Toast['kind'] = 'info') {
    const t = { id: ++this.toastId, text, kind };
    this.set({ toasts: [...this.snap.toasts, t].slice(-3) });
    setTimeout(() => this.set({ toasts: this.snap.toasts.filter((x) => x.id !== t.id) }), kind === 'error' ? 3500 : 2500);
  }

  // ───────────────────────── auth ─────────────────────────

  async init() {
    if (this.token) {
      const res = await fetch('/api/me', { headers: { authorization: `Bearer ${this.token}` } }).catch(() => null);
      if (res?.ok) {
        this.set({ profile: await res.json() });
        this.connect();
      } else if (res?.status === 401) {
        this.token = null;
        safeSet(TOKEN_KEY, null);
      }
    }
    this.set({ ready: true });
  }

  async signUp(name: string) {
    const res = await fetch('/api/auth/guest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'Could not sign in');
    this.token = body.token;
    safeSet(TOKEN_KEY, body.token);
    this.set({ profile: body.profile });
    this.connect();
  }

  async rename(name: string) {
    const res = await fetch('/api/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ name }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    this.set({ profile: body });
  }

  async claimDaily() {
    const res = await fetch('/api/me/daily', { method: 'POST', headers: { authorization: `Bearer ${this.token}` } });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    this.set({ profile: body });
  }

  async leaderboard(): Promise<{ name: string; tokens: number; wins: number; games: number; rankedWins: number }[]> {
    const res = await fetch('/api/leaderboard');
    return res.json();
  }

  signOut() {
    this.socket?.disconnect();
    this.socket = null;
    this.token = null;
    safeSet(TOKEN_KEY, null);
    this.set({ profile: null, connected: false, state: { room: null, game: null } });
  }

  // ───────────────────────── socket ─────────────────────────

  private connect() {
    if (this.socket || !this.token) return;
    const s = io({ auth: { token: this.token }, transports: ['websocket', 'polling'] });
    this.socket = s;
    s.on('connect', () => this.set({ connected: true }));
    s.on('disconnect', () => this.set({ connected: false }));
    s.on('connect_error', (err) => {
      if (err.message === 'unauthorized') this.signOut();
    });
    s.on('state', (state: ClientState) => this.set({ state }));
    s.on('profile', (profile: UserProfile) => this.set({ profile }));
    s.on('kicked', (p: { reason: string }) => this.toast(p.reason, 'error'));
  }

  private emit(event: string, payload: unknown = {}): Promise<Ack> {
    return new Promise((resolve) => {
      if (!this.socket?.connected) {
        resolve({ ok: false, error: 'Not connected — reconnecting…' });
        return;
      }
      this.socket.timeout(8000).emit(event, payload, (err: Error | null, res: Ack) => {
        resolve(err ? { ok: false, error: 'Server did not respond' } : res);
      });
    });
  }

  /** Emit and toast any error. Resolves to the ack. */
  async run(event: string, payload?: unknown): Promise<Ack> {
    const res = await this.emit(event, payload);
    if (!res.ok && res.error) this.toast(res.error, 'error');
    return res;
  }

  createRoom = (settings: Partial<GameSettings>) => this.run('room:create', { settings });
  joinRoom = (code: string) => this.run('room:join', { code });
  quickPlay = (mode: GameMode, stake?: number) => this.run('room:quickplay', { mode, stake });
  leave = () => this.run('room:leave');
  ready = (ready: boolean) => this.run('room:ready', { ready });
  updateSettings = (settings: GameSettings) => this.run('room:settings', { settings });
  addBot = () => this.run('room:addBot');
  kick = (userId: string) => this.run('room:kick', { userId });
  start = () => this.run('room:start');
  reset = () => this.run('room:reset');
  async listRooms(): Promise<PublicRoomSummary[]> {
    const res = await this.emit('rooms:list');
    return res.ok ? (res.rooms as PublicRoomSummary[]) : [];
  }
  act = (action: GameAction) => this.run('game:action', { version: this.snap.state.game?.version, action });
}

export const net = new Net();

export function useNet() {
  return useSyncExternalStore(net.subscribe, net.get);
}
