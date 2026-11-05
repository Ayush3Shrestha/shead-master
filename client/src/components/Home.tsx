import { useEffect, useState } from 'react';
import { defaultSettings, RANKED_STAKES, type GameSettings, type PublicRoomSummary, type UserProfile } from '@shead/shared';
import { net } from '../net';
import { HowToPlay } from './HowToPlay';
import { SettingsForm } from './SettingsForm';

type View = 'menu' | 'online' | 'create' | 'join' | 'rules' | 'settings' | 'leaders';

export function Home({ profile }: { profile: UserProfile }) {
  const [view, setView] = useState<View>('menu');
  const back = () => setView('menu');

  return (
    <div className="home">
      <header className="home-head">
        <div className="logo">
          <span className="logo-cards">🂡</span>
          <div>
            <h1>Shithead</h1>
            <p className="tag">Don't be the last one holding cards.</p>
          </div>
        </div>
        <Wallet profile={profile} />
      </header>

      {view === 'menu' && (
        <nav className="menu">
          <button className="big primary" onClick={() => setView('online')}>
            <span className="ico">🌍</span> Play Online <small>Quick play · Ranked · Open tables</small>
          </button>
          <button className="big" onClick={() => setView('create')}>
            <span className="ico">🎉</span> Create Party <small>Private table for friends</small>
          </button>
          <button className="big" onClick={() => setView('join')}>
            <span className="ico">🔑</span> Join Party <small>Enter a table code</small>
          </button>
          <div className="menu-row">
            <button onClick={() => setView('rules')}>📖 How to Play</button>
            <button onClick={() => setView('leaders')}>🏆 Leaderboard</button>
            <button onClick={() => setView('settings')}>⚙️ Settings</button>
          </div>
          <Stats profile={profile} />
        </nav>
      )}
      {view === 'online' && <PlayOnline profile={profile} onBack={back} />}
      {view === 'create' && <CreateParty profile={profile} onBack={back} />}
      {view === 'join' && <JoinParty onBack={back} />}
      {view === 'rules' && (
        <Panel title="How to Play" onBack={back}>
          <HowToPlay settings={defaultSettings()} />
        </Panel>
      )}
      {view === 'settings' && <ProfileSettings profile={profile} onBack={back} />}
      {view === 'leaders' && <Leaderboard onBack={back} />}
    </div>
  );
}

function Panel({ title, onBack, children }: { title: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <button className="ghost" onClick={onBack} aria-label="Back">
          ←
        </button>
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Wallet({ profile }: { profile: UserProfile }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const canClaim = now >= profile.nextDailyAt;
  return (
    <div className="wallet">
      <div className="who">
        <span className="avatar">{profile.name.slice(0, 1).toUpperCase()}</span>
        <span>{profile.name}</span>
      </div>
      <div className="tokens" title="Tokens — bet them in ranked games">
        🪙 {profile.tokens.toLocaleString()}
      </div>
      {canClaim && (
        <button
          className="daily"
          onClick={() =>
            net
              .claimDaily()
              .then(() => net.toast('+200 daily tokens!'))
              .catch((e) => net.toast(e.message, 'error'))
          }
        >
          🎁 Daily +200
        </button>
      )}
    </div>
  );
}

function Stats({ profile }: { profile: UserProfile }) {
  const s = profile.stats;
  return (
    <div className="stats">
      <div>
        <b>{s.games}</b>
        <span>games</span>
      </div>
      <div>
        <b>{s.wins}</b>
        <span>1st place</span>
      </div>
      <div>
        <b>{s.shitheads}</b>
        <span>💩 times</span>
      </div>
      <div>
        <b>{s.rankedWins}</b>
        <span>ranked wins</span>
      </div>
    </div>
  );
}

function PlayOnline({ profile, onBack }: { profile: UserProfile; onBack: () => void }) {
  const [stake, setStake] = useState<number>(RANKED_STAKES[1]);
  const [rooms, setRooms] = useState<PublicRoomSummary[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => net.listRooms().then((r) => alive && setRooms(r));
    load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <Panel title="Play Online" onBack={onBack}>
      <div className="mode-cards">
        <div className="mode-card">
          <h3>🃏 Classic</h3>
          <p>Casual game with the standard rules. Starts as soon as 2+ players are matched.</p>
          <button className="primary" onClick={() => net.quickPlay('classic')}>
            Quick Play
          </button>
        </div>
        <div className="mode-card ranked">
          <h3>🏆 Ranked</h3>
          <p>
            Everyone bets the stake. <b>First player out wins the whole pot.</b>
          </p>
          <div className="chips">
            {RANKED_STAKES.map((v) => (
              <button key={v} className={stake === v ? 'on' : ''} disabled={profile.tokens < v} onClick={() => setStake(v)}>
                🪙 {v}
              </button>
            ))}
          </div>
          <button className="gold" disabled={profile.tokens < stake} onClick={() => net.quickPlay('ranked', stake)}>
            Find ranked match · 🪙 {stake}
          </button>
        </div>
      </div>

      <h3 className="sub">Open tables</h3>
      {rooms === null ? (
        <p className="muted">Loading…</p>
      ) : rooms.length === 0 ? (
        <p className="muted">No open tables right now — start a quick play and others will join you.</p>
      ) : (
        <ul className="room-list">
          {rooms.map((r) => (
            <li key={r.code}>
              <div>
                <b>{r.name}</b>
                <span className="muted">
                  {' '}
                  · {r.mode === 'ranked' ? `🏆 ${r.stake} 🪙` : '🃏 Classic'} · {r.players}/{r.maxPlayers}
                </span>
              </div>
              <button onClick={() => net.joinRoom(r.code)}>Join</button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function CreateParty({ profile, onBack }: { profile: UserProfile; onBack: () => void }) {
  const [settings, setSettings] = useState<GameSettings>(() => defaultSettings());
  const [busy, setBusy] = useState(false);
  return (
    <Panel title="Create Party" onBack={onBack}>
      <SettingsForm value={settings} onChange={setSettings} tokens={profile.tokens} />
      <button
        className="primary wide sticky-cta"
        disabled={busy || (settings.mode === 'ranked' && profile.tokens < settings.stake)}
        onClick={async () => {
          setBusy(true);
          await net.createRoom(settings);
          setBusy(false);
        }}
      >
        Create table
      </button>
    </Panel>
  );
}

function JoinParty({ onBack }: { onBack: () => void }) {
  const [code, setCode] = useState('');
  return (
    <Panel title="Join Party" onBack={onBack}>
      <form
        className="join-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) net.joinRoom(code.trim());
        }}
      >
        <input
          className="code-input"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5))}
          placeholder="CODE"
          autoFocus
          autoCapitalize="characters"
          autoComplete="off"
          aria-label="Table code"
        />
        <button className="primary wide" disabled={code.length < 5}>
          Join table
        </button>
      </form>
      <p className="muted center">Ask the host for the 5-letter code, or open their invite link.</p>
    </Panel>
  );
}

function ProfileSettings({ profile, onBack }: { profile: UserProfile; onBack: () => void }) {
  const [name, setName] = useState(profile.name);
  return (
    <Panel title="Settings" onBack={onBack}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          net
            .rename(name)
            .then(() => net.toast('Name saved'))
            .catch((err) => net.toast(err.message, 'error'));
        }}
      >
        <label className="field">
          <span>Display name</span>
          <input value={name} maxLength={16} onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="primary">Save</button>
      </form>
      <p className="muted small">
        You're playing as a guest. Your account lives in this browser — signing out or clearing site data loses your tokens.
      </p>
      <button
        className="danger"
        onClick={() => {
          if (confirm('Sign out? Your guest account and tokens cannot be recovered.')) net.signOut();
        }}
      >
        Sign out
      </button>
    </Panel>
  );
}

function Leaderboard({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof net.leaderboard>> | null>(null);
  useEffect(() => {
    net.leaderboard().then(setRows).catch(() => setRows([]));
  }, []);
  return (
    <Panel title="Leaderboard" onBack={onBack}>
      {!rows ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">Nobody has finished a game yet. Be the first!</p>
      ) : (
        <ol className="leaders">
          {rows.map((r, i) => (
            <li key={i}>
              <span className="pos">{i + 1}</span>
              <span className="name">{r.name}</span>
              <span className="muted small">
                {r.wins}/{r.games} wins
              </span>
              <span className="tok">🪙 {r.tokens.toLocaleString()}</span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
