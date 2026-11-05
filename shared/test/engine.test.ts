import { describe, expect, it } from 'vitest';
import {
  applyAction,
  buildGameView,
  chooseBotAction,
  createGame,
  defaultSettings,
  requiredRank,
  sanitizeSettings,
  type Card,
  type GameSettings,
  type GameState,
  type Rank,
  type Suit,
} from '../src/index.js';

// ── helpers ──────────────────────────────────────────────────────

let uid = 0;
function c(spec: string): Card {
  const suit = spec.slice(-1) as Suit;
  const rank = (spec === 'JK' ? 'JOKER' : spec.slice(0, -1)) as Rank;
  return { id: `c${uid++}`, rank, suit: spec === 'JK' ? 'X' : suit };
}
const cs = (specs: string) => (specs ? specs.split(' ').map(c) : []);

interface Seat { hand?: string; up?: string; down?: string }
function table(seats: Seat[], opts: { discard?: string; draw?: string; settings?: Partial<GameSettings>; current?: number } = {}): GameState {
  return {
    status: 'PLAYING',
    settings: defaultSettings(opts.settings),
    players: seats.map((s, i) => ({
      id: `p${i}`,
      name: `P${i}`,
      hand: cs(s.hand ?? ''),
      faceUp: cs(s.up ?? ''),
      faceDown: cs(s.down ?? ''),
      setupReady: true,
      place: null,
    })),
    drawPile: cs(opts.draw ?? ''),
    discard: cs(opts.discard ?? ''),
    burnedCount: 0,
    currentIdx: opts.current ?? 0,
    direction: 1,
    finishOrder: [],
    shitheadId: null,
    version: 1,
    turnNumber: 1,
    log: [],
    startedAt: 0,
    finishedAt: null,
  };
}
const ids = (st: GameState, p: number, ranks: string[], from: 'hand' | 'faceUp' = 'hand') => {
  const pool = [...st.players[p][from]];
  return ranks.map((r) => {
    const i = pool.findIndex((x) => x.rank === r);
    if (i < 0) throw new Error(`no ${r}`);
    return pool.splice(i, 1)[0].id;
  });
};
const play = (st: GameState, p: number, ranks: string[], from: 'hand' | 'faceUp' = 'hand') =>
  applyAction(st, `p${p}`, { type: 'play', cardIds: ids(st, p, ranks, from) });
const seededRng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

// ── dealing & setup ──────────────────────────────────────────────

describe('dealing and setup', () => {
  it('deals 3 down, 3 up and 3 in hand from a 52-card deck', () => {
    const g = createGame([1, 2, 3, 4, 5].map((i) => ({ id: `u${i}`, name: `U${i}` })), defaultSettings(), seededRng(1));
    for (const p of g.players) {
      expect(p.hand).toHaveLength(3);
      expect(p.faceUp).toHaveLength(3);
      expect(p.faceDown).toHaveLength(3);
    }
    expect(g.drawPile).toHaveLength(52 - 45);
    const all = [...g.drawPile, ...g.players.flatMap((p) => [...p.hand, ...p.faceUp, ...p.faceDown])];
    expect(new Set(all.map((x) => x.id)).size).toBe(52);
    expect(new Set(all.map((x) => x.rank + x.suit)).size).toBe(52);
  });

  it('adds two jokers when enabled', () => {
    const g = createGame([{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }], defaultSettings({ jokers: true }), seededRng(2));
    const all = [...g.drawPile, ...g.players.flatMap((p) => [...p.hand, ...p.faceUp, ...p.faceDown])];
    expect(all.filter((x) => x.rank === 'JOKER')).toHaveLength(2);
  });

  it('lets players swap hand and face-up cards, then starts once everyone is ready', () => {
    const g = createGame([{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }], defaultSettings(), seededRng(3));
    const a = g.players.find((p) => p.id === 'a')!;
    const h = a.hand[0];
    const u = a.faceUp[1];
    expect(applyAction(g, 'a', { type: 'swap', handCardId: h.id, faceUpCardId: u.id }).ok).toBe(true);
    expect(a.hand[0]).toBe(u);
    expect(a.faceUp[1]).toBe(h);
    // cannot touch face-down or the other player's cards
    expect(applyAction(g, 'a', { type: 'swap', handCardId: a.hand[0].id, faceUpCardId: a.faceDown[0].id }).ok).toBe(false);
    const b = g.players.find((p) => p.id === 'b')!;
    expect(applyAction(g, 'a', { type: 'swap', handCardId: a.hand[0].id, faceUpCardId: b.faceUp[0].id }).ok).toBe(false);
    applyAction(g, 'a', { type: 'setupReady', ready: true });
    expect(g.status).toBe('SETUP');
    expect(applyAction(g, 'a', { type: 'swap', handCardId: a.hand[0].id, faceUpCardId: a.faceUp[0].id }).ok).toBe(false);
    applyAction(g, 'b', { type: 'setupReady', ready: true });
    expect(g.status).toBe('PLAYING');
  });
});

// ── basic play ───────────────────────────────────────────────────

describe('normal plays', () => {
  it('requires equal or higher rank', () => {
    const st = table([{ hand: '5H 9C KD' }, { hand: '4H 4C 4D' }], { discard: '7S' });
    expect(play(st, 0, ['5']).ok).toBe(false);
    expect(play(st, 0, ['9']).ok).toBe(true);
    expect(st.currentIdx).toBe(1);
  });

  it('rejects out-of-turn plays and cards you do not own', () => {
    const st = table([{ hand: '5H' }, { hand: '9C' }]);
    expect(applyAction(st, 'p1', { type: 'play', cardIds: [st.players[1].hand[0].id] }).ok).toBe(false);
    expect(applyAction(st, 'p0', { type: 'play', cardIds: [st.players[1].hand[0].id] }).ok).toBe(false);
  });

  it('allows several cards of the same rank as one turn, but not mixed ranks', () => {
    const st = table([{ hand: '9H 9C 9D KS' }, { hand: '4H' }], { draw: '5H 5C 5D 5S' });
    expect(play(st, 0, ['9', 'K']).ok).toBe(false);
    expect(play(st, 0, ['9', '9', '9']).ok).toBe(true);
    expect(st.discard).toHaveLength(3);
    expect(st.players[0].hand).toHaveLength(3); // drew back up to 3
    expect(st.drawPile).toHaveLength(2);
  });

  it('does not let you pick up when you could play (voluntary pickup off)', () => {
    const st = table([{ hand: '9H' }, { hand: '4H' }], { discard: '5C' });
    expect(applyAction(st, 'p0', { type: 'pickup' }).ok).toBe(false);
    const st2 = table([{ hand: '9H' }, { hand: '4H' }], { discard: '5C', settings: { voluntaryPickup: true } });
    expect(applyAction(st2, 'p0', { type: 'pickup' }).ok).toBe(true);
  });

  it('makes you pick up the whole pile when you cannot play, and passes the turn', () => {
    const st = table([{ hand: '4H 5H' }, { hand: '9C' }], { discard: '6C 9S' });
    expect(applyAction(st, 'p0', { type: 'pickup' }).ok).toBe(true);
    expect(st.players[0].hand).toHaveLength(4);
    expect(st.discard).toHaveLength(0);
    expect(st.currentIdx).toBe(1);
  });
});

// ── specials ─────────────────────────────────────────────────────

describe('special cards', () => {
  it('2 resets: playable on anything, next player may play anything', () => {
    const st = table([{ hand: '2H 4C 4D' }, { hand: '4H 6S' }], { discard: 'AS' });
    expect(play(st, 0, ['2']).ok).toBe(true);
    expect(requiredRank(st.discard, st.settings)).toBeNull();
    expect(play(st, 1, ['4']).ok).toBe(true);
  });

  it('3 is invisible: the next player must beat the card underneath', () => {
    const st = table([{ hand: '9H 4C' }, { hand: '3H 4D' }, { hand: '5C 9D' }]);
    play(st, 0, ['9']);
    expect(play(st, 1, ['3']).ok).toBe(true);
    expect(requiredRank(st.discard, st.settings)).toBe('9');
    expect(play(st, 2, ['5']).ok).toBe(false);
    expect(play(st, 2, ['9']).ok).toBe(true);
  });

  it('invisible on top of a reset keeps the pile open', () => {
    const st = table([{ hand: '2H 4C' }, { hand: '3H 4D' }, { hand: '4S 9D' }], { discard: 'KS' });
    play(st, 0, ['2']);
    play(st, 1, ['3']);
    expect(requiredRank(st.discard, st.settings)).toBeNull();
  });

  it('8 skips the next player', () => {
    const st = table([{ hand: '8H 4C' }, { hand: '9C' }, { hand: '9D' }]);
    expect(play(st, 0, ['8']).ok).toBe(true);
    expect(st.currentIdx).toBe(2);
  });

  it('8 in a two-player game gives the turn straight back', () => {
    const st = table([{ hand: '8H 4C' }, { hand: '9C' }]);
    play(st, 0, ['8']);
    expect(st.currentIdx).toBe(0);
  });

  it('skip stacking: two 8s skip two players only when enabled', () => {
    const off = table([{ hand: '8H 8C 4C' }, { hand: '9C' }, { hand: '9D' }, { hand: '9S' }]);
    play(off, 0, ['8', '8']);
    expect(off.currentIdx).toBe(2);
    const on = table([{ hand: '8H 8C 4C' }, { hand: '9C' }, { hand: '9D' }, { hand: '9S' }], { settings: { skipStacking: true } });
    play(on, 0, ['8', '8']);
    expect(on.currentIdx).toBe(3);
  });

  it('7 reverses the direction of play', () => {
    const st = table([{ hand: '7H 4C' }, { hand: '9C' }, { hand: '9D' }, { hand: 'KS' }]);
    expect(play(st, 0, ['7']).ok).toBe(true);
    expect(st.direction).toBe(-1);
    expect(st.currentIdx).toBe(3); // anti-clockwise now
    expect(play(st, 3, ['K']).ok).toBe(true);
    expect(st.currentIdx).toBe(2);
  });

  it('7 follows normal rank rules (cannot go on a 9)', () => {
    const st = table([{ hand: '7H 4C' }, { hand: '9C' }], { discard: '9S' });
    expect(play(st, 0, ['7']).ok).toBe(false);
  });

  it('10 burns the pile and the same player goes again', () => {
    const st = table([{ hand: '10H 4C 5C' }, { hand: '9C' }], { discard: 'AS KS' });
    expect(play(st, 0, ['10']).ok).toBe(true);
    expect(st.discard).toHaveLength(0);
    expect(st.burnedCount).toBe(3);
    expect(st.currentIdx).toBe(0);
  });

  it('four of a kind across players burns the pile', () => {
    const st = table([{ hand: '6H 6C 4C' }, { hand: '6D 6S 9C' }]);
    play(st, 0, ['6', '6']);
    expect(st.currentIdx).toBe(1);
    play(st, 1, ['6', '6']);
    expect(st.discard).toHaveLength(0);
    expect(st.currentIdx).toBe(1); // completer goes again
  });

  it('four of a kind can be turned off', () => {
    const st = table([{ hand: '6H 6C 6D 6S 4C' }, { hand: '9C' }], { settings: { fourOfAKindBurn: false } });
    play(st, 0, ['6', '6', '6', '6']);
    expect(st.discard).toHaveLength(4);
  });

  it('host-configured special ranks are honoured', () => {
    const st = table([{ hand: 'QH 4C' }, { hand: '9C' }], {
      discard: 'AS',
      settings: { specialRanks: { reset: 'Q', invisible: '3', reverse: '7', skip: '8', burn: '10' } },
    });
    expect(play(st, 0, ['Q']).ok).toBe(true); // Q is now a wild reset
    expect(requiredRank(st.discard, st.settings)).toBeNull();
  });

  it('disabling specials makes 2 the lowest normal card', () => {
    const st = table([{ hand: '2H 4C' }, { hand: '9C' }], { discard: '5S', settings: { specialsEnabled: false } });
    expect(play(st, 0, ['2']).ok).toBe(false);
  });

  it('jokers are wild and carry their configured ability', () => {
    const st = table([{ hand: 'JK 4C 5C' }, { hand: '9C' }], { discard: 'AS', settings: { jokers: true, jokerAbility: 'burn' } });
    expect(play(st, 0, ['JOKER']).ok).toBe(true);
    expect(st.discard).toHaveLength(0);
    expect(st.currentIdx).toBe(0);
  });
});

// ── table cards ──────────────────────────────────────────────────

describe('face-up and face-down phases', () => {
  it('face-up cards are only playable once the hand is empty and the deck is gone', () => {
    const st = table([{ hand: '4H', up: 'KH' }, { hand: '9C', down: '5D' }]);
    expect(play(st, 0, ['K'], 'faceUp').ok).toBe(false);
    play(st, 0, ['4']);
    play(st, 1, ['9']);
    expect(play(st, 0, ['K'], 'faceUp').ok).toBe(true);
  });

  it('a successful face-down flip is played normally', () => {
    const st = table([{ down: 'KH 4C' }, { hand: '9C' }], { discard: '9S' });
    // index 0 is K: valid
    expect(applyAction(st, 'p0', { type: 'playFaceDown', index: 0 }).ok).toBe(true);
    expect(st.discard.at(-1)!.rank).toBe('K');
    expect(st.currentIdx).toBe(1);
  });

  it('a failed face-down flip picks up the pile including the revealed card', () => {
    const st = table([{ down: '4C KH' }, { hand: '9C' }], { discard: '9S JS' });
    expect(applyAction(st, 'p0', { type: 'playFaceDown', index: 0 }).ok).toBe(true);
    expect(st.players[0].hand.map((x) => x.rank).sort()).toEqual(['4', '9', 'J'].sort());
    expect(st.players[0].faceDown).toHaveLength(1);
    expect(st.currentIdx).toBe(1);
  });

  it('you cannot flip face-down while holding cards', () => {
    const st = table([{ hand: '4H', down: 'KH' }, { hand: '9C' }]);
    expect(applyAction(st, 'p0', { type: 'playFaceDown', index: 0 }).ok).toBe(false);
  });
});

// ── finishing ────────────────────────────────────────────────────

describe('finishing and the Shithead', () => {
  it('finished players leave the rotation; the last one holding cards is the Shithead', () => {
    const st = table([{ down: 'KH' }, { hand: '4C 5C' }, { down: 'AH' }]);
    applyAction(st, 'p0', { type: 'playFaceDown', index: 0 });
    expect(st.players[0].place).toBe(1);
    expect(st.currentIdx).toBe(1);
    expect(applyAction(st, 'p1', { type: 'pickup' }).ok).toBe(true);
    expect(st.currentIdx).toBe(2); // skips the finished p0
    applyAction(st, 'p2', { type: 'playFaceDown', index: 0 });
    expect(st.status).toBe('FINISHED');
    expect(st.finishOrder).toEqual(['p0', 'p2']);
    expect(st.shitheadId).toBe('p1');
    expect(st.players[1].place).toBe(3);
  });

  it('finishing on a burn passes the turn on instead of granting an extra one', () => {
    const st = table([{ hand: '10H' }, { hand: '4C' }, { hand: '5C' }]);
    play(st, 0, ['10']);
    expect(st.players[0].place).toBe(1);
    expect(st.currentIdx).toBe(1);
  });
});

// ── information hiding ───────────────────────────────────────────

describe('views', () => {
  it('never reveals opponents\' hands or any face-down card', () => {
    const g = createGame([{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }, { id: 'c', name: 'c' }], defaultSettings(), seededRng(9));
    const view = buildGameView(g, 'a');
    const json = JSON.stringify(view);
    for (const p of g.players) {
      for (const card of p.faceDown) expect(json).not.toContain(card.id);
      if (p.id !== 'a') for (const card of p.hand) expect(json).not.toContain(card.id);
    }
    for (const card of g.drawPile) expect(json).not.toContain(card.id);
    expect(view.me?.hand).toHaveLength(3);
    expect(buildGameView(g, null).me).toBeNull();
  });
});

// ── settings ─────────────────────────────────────────────────────

describe('settings', () => {
  it('sanitizes hostile input and prevents two abilities sharing a rank', () => {
    const s = sanitizeSettings({ maxPlayers: 99, turnTimer: 7, specialRanks: { reset: '5', burn: '5', skip: 'Z' } });
    expect(s.maxPlayers).toBe(5);
    expect(s.turnTimer).toBe(30);
    expect(s.specialRanks.reset).toBe('5');
    expect(s.specialRanks.burn).toBeNull();
    expect(s.specialRanks.skip).toBeNull();
  });

  it('ranked games always use the standard ruleset', () => {
    const s = sanitizeSettings({ mode: 'ranked', stake: 100, specialsEnabled: false, voluntaryPickup: true });
    expect(s.specialsEnabled).toBe(true);
    expect(s.voluntaryPickup).toBe(false);
    expect(s.stake).toBe(100);
    expect(sanitizeSettings({ mode: 'ranked', stake: 1e9 }).stake).toBe(50);
  });
});

// ── full simulations ─────────────────────────────────────────────

describe('bot simulations', () => {
  const variants: Partial<GameSettings>[] = [
    {},
    { jokers: true },
    { skipStacking: true, voluntaryPickup: true },
    { specialsEnabled: false },
    { fourOfAKindBurn: false, handSize: 4 },
  ];
  it('500 random games always terminate with conserved cards and a single Shithead', () => {
    let games = 0;
    for (let seed = 1; seed <= 500; seed++) {
      const rng = seededRng(seed);
      const n = 2 + (seed % 4);
      const settings = defaultSettings(variants[seed % variants.length]);
      const g = createGame(Array.from({ length: n }, (_, i) => ({ id: `b${i}`, name: `B${i}` })), settings, rng);
      const total = 52 + (settings.jokers ? 2 : 0);
      let steps = 0;
      while (g.status !== 'FINISHED' && steps++ < 5000) {
        const actor = g.status === 'SETUP' ? g.players.find((p) => !p.setupReady)! : g.players[g.currentIdx];
        const action = chooseBotAction(g, actor.id, rng);
        expect(action).not.toBeNull();
        const res = applyAction(g, actor.id, action!);
        if (!res.ok) throw new Error(`seed ${seed}: ${res.error} ${JSON.stringify(action)}`);
        const count =
          g.drawPile.length + g.discard.length + g.burnedCount + g.players.reduce((a, p) => a + p.hand.length + p.faceUp.length + p.faceDown.length, 0);
        expect(count).toBe(total);
      }
      // Very rarely bots can loop forever picking up; that's fine as long as it's rare.
      if (g.status === 'FINISHED') {
        games++;
        expect(g.shitheadId).not.toBeNull();
        expect(g.finishOrder).toHaveLength(n - 1);
        expect(new Set(g.players.map((p) => p.place)).size).toBe(n);
      }
    }
    expect(games).toBe(500);
  });
});
