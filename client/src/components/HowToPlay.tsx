import { ABILITIES, ABILITY_INFO, type GameSettings } from '@shead/shared';

export function HowToPlay({ settings: s }: { settings: GameSettings }) {
  return (
    <div className="rules">
      <p>
        <b>Goal:</b> get rid of all your cards. The last player still holding cards is the <b>Shithead</b> 💩.
      </p>
      <h4>Setup</h4>
      <p>
        Everyone gets 3 face-down cards, 3 face-up cards on top of them and {s.handSize} in hand. Before play starts you may swap cards between your
        hand and your face-up row — tap a hand card, then a face-up card. Press <b>Ready</b> when happy.
      </p>
      <h4>Your turn</h4>
      <ul>
        <li>Play a card of <b>equal or higher</b> rank than the pile (4 low … A high).</li>
        <li>You can play several cards of the <b>same rank</b> at once.</li>
        <li>Draw back up to {s.handSize} cards while the deck lasts.</li>
        <li>Can't play? <b>Pick up the whole pile</b> and the turn passes.</li>
      </ul>
      {s.specialsEnabled && (
        <>
          <h4>Special cards</h4>
          <ul className="sp-list">
            {ABILITIES.filter((ab) => s.specialRanks[ab]).map((ab) => (
              <li key={ab}>
                <span className="sp-badge">{s.specialRanks[ab]}</span>
                <b>
                  {ABILITY_INFO[ab].icon} {ABILITY_INFO[ab].label}
                </b>{' '}
                — {ABILITY_INFO[ab].description}
              </li>
            ))}
            {s.fourOfAKindBurn && (
              <li>
                <span className="sp-badge">4×</span>
                <b>🔥 Four of a kind</b> — four cards of the same rank in a row (by anyone) burn the pile; whoever completed it goes again.
              </li>
            )}
            {s.jokers && (
              <li>
                <span className="sp-badge">🃏</span>
                <b>Joker</b> — wild, acts as {ABILITY_INFO[s.jokerAbility].label}.
              </li>
            )}
          </ul>
        </>
      )}
      <h4>Table cards</h4>
      <ul>
        <li>When your hand is empty and the deck is gone, play from your <b>face-up</b> cards.</li>
        <li>
          Then flip your <b>face-down</b> cards blind, one per turn. If it can't be played, you pick up the pile <i>and</i> that card.
        </li>
        <li>If you pick up, you must empty your hand again before going back to your table cards.</li>
      </ul>
      <h4>Modes</h4>
      <ul>
        <li>
          <b>🃏 Classic</b> — just for fun; hosts can customise every house rule.
        </li>
        <li>
          <b>🏆 Ranked</b> — every player bets the same token stake. The <b>first player to go out takes the whole pot</b>. Standard rules, no bots, 30s
          turns. Tokens are play money with no cash value; claim free tokens daily.
        </li>
      </ul>
    </div>
  );
}
