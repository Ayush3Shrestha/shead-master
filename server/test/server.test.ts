import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { ClientState, GameAction, GameView, UserProfile } from '@shead/shared';
import { createApp, type App } from '../src/app.js';

let app: App;
let url: string;
const sockets: Socket[] = [];

beforeEach(async () => {
  app = createApp({
    dataFile: null,
    rateLimit: 10_000,
    timings: { botDelayMs: 5, disconnectGraceMs: 150, setupTimeoutMs: 5000, quickPlayCountdownMs: 100, lobbyDisconnectMs: 300 },
  });
  await new Promise<void>((r) => app.http.listen(0, r));
  url = `http://localhost:${(app.http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  await app.close();
});

interface Client {
  token: string;
  profile: UserProfile;
  socket: Socket;
  state: ClientState;
  states: ClientState[];
  emit<T = any>(event: string, payload?: unknown): Promise<T>;
  waitFor(pred: (s: ClientState) => boolean, ms?: number): Promise<ClientState>;
}

async function guest(name: string, token?: string): Promise<Client> {
  if (!token) {
    const res = await fetch(`${url}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    const body = (await res.json()) as { token: string };
    token = body.token as string;
  }
  const socket = connect(url, { auth: { token }, transports: ['websocket'], forceNew: true });
  sockets.push(socket);
  const client: Client = {
    token,
    profile: undefined as unknown as UserProfile,
    socket,
    state: { room: null, game: null },
    states: [],
    emit: (event, payload = {}) => new Promise((r) => socket.emit(event, payload, r)),
    waitFor: (pred, ms = 8000) =>
      new Promise((resolve, reject) => {
        if (pred(client.state)) return resolve(client.state);
        const timer = setTimeout(() => {
          socket.off('state', check);
          reject(new Error(`timeout waiting for state (${name}) turn=${client.state.game?.turnNumber} status=${client.state.game?.status}`));
        }, ms);
        const check = (s: ClientState) => {
          if (pred(s)) {
            clearTimeout(timer);
            socket.off('state', check);
            resolve(s);
          }
        };
        socket.on('state', check);
      }),
  };
  socket.on('state', (s: ClientState) => {
    client.state = s;
    client.states.push(s);
  });
  socket.on('profile', (p: UserProfile) => (client.profile = p));
  await new Promise<void>((r, j) => {
    socket.once('connect', () => r());
    socket.once('connect_error', j);
  });
  await client.waitFor(() => true);
  return client;
}

/** A dumb client-side player that only uses what its view exposes. */
function nextMove(g: GameView): GameAction | null {
  const me = g.me;
  if (!me) return null;
  if (g.status === 'SETUP') {
    const mine = g.players.find((p) => p.id === g.currentPlayerId);
    void mine;
    return g.players.some((p) => p.setupReady === false) ? { type: 'setupReady', ready: true } : null;
  }
  if (g.status !== 'PLAYING' || !me.isMyTurn) return null;
  if (me.zone === 'faceDown') return { type: 'playFaceDown', index: 0 };
  if (me.playableIds.length) return { type: 'play', cardIds: [me.playableIds[0]] };
  return { type: 'pickup' };
}

function autoplay(c: Client) {
  let busy = false;
  const tick = async (s: ClientState) => {
    if (busy || !s.game) return;
    const me = s.game.players.find((p) => p.id === c.profile?.id);
    if (s.game.status === 'SETUP' && me?.setupReady) return;
    const a = nextMove(s.game);
    if (!a) return;
    busy = true;
    await c.emit('game:action', { version: s.game.version, action: a });
    busy = false;
    if (c.state !== s) tick(c.state);
  };
  c.socket.on('state', tick);
  tick(c.state);
}

describe('server', () => {
  it('rejects sockets without a valid token', async () => {
    const s = connect(url, { auth: { token: 'nope-nope-nope-nope-nope' }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    const err = await new Promise<Error>((r) => s.once('connect_error', r));
    expect(err.message).toBe('unauthorized');
  });

  it('runs a private party with bots end-to-end and hides opponents\' cards', async () => {
    const a = await guest('Alice');
    const b = await guest('Bob');
    const created = await a.emit('room:create', { settings: { turnTimer: 0 } });
    expect(created.ok).toBe(true);
    expect((await a.emit('room:addBot')).ok).toBe(true);
    expect((await b.emit('room:join', { code: created.code.toLowerCase() })).ok).toBe(true);
    await a.waitFor((s) => s.room?.members.length === 3);

    expect((await b.emit('room:start')).ok).toBe(false); // only host
    expect((await a.emit('room:start')).ok).toBe(false); // not ready
    await a.emit('room:ready', { ready: true });
    await b.emit('room:ready', { ready: true });
    expect((await a.emit('room:start')).ok).toBe(true);

    // Leak check on the first dealt state.
    const dealt = await b.waitFor((s) => s.game?.status === 'SETUP');
    const internal = app.rooms.roomOf(a.profile.id)!.game!;
    const alice = internal.players.find((p) => p.id === a.profile.id)!;
    const json = JSON.stringify(dealt);
    for (const card of [...alice.hand, ...alice.faceDown]) expect(json).not.toContain(card.id);

    // Not your turn / stale version are rejected.
    expect((await b.emit('game:action', { version: -1, action: { type: 'pickup' } })).ok).toBe(false);

    autoplay(a);
    autoplay(b);
    const done = await a.waitFor((s) => s.room?.status === 'FINISHED', 20000);
    expect(done.room!.lastResult!.rankings).toHaveLength(3);
    expect(done.room!.lastResult!.shitheadId).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(a.profile.stats.games).toBe(1);

    // Back to the lobby for another round.
    expect((await a.emit('room:reset')).ok).toBe(true);
    const lobby = await b.waitFor((s) => s.room?.status === 'WAITING');
    expect(lobby.room!.members).toHaveLength(3);
  });

  it('ranked: stakes are escrowed and the first player out takes the pot', async () => {
    const a = await guest('Ann');
    const b = await guest('Ben');
    const c = await guest('Cat');
    const created = await a.emit('room:create', { settings: { mode: 'ranked', stake: 100, voluntaryPickup: true } });
    expect(created.ok).toBe(true);
    expect((await a.emit('room:addBot')).ok).toBe(false); // no bots in ranked
    await b.emit('room:join', { code: created.code });
    await c.emit('room:join', { code: created.code });
    for (const p of [a, b, c]) await p.emit('room:ready', { ready: true });
    expect((await a.emit('room:start')).ok).toBe(true);
    await a.waitFor((s) => s.game?.status === 'SETUP');
    await new Promise((r) => setTimeout(r, 50));
    expect(a.profile.tokens).toBe(900);
    expect(a.state.room!.pot).toBe(300);
    expect(a.state.room!.settings.voluntaryPickup).toBe(false); // ranked = standard rules

    for (const p of [a, b, c]) autoplay(p);
    const done = await a.waitFor((s) => s.room?.status === 'FINISHED', 20000);
    await new Promise((r) => setTimeout(r, 50));
    const winnerId = done.room!.lastResult!.payout!.winnerId;
    const byId = Object.fromEntries([a, b, c].map((p) => [p.profile.id, p.profile.tokens]));
    expect(byId[winnerId!]).toBe(1200);
    for (const [id, tokens] of Object.entries(byId)) if (id !== winnerId) expect(tokens).toBe(900);
    expect(Object.values(byId).reduce((x, y) => x + y, 0)).toBe(3000);
  });

  it('ranked: refunds everyone if the table is abandoned before anyone finishes', async () => {
    const a = await guest('Ann');
    const b = await guest('Ben');
    const { code } = await a.emit('room:create', { settings: { mode: 'ranked', stake: 250 } });
    await b.emit('room:join', { code });
    await a.emit('room:ready', { ready: true });
    await b.emit('room:ready', { ready: true });
    await a.emit('room:start');
    await a.waitFor((s) => s.game?.status === 'SETUP');
    await new Promise((r) => setTimeout(r, 50));
    expect(a.profile.tokens).toBe(750);
    await a.emit('room:leave');
    await b.emit('room:leave');
    await new Promise((r) => setTimeout(r, 50));
    expect(a.profile.tokens).toBe(1000);
    expect(b.profile.tokens).toBe(1000);
  });

  it('reconnects a dropped player to their seat, and autopilots them if they stay away', async () => {
    const a = await guest('Amy');
    const b = await guest('Bea');
    const { code } = await a.emit('room:create', { settings: { turnTimer: 0 } });
    await b.emit('room:join', { code });
    await a.emit('room:ready', { ready: true });
    await b.emit('room:ready', { ready: true });
    await a.emit('room:start');
    await b.waitFor((s) => s.game?.status === 'SETUP');
    const handBefore = b.state.game!.me!.hand.map((c) => c.id).sort();

    b.socket.disconnect();
    const b2 = await guest('Bea', b.token);
    const back = await b2.waitFor((s) => s.game?.status === 'SETUP');
    expect(back.game!.me!.hand.map((c) => c.id).sort()).toEqual(handBefore);
    expect(back.room!.members.find((m) => m.userId === b.profile.id)!.connected).toBe(true);

    // Now Bea vanishes for good: the autopilot must carry her seat to the end of the game.
    b2.socket.disconnect();
    autoplay(a);
    const done = await a.waitFor((s) => s.room?.status === 'FINISHED', 20000);
    expect(done.game!.log.some((e) => e.type === 'AUTO_PLAYED')).toBe(true);
  });

  it('quick play matches players into the same table and auto-starts', async () => {
    const a = await guest('Q1');
    const b = await guest('Q2');
    const r1 = await a.emit('room:quickplay', { mode: 'classic' });
    const r2 = await b.emit('room:quickplay', { mode: 'classic' });
    expect(r1.code).toBe(r2.code);
    const started = await a.waitFor((s) => s.room?.status === 'PLAYING');
    expect(started.game!.players).toHaveLength(2);
  });

  it('lets spectators watch without seeing anyone\'s hand', async () => {
    const a = await guest('Pat');
    const b = await guest('Sam');
    const v = await guest('Viewer');
    const { code } = await a.emit('room:create', { settings: {} });
    await a.emit('room:addBot');
    await a.emit('room:ready', { ready: true });
    await a.emit('room:start');
    void b;
    const res = await v.emit('room:join', { code });
    expect(res).toMatchObject({ ok: true, spectator: true });
    const s = await v.waitFor((x) => !!x.game);
    expect(s.game!.me).toBeNull();
    expect(s.room!.youAreSpectator).toBe(true);
  });
});
