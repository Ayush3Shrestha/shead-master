import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ABILITY_INFO,
  abilityOf,
  BOT_LEVEL_INFO,
  describeEvent,
  type Card as CardT,
  type GameEvent,
  type GameView,
  type PublicPlayerView,
  type RoomView,
  type UserProfile,
} from '@shead/shared';
import { net } from '../net';
import { Card } from './Card';
import { HowToPlay } from './HowToPlay';
import { useNow } from './Lobby';
import { Results } from './Results';

interface Flash {
  key: number;
  text: string;
  kind: 'burn' | 'skip' | 'reverse' | 'pickup' | 'finish' | 'info';
}

export function GameTable({ room, game, profile }: { room: RoomView; game: GameView; profile: UserProfile }) {
  const me = game.me;
  const s = game.settings;
  const now = useNow();
  const nameOf = (id?: string) => (id === profile.id ? 'You' : (game.players.find((p) => p.id === id)?.name ?? 'Someone'));
  const memberOf = (id: string) => room.members.find((m) => m.userId === id);
  const myPlayer = game.players.find((p) => p.id === profile.id);
  const current = game.players.find((p) => p.id === game.currentPlayerId);

  // ── selection ──
  const [selected, setSelected] = useState<string[]>([]);
  const [swapPick, setSwapPick] = useState<{ from: 'hand' | 'faceUp'; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showRules, setShowRules] = useState(false);
  useEffect(() => {
    setSelected([]);
    if (game.status !== 'SETUP') setSwapPick(null);
  }, [game.version, game.status]);

  // ── effects for new events ──
  const [flash, setFlash] = useState<Flash | null>(null);
  const [burning, setBurning] = useState(false);
  const lastSeq = useRef<number>(game.log.at(-1)?.seq ?? 0);
  useEffect(() => {
    const fresh = game.log.filter((e) => (e.seq ?? 0) > lastSeq.current);
    if (!fresh.length) return;
    lastSeq.current = fresh.at(-1)!.seq ?? lastSeq.current;
    const pick = pickFlash(fresh, nameOf);
    if (pick) {
      setFlash({ ...pick, key: Date.now() });
      if (pick.kind === 'burn') {
        setBurning(true);
        setTimeout(() => setBurning(false), 900);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.log]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [flash]);
  const wasMyTurn = useRef(false);
  useEffect(() => {
    if (me?.isMyTurn && !wasMyTurn.current) navigator.vibrate?.(60);
    wasMyTurn.current = !!me?.isMyTurn;
  }, [me?.isMyTurn]);

  // ── derived ──
  const playable = useMemo(() => new Set(me?.playableIds ?? []), [me?.playableIds]);
  const myTurn = !!me?.isMyTurn && game.status === 'PLAYING';
  const source: CardT[] = me?.zone === 'hand' ? me.hand : me?.zone === 'faceUp' ? (myPlayer?.faceUp ?? []) : [];
  const selectedCards = source.filter((c) => selected.includes(c.id));
  const secondsLeft = room.deadline ? Math.max(0, Math.ceil((room.deadline - now) / 1000)) : null;
  const opponents = orderOpponents(game.players, profile.id);

  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    await fn();
    setBusy(false);
  };

  const tapZoneCard = (c: CardT, from: 'hand' | 'faceUp') => {
    if (game.status === 'SETUP') {
      if (myPlayer?.setupReady) return net.toast('Press "Change cards" to swap again');
      if (!swapPick || swapPick.from === from) return setSwapPick(swapPick?.id === c.id ? null : { from, id: c.id });
      const handCardId = from === 'hand' ? c.id : swapPick.id;
      const faceUpCardId = from === 'faceUp' ? c.id : swapPick.id;
      setSwapPick(null);
      act(() => net.act({ type: 'swap', handCardId, faceUpCardId }));
      return;
    }
    if (!myTurn || me?.zone !== from) return;
    if (!playable.has(c.id)) return net.toast(from === 'faceUp' ? "That card can't go on the pile" : `Too low — play ${game.requiredRank ?? 'any'} or higher`);
    const sameRank = selectedCards.length && selectedCards[0].rank === c.rank;
    if (!sameRank) return setSelected([c.id]);
    setSelected(selected.includes(c.id) ? selected.filter((x) => x !== c.id) : [...selected, c.id]);
  };

  const selectAllOfRank = (c: CardT) => {
    if (!myTurn || !playable.has(c.id)) return;
    setSelected(source.filter((x) => x.rank === c.rank).map((x) => x.id));
  };

  const play = () => {
    if (!selected.length) return;
    act(() => net.act({ type: 'play', cardIds: selected }));
  };
  const pickup = () => act(() => net.act({ type: 'pickup' }));
  const flip = (index: number) => {
    if (!myTurn || me?.zone !== 'faceDown') return;
    act(() => net.act({ type: 'playFaceDown', index }));
  };

  const leave = () => {
    const msg =
      room.status === 'FINISHED'
        ? null
        : room.solo
          ? 'Leave this game against the CPU?'
          : s.mode === 'ranked'
          ? `Leave the game? You forfeit your ${s.stake}-token stake and a bot plays your cards.`
          : 'Leave the game? A bot will take over your cards.';
    if (!msg || confirm(msg)) net.leave();
  };

  const topCards = game.discard.slice(-4);
  const top = game.discard.at(-1);
  const topAbility = top ? abilityOf(top.rank, s) : null;

  let status: string;
  if (game.status === 'SETUP') {
    status = myPlayer?.setupReady
      ? `Waiting for ${game.players.filter((p) => !p.setupReady).length} player(s) to arrange their cards…`
      : 'Swap cards: tap a hand card, then a face-up card. Strong cards face-up!';
  } else if (game.status === 'FINISHED') status = 'Game over';
  else if (myTurn) {
    if (me!.zone === 'faceDown') status = 'Your turn — flip one of your face-down cards!';
    else if (me!.mustPickup) status = "Your turn — you can't beat the pile. Pick it up.";
    else status = me!.zone === 'faceUp' ? 'Your turn — play from your face-up cards' : 'Your turn';
  } else if (myPlayer?.place) status = `You finished ${ordinalText(myPlayer.place)}! Watching the rest…`;
  else status = `${current?.name ?? '…'}'s turn`;

  return (
    <div className={`table ${myTurn ? 'my-turn' : ''}`}>
      <header className="topbar">
        <button className="ghost small" onClick={leave}>
          ← {room.youAreSpectator ? 'Stop watching' : 'Leave'}
        </button>
        <div className="topbar-mid">
          <span className={`mode-pill ${s.mode === 'ranked' ? 'ranked' : ''}`}>{s.mode === 'ranked' ? `🏆 Pot 🪙 ${room.pot}` : `🃏 ${room.code}`}</span>
          <span className={`dir ${game.direction === 1 ? 'cw' : 'ccw'}`} title={game.direction === 1 ? 'Clockwise' : 'Anti-clockwise'}>
            {game.direction === 1 ? '↻' : '↺'}
          </span>
        </div>
        <div className="topbar-right">
          <button className="ghost small" onClick={() => setShowRules(true)} aria-label="Rules">
            ?
          </button>
          <button className="ghost small" onClick={() => setShowLog((v) => !v)} aria-label="History">
            ☰
          </button>
        </div>
      </header>

      <section className="opponents" aria-label="Opponents">
        {opponents.map((p) => (
          <Opponent
            key={p.id}
            p={p}
            settings={s}
            active={p.id === game.currentPlayerId}
            seconds={p.id === game.currentPlayerId ? secondsLeft : null}
            member={memberOf(p.id)}
            setup={game.status === 'SETUP'}
            shithead={game.shitheadId === p.id}
          />
        ))}
      </section>

      <section className="board">
        <div className="pile draw" aria-label={`Draw pile, ${game.drawCount} cards`}>
          {game.drawCount > 0 ? <Card size="md" /> : <div className="slot">Empty</div>}
          <span className="pile-count">{game.drawCount} left</span>
        </div>
        <div className={`pile discard ${burning ? 'burning' : ''}`} aria-label={`Discard pile, ${game.discard.length} cards`}>
          {topCards.length === 0 ? (
            <div className="slot">{game.burnedCount ? '🔥' : 'Pile'}</div>
          ) : (
            topCards.map((c, i) => (
              <Card
                key={c.id}
                card={c}
                settings={s}
                size="md"
                className={i === topCards.length - 1 ? 'top-card' : 'under'}
                style={{ transform: `translate(${(i - topCards.length + 1) * 6}px, ${(i - topCards.length + 1) * -2}px) rotate(${((c.id.charCodeAt(0) + c.id.charCodeAt(1)) % 17) - 8}deg)` }}
              />
            ))
          )}
          <span className="pile-count">
            {game.discard.length} in pile{game.burnedCount ? ` · ${game.burnedCount} burned` : ''}
          </span>
        </div>
        <div className="requirement">
          {game.status === 'PLAYING' &&
            (game.requiredRank ? (
              <>
                Play <b>{game.requiredRank}</b> or higher
              </>
            ) : (
              <>
                <b>Any card</b>
              </>
            ))}
          {topAbility && topAbility !== 'burn' && <span className="ability-tag">{ABILITY_INFO[topAbility].icon} {ABILITY_INFO[topAbility].label}</span>}
        </div>
        {flash && (
          <div key={flash.key} className={`flash flash-${flash.kind}`}>
            {flash.text}
          </div>
        )}
      </section>

      <div className={`status-bar ${myTurn ? 'go' : ''}`}>
        <span>{status}</span>
        {secondsLeft !== null && (myTurn || game.status === 'SETUP') && <span className={`timer ${secondsLeft <= 5 ? 'low' : ''}`}>⏱ {secondsLeft}s</span>}
      </div>

      {me && myPlayer ? (
        <section className="mine" aria-label="Your cards">
          <div className="my-table">
            {Array.from({ length: Math.max(3, myPlayer.faceDownCount, myPlayer.faceUp.length) }).map((_, i) => {
              const up = myPlayer.faceUp[i];
              const hasDown = i < myPlayer.faceDownCount;
              const canFlip = myTurn && me.zone === 'faceDown' && hasDown;
              return (
                <div key={i} className="stack-slot">
                  {hasDown ? (
                    <Card size="md" className={`down ${canFlip ? 'pulse' : ''}`} onClick={canFlip ? () => flip(i) : undefined} label={`Face-down card ${i + 1}`} />
                  ) : (
                    <div className="slot ghost-slot" />
                  )}
                  {up && (
                    <Card
                      card={up}
                      settings={s}
                      size="md"
                      className="up"
                      selected={selected.includes(up.id) || swapPick?.id === up.id}
                      playable={myTurn && me.zone === 'faceUp' && playable.has(up.id)}
                      dimmed={myTurn && me.zone === 'faceUp' && !playable.has(up.id)}
                      onClick={game.status === 'SETUP' || (myTurn && me.zone === 'faceUp') ? () => tapZoneCard(up, 'faceUp') : undefined}
                    />
                  )}
                </div>
              );
            })}
          </div>

          <div className={`hand ${me.hand.length > 6 ? 'crowded' : ''}`} style={{ ['--n' as string]: me.hand.length }}>
            {me.hand.length === 0 && <span className="muted small">{myPlayer.place ? 'No cards left 🎉' : 'Hand empty'}</span>}
            {me.hand.map((c) => (
              <Card
                key={c.id}
                card={c}
                settings={s}
                size="lg"
                selected={selected.includes(c.id) || swapPick?.id === c.id}
                playable={myTurn && me.zone === 'hand' && playable.has(c.id)}
                dimmed={myTurn && me.zone === 'hand' && !playable.has(c.id)}
                onClick={game.status === 'SETUP' || (myTurn && me.zone === 'hand') ? () => tapZoneCard(c, 'hand') : undefined}
                className="hand-card"
              />
            ))}
          </div>

          <div className="actions">
            {game.status === 'SETUP' ? (
              <button
                className={myPlayer.setupReady ? 'wide' : 'primary wide'}
                disabled={busy}
                onClick={() => act(() => net.act({ type: 'setupReady', ready: !myPlayer.setupReady }))}
              >
                {myPlayer.setupReady ? 'Change cards' : "Ready — let's play"}
              </button>
            ) : (
              <>
                <button className="primary" disabled={!myTurn || !selected.length || busy} onClick={play}>
                  Play {selectedCards.length > 1 ? `${selectedCards.length}× ${selectedCards[0].rank}` : selectedCards[0] ? selectedCards[0].rank : ''}
                </button>
                {selectedCards.length > 0 && source.filter((x) => x.rank === selectedCards[0].rank).length > selectedCards.length && (
                  <button onClick={() => selectAllOfRank(selectedCards[0])}>+ All {selectedCards[0].rank}s</button>
                )}
                <button className={me.mustPickup ? 'danger pulse-btn' : ''} disabled={!me.canPickup || busy} onClick={pickup}>
                  Pick up ({game.discard.length})
                </button>
              </>
            )}
          </div>
        </section>
      ) : (
        <section className="mine spectating">
          <p className="muted center">👀 You're spectating. You'll get a seat when the table goes back to the lobby.</p>
        </section>
      )}

      {showLog && (
        <aside className="log" onClick={() => setShowLog(false)}>
          <h4>History</h4>
          <ol>
            {game.log
              .map((e) => ({ e, text: describeEvent(e, nameOf) }))
              .filter((x) => x.text)
              .reverse()
              .map(({ e, text }) => (
                <li key={e.seq}>{text}</li>
              ))}
          </ol>
        </aside>
      )}
      {!showLog && <LastEvents game={game} nameOf={nameOf} />}

      {showRules && (
        <div className="modal" onClick={() => setShowRules(false)}>
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            <button className="ghost close" onClick={() => setShowRules(false)} aria-label="Close">
              ✕
            </button>
            <h2>House rules</h2>
            <HowToPlay settings={s} />
          </div>
        </div>
      )}

      {room.status === 'FINISHED' && room.lastResult && <Results room={room} result={room.lastResult} profile={profile} />}
    </div>
  );
}

function LastEvents({ game, nameOf }: { game: GameView; nameOf: (id?: string) => string }) {
  const lines = game.log
    .map((e) => ({ e, text: describeEvent(e, nameOf) }))
    .filter((x) => x.text && x.e.type !== 'CARD_DRAWN')
    .slice(-2);
  return (
    <div className="ticker" aria-live="polite">
      {lines.map(({ e, text }) => (
        <div key={e.seq}>{text}</div>
      ))}
    </div>
  );
}

function Opponent({
  p,
  settings,
  active,
  seconds,
  member,
  setup,
  shithead,
}: {
  p: PublicPlayerView;
  settings: GameView['settings'];
  active: boolean;
  seconds: number | null;
  member?: RoomView['members'][number];
  setup: boolean;
  shithead: boolean;
}) {
  return (
    <div className={`opp ${active ? 'active' : ''} ${p.place ? 'out' : ''}`}>
      <div className="opp-head">
        <span className={`avatar ${member?.botLevel ? `lvl-${member.botLevel}` : ''}`} title={member?.botLevel ? `${BOT_LEVEL_INFO[member.botLevel].label} bot` : undefined}>
          {member?.botLevel ? BOT_LEVEL_INFO[member.botLevel].icon : member?.isBot ? '🤖' : p.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="opp-name">
          <b>{p.name}</b>
          <span className="muted small">
            {p.place ? (shithead ? '💩 Shithead' : `🏁 ${ordinalText(p.place)}`) : setup ? (p.setupReady ? '✓ ready' : 'arranging…') : `✋ ${p.handCount}`}
            {member && !member.connected && !member.isBot && ' · 📴'}
            {member?.away && !member.isBot && ' · 🤖 auto'}
          </span>
        </div>
        {active && seconds !== null && <span className={`opp-timer ${seconds <= 5 ? 'low' : ''}`}>{seconds}</span>}
      </div>
      <div className="opp-table">
        {Array.from({ length: Math.max(p.faceDownCount, p.faceUp.length, 0) }).map((_, i) => (
          <div key={i} className="stack-slot mini">
            {i < p.faceDownCount && <Card size="xs" className="down" />}
            {p.faceUp[i] && <Card card={p.faceUp[i]} settings={settings} size="xs" className="up" />}
          </div>
        ))}
      </div>
    </div>
  );
}

function orderOpponents(players: PublicPlayerView[], meId: string) {
  const idx = players.findIndex((p) => p.id === meId);
  if (idx < 0) return players;
  return [...players.slice(idx + 1), ...players.slice(0, idx)];
}

function ordinalText(n: number) {
  return ['', '1st', '2nd', '3rd', '4th', '5th'][n] ?? `${n}th`;
}

function pickFlash(events: GameEvent[], nameOf: (id?: string) => string): Omit<Flash, 'key'> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    switch (e.type) {
      case 'GAME_FINISHED':
        return { kind: 'finish', text: e.playerId ? `💩 ${nameOf(e.playerId)} ${nameOf(e.playerId) === 'You' ? 'are' : 'is'} the Shithead!` : 'Game over' };
      case 'PLAYER_FINISHED':
        return { kind: 'finish', text: `🏁 ${nameOf(e.playerId)} ${nameOf(e.playerId) === 'You' ? 'are' : 'is'} out!` };
      case 'PILE_BURNED':
        return { kind: 'burn', text: e.reason === 'four of a kind' ? '🔥 Four of a kind!' : '🔥 Burn!' };
      case 'PLAYER_SKIPPED':
        return { kind: 'skip', text: `⏭ ${nameOf(e.targetId)} skipped` };
      case 'DIRECTION_REVERSED':
        return { kind: 'reverse', text: '⇄ Reverse!' };
      case 'PILE_PICKED_UP':
        return { kind: 'pickup', text: `${nameOf(e.playerId)} picked up ${e.count}` };
      case 'SPECIAL_ABILITY_TRIGGERED':
        if (e.ability === 'reset') return { kind: 'info', text: '↺ Reset' };
        if (e.ability === 'invisible') return { kind: 'info', text: '👻 Invisible' };
        break;
    }
  }
  return null;
}
