import { describe, expect, it } from 'vitest';
import { applyAction, BOT_LEVELS, chooseBotAction, createGame, defaultSettings, type BotLevel, type GameState } from '../src/index.js';

const seededRng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

function playOut(levels: BotLevel[], seed: number, settings = defaultSettings()): GameState {
  const rng = seededRng(seed);
  const g = createGame(levels.map((_, i) => ({ id: `s${i}`, name: `S${i}` })), settings, rng);
  for (let steps = 0; g.status !== 'FINISHED' && steps < 4000; steps++) {
    const actor = g.status === 'SETUP' ? g.players.find((p) => !p.setupReady)! : g.players[g.currentIdx];
    const action = chooseBotAction(g, actor.id, rng, levels[Number(actor.id.slice(1))]);
    expect(action).not.toBeNull();
    const res = applyAction(g, actor.id, action!);
    if (!res.ok) throw new Error(`${res.error}: ${JSON.stringify(action)}`);
  }
  return g;
}

describe('bot levels', () => {
  it('every level only makes legal moves and games finish', () => {
    const variants = [{}, { jokers: true }, { skipStacking: true, voluntaryPickup: true }, { specialsEnabled: false }, { handSize: 4 }];
    for (let seed = 1; seed <= 25; seed++) {
      const levels = [...BOT_LEVELS, ...BOT_LEVELS].slice(seed % 3, (seed % 3) + 2 + (seed % 3)) as BotLevel[];
      const g = playOut(levels, seed, defaultSettings(variants[seed % variants.length]));
      expect(g.status).toBe('FINISHED');
    }
  });

  it("the expert never peeks: moving hidden cards around doesn't change its decision", () => {
    let checked = 0;
    for (let seed = 1; seed <= 40 && checked < 15; seed++) {
      const rng = seededRng(seed);
      const g = createGame([{ id: 'me', name: 'me' }, { id: 'o1', name: 'o1' }, { id: 'o2', name: 'o2' }], defaultSettings(), rng);
      // Play a few moves to get a mid-game position where it's "me" to act.
      for (let i = 0; i < 60 && g.status !== 'FINISHED'; i++) {
        const actor = g.status === 'SETUP' ? g.players.find((p) => !p.setupReady)! : g.players[g.currentIdx];
        if (g.status === 'PLAYING' && actor.id === 'me' && i > 20) break;
        applyAction(g, actor.id, chooseBotAction(g, actor.id, rng, 'hard')!);
      }
      if (g.status !== 'PLAYING' || g.players[g.currentIdx].id !== 'me' || g.drawPile.length < 2) continue;
      const before = chooseBotAction(structuredClone(g), 'me', seededRng(99), 'expert');
      // Swap an opponent's (unknown) hand card with a deck card, and shuffle face-down cards between opponents.
      const alt = structuredClone(g);
      const o1 = alt.players.find((p) => p.id === 'o1')!;
      const o2 = alt.players.find((p) => p.id === 'o2')!;
      const unknownIdx = o1.hand.findIndex((c) => !(o1.known ?? []).includes(c.id));
      if (unknownIdx >= 0) [o1.hand[unknownIdx], alt.drawPile[0]] = [alt.drawPile[0], o1.hand[unknownIdx]];
      if (o1.faceDown.length && o2.faceDown.length) [o1.faceDown[0], o2.faceDown[0]] = [o2.faceDown[0], o1.faceDown[0]];
      const after = chooseBotAction(alt, 'me', seededRng(99), 'expert');
      expect(after).toEqual(before);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('expert beats hard, and hard beats normal, head to head', () => {
    const score = (a: BotLevel, b: BotLevel, games: number) => {
      let wins = 0;
      for (let seed = 1; seed <= games; seed++) {
        // alternate seats so neither side gets the first-move edge
        const levels: BotLevel[] = seed % 2 ? [a, b] : [b, a];
        const g = playOut(levels, 1000 + seed);
        if (g.finishOrder[0] === `s${levels.indexOf(a)}`) wins++;
      }
      return wins / games;
    };
    expect(score('hard', 'normal', 200)).toBeGreaterThan(0.6);
    expect(score('expert', 'hard', 60)).toBeGreaterThan(0.55);
  }, 120_000);
});
