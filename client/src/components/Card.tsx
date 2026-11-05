import { ABILITY_INFO, abilityOf, isRed, SUIT_SYMBOL, type Card as CardT, type GameSettings } from '@shead/shared';

interface Props {
  card?: CardT | null; // undefined/null = face-down back
  settings?: GameSettings;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  selected?: boolean;
  playable?: boolean;
  dimmed?: boolean;
  onClick?: () => void;
  className?: string;
  style?: React.CSSProperties;
  label?: string;
}

export function Card({ card, settings, size = 'md', selected, playable, dimmed, onClick, className = '', style, label }: Props) {
  const classes = ['card', `card-${size}`, className];
  if (selected) classes.push('selected');
  if (playable) classes.push('playable');
  if (dimmed) classes.push('dimmed');
  if (onClick) classes.push('clickable');

  if (!card) {
    classes.push('back');
    return (
      <button type="button" className={classes.join(' ')} style={style} onClick={onClick} disabled={!onClick} aria-label={label ?? 'Face-down card'}>
        <span className="back-pattern" />
      </button>
    );
  }

  const ability = settings ? abilityOf(card.rank, settings) : null;
  const joker = card.rank === 'JOKER';
  classes.push(isRed(card.suit) ? 'red' : 'black');
  if (ability) classes.push('special');
  const sym = SUIT_SYMBOL[card.suit];
  const name = joker ? 'Joker' : `${card.rank} of ${{ H: 'hearts', D: 'diamonds', C: 'clubs', S: 'spades', X: '' }[card.suit]}`;

  return (
    <button
      type="button"
      className={classes.join(' ')}
      style={style}
      onClick={onClick}
      disabled={!onClick}
      aria-label={`${name}${ability ? ` (${ABILITY_INFO[ability].label})` : ''}`}
      aria-pressed={selected}
    >
      <span className="corner tl">
        <span className="rank">{joker ? 'J' : card.rank}</span>
        <span className="suit">{sym}</span>
      </span>
      <span className="pip">{joker ? '🃏' : sym}</span>
      {ability && (
        <span className="ability" title={ABILITY_INFO[ability].label}>
          {ABILITY_INFO[ability].icon}
        </span>
      )}
      <span className="corner br">
        <span className="rank">{joker ? 'J' : card.rank}</span>
        <span className="suit">{sym}</span>
      </span>
    </button>
  );
}
