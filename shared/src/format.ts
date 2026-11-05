import { ABILITY_INFO, type Card, type GameEvent, type Suit } from './types.js';

export const SUIT_SYMBOL: Record<Suit, string> = { H: '♥', D: '♦', C: '♣', S: '♠', X: '★' };

export function isRed(suit: Suit) {
  return suit === 'H' || suit === 'D';
}

export function cardLabel(c: Pick<Card, 'rank' | 'suit'>): string {
  return c.rank === 'JOKER' ? 'Joker' : `${c.rank}${SUIT_SYMBOL[c.suit]}`;
}

function cardsLabel(cards: Card[] = []): string {
  if (cards.length === 0) return '';
  if (cards.length === 1) return cardLabel(cards[0]);
  return `${cards.length}× ${cards[0].rank === 'JOKER' ? 'Joker' : cards[0].rank}`;
}

/** Human-readable line for the action history. */
export function describeEvent(e: GameEvent, nameOf: (id?: string) => string): string | null {
  const who = nameOf(e.playerId);
  switch (e.type) {
    case 'GAME_STARTED':
      return 'Game started — swap cards between your hand and face-up row, then press Ready.';
    case 'TURN_STARTED':
      return `${who} starts.`;
    case 'CARD_PLAYED':
      return `${who} played ${cardsLabel(e.cards)}.`;
    case 'FACE_DOWN_REVEALED':
      return `${who} flipped ${cardsLabel(e.cards)} from face-down.`;
    case 'PILE_PICKED_UP':
      return `${who} picked up the pile (${e.count} card${e.count === 1 ? '' : 's'}).`;
    case 'SPECIAL_ABILITY_TRIGGERED':
      if (!e.ability || e.ability === 'burn' || e.ability === 'skip') return null;
      return `${ABILITY_INFO[e.ability].icon} ${ABILITY_INFO[e.ability].label}!`;
    case 'PILE_BURNED':
      return `🔥 ${who} burned the pile${e.reason === 'four of a kind' ? ' with four of a kind' : ''} and goes again.`;
    case 'PLAYER_SKIPPED':
      return `⏭ ${nameOf(e.targetId)} is skipped.`;
    case 'DIRECTION_REVERSED':
      return '⇄ Direction reversed.';
    case 'PLAYER_FINISHED':
      return `🏁 ${who} is out — ${ordinal(e.place ?? 0)} place!`;
    case 'GAME_FINISHED':
      return e.playerId ? `💩 ${who} is the Shithead!` : 'Game over.';
    case 'AUTO_PLAYED':
      return `⏱ ${who} ${e.reason ?? 'was auto-played'}.`;
    default:
      return null;
  }
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
