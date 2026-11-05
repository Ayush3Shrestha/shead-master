import { canPickup, currentPlayer, getPlayer, playableCardIds, zoneOf } from './engine.js';
import { requiredRank, sortCards } from './rules.js';
import type { GameEvent, GameState, GameView, PhaseName } from './types.js';

/**
 * Build the view one viewer is allowed to see. Opponents' hands and every face-down
 * card are reduced to counts, so no hidden information ever leaves the server.
 * Pass viewerId = null for spectators.
 */
export function buildGameView(state: GameState, viewerId: string | null): GameView {
  const cur = currentPlayer(state);
  const me = viewerId ? getPlayer(state, viewerId) : undefined;
  let phase: PhaseName = state.status === 'SETUP' ? 'SETUP' : state.status === 'FINISHED' ? 'FINISHED' : 'PLAYING_HAND';
  if (state.status === 'PLAYING' && cur) {
    const z = zoneOf(cur);
    phase = z === 'faceUp' ? 'PLAYING_FACE_UP' : z === 'faceDown' ? 'PLAYING_FACE_DOWN' : 'PLAYING_HAND';
  }
  return {
    status: state.status,
    phase,
    version: state.version,
    turnNumber: state.turnNumber,
    direction: state.direction,
    currentPlayerId: cur?.id ?? null,
    drawCount: state.drawPile.length,
    discard: state.discard,
    burnedCount: state.burnedCount,
    requiredRank: requiredRank(state.discard, state.settings),
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      handCount: p.hand.length,
      faceUp: p.faceUp,
      faceDownCount: p.faceDown.length,
      setupReady: p.setupReady,
      place: p.place,
      zone: zoneOf(p),
    })),
    me: me
      ? {
          hand: sortCards(me.hand, state.settings),
          zone: zoneOf(me),
          playableIds: cur?.id === me.id ? playableCardIds(state, me.id) : [],
          canPickup: canPickup(state, me.id),
          mustPickup: cur?.id === me.id && state.discard.length > 0 && zoneOf(me) !== 'faceDown' && playableCardIds(state, me.id).length === 0,
          isMyTurn: cur?.id === me.id,
        }
      : null,
    log: state.log.slice(-40).map(redactEvent),
    finishOrder: state.finishOrder,
    shitheadId: state.shitheadId,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    settings: state.settings,
  };
}

/** Events only ever carry public cards, but copy defensively so views are detached from state. */
function redactEvent(e: GameEvent): GameEvent {
  return e.cards ? { ...e, cards: e.cards.map((c) => ({ ...c })) } : { ...e };
}
