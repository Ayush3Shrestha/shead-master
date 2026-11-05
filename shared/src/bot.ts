import { canPickup, getPlayer, playableCardIds, zoneOf } from './engine.js';
import { abilityOf, cardSortValue } from './rules.js';
import type { Card, GameAction, GameSettings, GameState } from './types.js';

/**
 * Simple, decent strategy used for bots, turn time-outs and players who are away.
 * Returns null when the player has nothing to do.
 */
export function chooseBotAction(state: GameState, playerId: string, rng: () => number = Math.random): GameAction | null {
  const p = getPlayer(state, playerId);
  if (!p) return null;
  const s = state.settings;

  if (state.status === 'SETUP') {
    if (p.setupReady) return null;
    // Keep the strongest cards face-up (they're safest late), weakest in hand.
    const all = [...p.hand, ...p.faceUp].sort((a, b) => strength(b, s) - strength(a, s) || (a.id < b.id ? -1 : 1));
    const wantFaceUp = new Set(all.slice(0, p.faceUp.length).map((c) => c.id));
    const handOut = p.hand.find((c) => wantFaceUp.has(c.id));
    const upOut = p.faceUp.find((c) => !wantFaceUp.has(c.id));
    if (handOut && upOut) return { type: 'swap', handCardId: handOut.id, faceUpCardId: upOut.id };
    return { type: 'setupReady', ready: true };
  }

  if (state.status !== 'PLAYING' || state.players[state.currentIdx]?.id !== playerId) return null;
  const zone = zoneOf(p);
  if (zone === 'faceDown') return { type: 'playFaceDown', index: Math.floor(rng() * p.faceDown.length) };
  if (zone === 'done') return null;

  const source = zone === 'hand' ? p.hand : p.faceUp;
  const playable = new Set(playableCardIds(state, playerId));
  const options = source.filter((c) => playable.has(c.id));
  if (options.length === 0) return canPickup(state, playerId) ? { type: 'pickup' } : null;

  // Play the cheapest option; save specials for when they're needed.
  options.sort((a, b) => cardSortValue(a.rank, s) - cardSortValue(b.rank, s));
  const rank = options[0].rank;
  let cards = source.filter((c) => c.rank === rank);
  // Hold back extra specials (play one at a time) unless burning/finishing.
  const ab = abilityOf(rank, s);
  if (ab && ab !== 'burn' && cards.length > 1 && state.drawPile.length > 0) cards = cards.slice(0, 1);
  return { type: 'play', cardIds: cards.map((c) => c.id) };
}

function strength(c: Card, s: GameSettings): number {
  return cardSortValue(c.rank, s);
}
