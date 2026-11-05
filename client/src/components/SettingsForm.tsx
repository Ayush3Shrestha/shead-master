import {
  ABILITIES,
  ABILITY_INFO,
  NORMAL_RANKS,
  RANKED_STAKES,
  sanitizeSettings,
  TURN_TIMERS,
  type Ability,
  type GameSettings,
  type NormalRank,
} from '@shead/shared';

interface Props {
  value: GameSettings;
  onChange?: (s: GameSettings) => void; // omitted = read-only
  tokens?: number;
  /** Single-player: only the house rules (no mode, seats, visibility or spectators). */
  solo?: boolean;
}

export function SettingsForm({ value: s, onChange, tokens, solo }: Props) {
  const ro = !onChange;
  const ranked = s.mode === 'ranked';
  const set = (patch: Partial<GameSettings>) => onChange?.(sanitizeSettings({ ...s, ...patch }));
  const setRank = (ab: Ability, rank: NormalRank | null) => {
    const specialRanks = { ...s.specialRanks };
    // A rank can hold only one ability: steal it from whoever had it.
    for (const other of ABILITIES) if (rank && specialRanks[other] === rank) specialRanks[other] = null;
    specialRanks[ab] = rank;
    set({ specialRanks });
  };

  return (
    <div className={`settings ${ro ? 'readonly' : ''}`}>
      {!solo && (
      <div className="seg" role="radiogroup" aria-label="Mode">
        {(['classic', 'ranked'] as const).map((m) => (
          <button key={m} type="button" className={s.mode === m ? 'on' : ''} disabled={ro} onClick={() => set({ mode: m, stake: m === 'ranked' ? 50 : 0 })}>
            {m === 'classic' ? '🃏 Classic' : '🏆 Ranked'}
          </button>
        ))}
      </div>
      )}
      {ranked && (
        <div className="hint">
          Each player bets the stake. <b>The first player to go out takes the whole pot.</b> Ranked tables use the standard rules and no bots.
        </div>
      )}

      {ranked && (
        <Row label="Stake (tokens each)">
          <div className="chips">
            {RANKED_STAKES.map((v) => (
              <button key={v} type="button" className={s.stake === v ? 'on' : ''} disabled={ro || (tokens !== undefined && tokens < v)} onClick={() => set({ stake: v })}>
                🪙 {v}
              </button>
            ))}
          </div>
        </Row>
      )}

      {!solo && (
      <Row label="Max players">
        <div className="chips">
          {[2, 3, 4, 5].map((n) => (
            <button key={n} type="button" className={s.maxPlayers === n ? 'on' : ''} disabled={ro} onClick={() => set({ maxPlayers: n })}>
              {n}
            </button>
          ))}
        </div>
      </Row>

      )}

      {!solo && (
      <Row label="Visibility">
        <div className="chips">
          {(['private', 'public'] as const).map((v) => (
            <button key={v} type="button" className={s.visibility === v ? 'on' : ''} disabled={ro} onClick={() => set({ visibility: v })}>
              {v === 'private' ? '🔒 Private' : '🌍 Public'}
            </button>
          ))}
        </div>
      </Row>
      )}

      {!ranked && (
        <Row label="Turn timer">
          <div className="chips">
            {TURN_TIMERS.map((t) => (
              <button key={t} type="button" className={s.turnTimer === t ? 'on' : ''} disabled={ro} onClick={() => set({ turnTimer: t })}>
                {t === 0 ? 'Off' : `${t}s`}
              </button>
            ))}
          </div>
        </Row>
      )}

      {!ranked && (
        <>
          <Toggle label="Special cards" checked={s.specialsEnabled} disabled={ro} onChange={(v) => set({ specialsEnabled: v })} />
          {s.specialsEnabled && (
            <div className="specials">
              {ABILITIES.map((ab) => (
                <label key={ab} className="special-row">
                  <span className="sp-name">
                    <span className="sp-icon">{ABILITY_INFO[ab].icon}</span> {ABILITY_INFO[ab].label}
                  </span>
                  <select
                    value={s.specialRanks[ab] ?? ''}
                    disabled={ro}
                    onChange={(e) => setRank(ab, (e.target.value || null) as NormalRank | null)}
                    aria-label={`${ABILITY_INFO[ab].label} rank`}
                  >
                    <option value="">Off</option>
                    {NORMAL_RANKS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}
          <Toggle label="Four-of-a-kind burns the pile" checked={s.fourOfAKindBurn} disabled={ro} onChange={(v) => set({ fourOfAKindBurn: v })} />
          <Toggle label="Skip stacking (two 8s skip two players)" checked={s.skipStacking} disabled={ro} onChange={(v) => set({ skipStacking: v })} />
          <Toggle label="Voluntary pickup" checked={s.voluntaryPickup} disabled={ro} onChange={(v) => set({ voluntaryPickup: v })} />
          <Toggle label="Jokers (2 wild cards)" checked={s.jokers} disabled={ro} onChange={(v) => set({ jokers: v })} />
          {s.jokers && (
            <Row label="Joker power">
              <select value={s.jokerAbility} disabled={ro} onChange={(e) => set({ jokerAbility: e.target.value as Ability })}>
                {ABILITIES.map((ab) => (
                  <option key={ab} value={ab}>
                    {ABILITY_INFO[ab].icon} {ABILITY_INFO[ab].label}
                  </option>
                ))}
              </select>
            </Row>
          )}
          <Row label="Hand size">
            <div className="chips">
              {[3, 4].map((n) => (
                <button key={n} type="button" className={s.handSize === n ? 'on' : ''} disabled={ro} onClick={() => set({ handSize: n })}>
                  {n}
                </button>
              ))}
            </div>
          </Row>
        </>
      )}
      {!solo && <Toggle label="Allow spectators" checked={s.allowSpectators} disabled={ro} onChange={(v) => set({ allowSpectators: v })} />}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      {children}
    </div>
  );
}

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <span>{label}</span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" aria-hidden />
    </label>
  );
}

export function rulesSummary(s: GameSettings): string[] {
  const out: string[] = [];
  if (s.specialsEnabled) {
    for (const ab of ABILITIES) if (s.specialRanks[ab]) out.push(`${s.specialRanks[ab]} = ${ABILITY_INFO[ab].icon} ${ABILITY_INFO[ab].label}`);
  } else out.push('No special cards');
  if (s.jokers) out.push(`Jokers = ${ABILITY_INFO[s.jokerAbility].label}`);
  if (s.fourOfAKindBurn) out.push('4-of-a-kind burns');
  if (s.skipStacking) out.push('Skips stack');
  if (s.voluntaryPickup) out.push('Voluntary pickup');
  out.push(s.turnTimer ? `${s.turnTimer}s turns` : 'No timer');
  return out;
}
