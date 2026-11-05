import { useEffect, useRef, useState } from 'react';
import { net, useNet } from './net';
import { GameTable } from './components/Game';
import { Home } from './components/Home';
import { Lobby } from './components/Lobby';

function pendingJoinCode(): string | null {
  const code = new URLSearchParams(location.search).get('join');
  return code && /^[A-Za-z0-9]{5}$/.test(code) ? code.toUpperCase() : null;
}

export function App() {
  const snap = useNet();
  const { profile, state, connected, ready } = snap;
  const joinCode = useRef(pendingJoinCode());

  useEffect(() => {
    net.init();
  }, []);

  // Follow an invite link once we're connected.
  useEffect(() => {
    if (!connected || !joinCode.current) return;
    const code = joinCode.current;
    joinCode.current = null;
    history.replaceState(null, '', location.pathname);
    if (state.room?.code !== code) net.joinRoom(code);
  }, [connected, state.room?.code]);

  let body: React.ReactNode;
  if (!ready) body = <Splash />;
  else if (!profile) body = <Welcome invited={!!joinCode.current} />;
  else if (!state.room) body = <Home profile={profile} />;
  else if (state.room.status === 'WAITING' || !state.game) body = <Lobby room={state.room} profile={profile} />;
  else body = <GameTable room={state.room} game={state.game} profile={profile} />;

  return (
    <div className="app">
      {body}
      {profile && !connected && <div className="offline-bar">Reconnecting…</div>}
      <div className="toasts" aria-live="assertive">
        {snap.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function Splash() {
  return (
    <div className="splash">
      <span className="logo-cards big">🂡</span>
    </div>
  );
}

function Welcome({ invited }: { invited: boolean }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="welcome">
      <div className="logo stacked">
        <span className="logo-cards big">🂡</span>
        <h1>Shithead</h1>
        <p className="tag">The card game where losing is legendary.</p>
      </div>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await net.signUp(name);
          } catch (err) {
            setError((err as Error).message);
          }
          setBusy(false);
        }}
      >
        <label className="field">
          <span>{invited ? "You've been invited! Pick a name to join the table" : 'Pick a name to start playing'}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={16} placeholder="Your name" autoFocus />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary wide" disabled={busy || !name.trim()}>
          {invited ? 'Join table' : 'Play'}
        </button>
        <p className="muted small center">No sign-up needed. You start with 🪙 1,000 tokens for ranked games.</p>
      </form>
    </div>
  );
}
