import { useEffect, useState } from 'react';
import { BOT_LEVEL_INFO, BOT_LEVELS, type BotLevel, type RoomView, type UserProfile } from '@shead/shared';
import { net } from '../net';
import { SettingsForm, rulesSummary } from './SettingsForm';

export function useNow(intervalMs = 250) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function inviteLink(code: string) {
  return `${location.origin}/?join=${code}`;
}

export async function shareInvite(code: string) {
  const url = inviteLink(code);
  const text = `Join my Shithead table! Code ${code}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Shithead', text, url });
      return;
    }
  } catch {
    /* cancelled — fall back to copy */
  }
  try {
    await navigator.clipboard.writeText(url);
    net.toast('Invite link copied');
  } catch {
    net.toast(url);
  }
}

export function Lobby({ room, profile }: { room: RoomView; profile: UserProfile }) {
  const now = useNow();
  const me = room.members.find((m) => m.userId === profile.id);
  const isHost = room.hostId === profile.id;
  const ranked = room.settings.mode === 'ranked';
  const seated = room.members.length;
  const allReady = seated >= 2 && room.members.every((m) => m.ready || !m.connected);
  const [showRules, setShowRules] = useState(false);
  const [botLevel, setBotLevel] = useState<BotLevel>('normal');
  const editable = isHost && !room.quickPlay;

  return (
    <div className="lobby">
      <header className="lobby-head">
        <button className="ghost" onClick={() => net.leave()} aria-label="Leave table">
          ← Leave
        </button>
        <div className="lobby-title">
          <h2>{room.name}</h2>
          <span className={`mode-pill ${ranked ? 'ranked' : ''}`}>{ranked ? `🏆 Ranked · 🪙 ${room.settings.stake}` : '🃏 Classic'}</span>
        </div>
      </header>

      <div className="code-card">
        <span className="muted small">Table code</span>
        <div className="code">{room.code}</div>
        <div className="code-actions">
          <button
            onClick={() =>
              navigator.clipboard
                .writeText(room.code)
                .then(() => net.toast('Code copied'))
                .catch(() => {})
            }
          >
            📋 Copy code
          </button>
          <button className="primary" onClick={() => shareInvite(room.code)}>
            🔗 Invite friends
          </button>
        </div>
      </div>

      {ranked && (
        <div className="pot-banner">
          Pot if everyone plays: <b>🪙 {(room.settings.stake * Math.max(2, seated)).toLocaleString()}</b> · first player out takes it all
        </div>
      )}

      <section className="players">
        <h3>
          Players <span className="muted">{seated}/{room.settings.maxPlayers}</span>
        </h3>
        <ul>
          {room.members.map((m) => (
            <li key={m.userId} className={m.connected ? '' : 'offline'}>
              <span className="avatar">{m.isBot ? '🤖' : m.name.slice(0, 1).toUpperCase()}</span>
              <span className="pname">
                {m.name}
                {m.userId === profile.id && <span className="muted"> (you)</span>}
                {m.isHost && <span className="badge">host</span>}
                {m.isBot && m.botLevel && (
                  <span className={`badge lvl-${m.botLevel}`}>
                    {BOT_LEVEL_INFO[m.botLevel].icon} {BOT_LEVEL_INFO[m.botLevel].label}
                  </span>
                )}
                {!m.connected && <span className="badge warn">offline</span>}
              </span>
              {ranked && m.tokens !== undefined && <span className="muted small">🪙 {m.tokens}</span>}
              <span className={`ready-dot ${m.ready ? 'on' : ''}`}>{m.ready ? '✓ Ready' : 'Not ready'}</span>
              {isHost && !room.quickPlay && m.userId !== profile.id && (
                <button className="ghost small" onClick={() => net.kick(m.userId)} aria-label={`Remove ${m.name}`}>
                  ✕
                </button>
              )}
            </li>
          ))}
          {Array.from({ length: Math.max(0, room.settings.maxPlayers - seated) }).map((_, i) => (
            <li key={`empty${i}`} className="empty">
              <span className="avatar">·</span>
              <span className="pname muted">Waiting for player…</span>
            </li>
          ))}
        </ul>
        {room.spectators.length > 0 && <p className="muted small">👀 Watching: {room.spectators.map((s) => s.name).join(', ')}</p>}
      </section>

      <section className="rules-box">
        <button className="rules-toggle" onClick={() => setShowRules((v) => !v)} aria-expanded={showRules}>
          <span>{editable ? '⚙️ Game settings' : '📜 House rules'}</span>
          <span className="muted small">{showRules ? 'Hide' : rulesSummary(room.settings).slice(0, 3).join(' · ')}</span>
        </button>
        {showRules && <SettingsForm value={room.settings} onChange={editable ? (s) => net.updateSettings(s) : undefined} tokens={profile.tokens} />}
      </section>

      <footer className="lobby-actions">
        {room.autoStartAt && (
          <div className="countdown">Starting in {Math.max(0, Math.ceil((room.autoStartAt - now) / 1000))}…</div>
        )}
        {room.quickPlay && !room.autoStartAt && <div className="countdown muted">Waiting for more players…</div>}
        <div className="btn-row">
          {isHost && !ranked && !room.quickPlay && seated < room.settings.maxPlayers && (
            <div className="add-bot">
              <select value={botLevel} onChange={(e) => setBotLevel(e.target.value as BotLevel)} aria-label="Bot difficulty">
                {BOT_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {BOT_LEVEL_INFO[l].icon} {BOT_LEVEL_INFO[l].label}
                  </option>
                ))}
              </select>
              <button onClick={() => net.addBot(botLevel)}>🤖 Add bot</button>
            </div>
          )}
          <button className={me?.ready ? '' : 'primary'} onClick={() => net.ready(!me?.ready)} disabled={ranked && !me?.ready && profile.tokens < room.settings.stake}>
            {me?.ready ? 'Not ready' : ranked ? `Ready · bet 🪙 ${room.settings.stake}` : "I'm ready"}
          </button>
          {isHost && !room.quickPlay && (
            <button className="gold" disabled={!allReady} onClick={() => net.start()}>
              ▶ Start game
            </button>
          )}
        </div>
        {isHost && !room.quickPlay && !allReady && (
          <p className="muted small center">{seated < 2 ? 'Invite a friend or add a bot to start.' : 'Waiting for everyone to be ready.'}</p>
        )}
      </footer>
    </div>
  );
}
