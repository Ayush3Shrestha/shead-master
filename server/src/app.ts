import { existsSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import express, { type Request } from 'express';
import { Server as IOServer, type Socket } from 'socket.io';
import type { GameMode } from '@shead/shared';
import { DEFAULT_TIMINGS, RoomManager, type Timings } from './rooms.js';
import { cleanName, Store, type UserRecord } from './store.js';

export interface AppOptions {
  dataFile?: string | null;
  staticDir?: string | null;
  timings?: Partial<Timings>;
  corsOrigin?: string | string[];
  /** Max socket events per 2-second window per socket. */
  rateLimit?: number;
}

export interface App {
  http: HttpServer;
  io: IOServer;
  store: Store;
  rooms: RoomManager;
  close(): Promise<void>;
}

type Ack = (res: unknown) => void;

export function createApp(opts: AppOptions = {}): App {
  const store = new Store(opts.dataFile ?? null);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  const http = createServer(app);
  const io = new IOServer(http, {
    cors: opts.corsOrigin ? { origin: opts.corsOrigin } : undefined,
    maxHttpBufferSize: 32 * 1024,
  });

  const online = new Map<string, number>();
  const rooms = new RoomManager(
    store,
    {
      toUser: (userId, event, payload) => io.to(`user:${userId}`).emit(event, payload),
      isOnline: (userId) => (online.get(userId) ?? 0) > 0,
    },
    { ...DEFAULT_TIMINGS, ...opts.timings },
  );

  // ───────────────────────────── REST ─────────────────────────────

  const authed = (req: Request): UserRecord | null => {
    const h = req.headers.authorization ?? '';
    return store.authenticate(h.startsWith('Bearer ') ? h.slice(7) : null);
  };

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, rooms: rooms.roomCount() });
  });

  app.post('/api/auth/guest', (req, res) => {
    const name = cleanName(req.body?.name);
    if (!name) return void res.status(400).json({ error: 'Pick a name (1–16 characters)' });
    const { user, token } = store.createGuest(name);
    res.json({ token, profile: store.profile(user) });
  });

  app.get('/api/me', (req, res) => {
    const u = authed(req);
    if (!u) return void res.status(401).json({ error: 'Not signed in' });
    res.json(store.profile(u));
  });

  app.patch('/api/me', (req, res) => {
    const u = authed(req);
    if (!u) return void res.status(401).json({ error: 'Not signed in' });
    const name = cleanName(req.body?.name);
    if (!name) return void res.status(400).json({ error: 'Pick a name (1–16 characters)' });
    store.rename(u.id, name);
    res.json(store.profile(u));
  });

  app.post('/api/me/daily', (req, res) => {
    const u = authed(req);
    if (!u) return void res.status(401).json({ error: 'Not signed in' });
    const r = store.claimDaily(u.id);
    if (!r.ok) return void res.status(429).json({ error: 'Daily bonus already claimed', nextAt: r.nextAt });
    io.to(`user:${u.id}`).emit('profile', store.profile(u));
    res.json(store.profile(u));
  });

  app.get('/api/leaderboard', (_req, res) => {
    res.json(store.leaderboard());
  });

  app.get('/api/rooms', (_req, res) => {
    res.json(rooms.listPublic());
  });

  if (opts.staticDir && existsSync(opts.staticDir)) {
    const dir = opts.staticDir;
    app.use(express.static(dir, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/|\/socket\.io\/).*/, (_req, res) => res.sendFile(join(dir, 'index.html')));
  }

  // ─────────────────────────── Socket.IO ───────────────────────────

  io.use((socket, next) => {
    const user = store.authenticate(socket.handshake.auth?.token);
    if (!user) return next(new Error('unauthorized'));
    socket.data.userId = user.id;
    next();
  });

  io.on('connection', (socket: Socket) => {
    const userId = socket.data.userId as string;
    socket.join(`user:${userId}`);
    online.set(userId, (online.get(userId) ?? 0) + 1);
    const u = store.get(userId);
    if (u) socket.emit('profile', store.profile(u));
    rooms.onConnect(userId);

    // Simple flood protection: N events per 2 seconds per socket.
    const maxEvents = opts.rateLimit ?? 25;
    let windowStart = Date.now();
    let count = 0;
    const limited = () => {
      const now = Date.now();
      if (now - windowStart > 2000) {
        windowStart = now;
        count = 0;
      }
      return ++count > maxEvents;
    };

    const on = (event: string, handler: (payload: any) => unknown) => {
      socket.on(event, (payload: any, ack?: Ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        if (limited()) return reply({ ok: false, error: 'Slow down' });
        try {
          reply(handler(payload ?? {}));
        } catch (err) {
          console.error(`[${event}]`, err);
          reply({ ok: false, error: 'Server error' });
        }
      });
    };

    on('room:create', (p) => rooms.create(userId, p.settings));
    on('room:join', (p) => rooms.join(userId, p.code));
    on('room:quickplay', (p) => rooms.quickPlay(userId, (p.mode === 'ranked' ? 'ranked' : 'classic') as GameMode, p.stake));
    on('room:leave', () => rooms.leave(userId));
    on('room:ready', (p) => rooms.setReady(userId, !!p.ready));
    on('room:settings', (p) => rooms.updateSettings(userId, p.settings));
    on('room:addBot', (p) => rooms.addBot(userId, p.level));
    on('room:solo', (p) => rooms.solo(userId, p));
    on('room:kick', (p) => rooms.kick(userId, p.userId));
    on('room:start', () => rooms.start(userId));
    on('room:reset', () => rooms.reset(userId));
    on('rooms:list', () => ({ ok: true, rooms: rooms.listPublic() }));
    on('game:action', (p) => rooms.action(userId, p.version, p.action));

    socket.on('disconnect', () => {
      const n = (online.get(userId) ?? 1) - 1;
      if (n <= 0) online.delete(userId);
      else online.set(userId, n);
      rooms.onDisconnect(userId);
    });
  });

  return {
    http,
    io,
    store,
    rooms,
    close: () =>
      new Promise<void>((resolve) => {
        rooms.shutdown();
        store.flush();
        io.close(() => resolve());
      }),
  };
}
