import type { GameResult, RoomView, UserProfile } from '@shead/shared';
import { net } from '../net';

const MEDALS = ['', '🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

export function Results({ room, result, profile }: { room: RoomView; result: GameResult; profile: UserProfile }) {
  const canReset = room.hostId === profile.id || room.quickPlay;
  const mins = Math.floor(result.durationMs / 60000);
  const secs = Math.floor((result.durationMs % 60000) / 1000);
  const shithead = result.rankings.find((r) => r.userId === result.shitheadId);
  const iWon = result.rankings[0]?.userId === profile.id;
  const iLost = result.shitheadId === profile.id;

  const share = async () => {
    const lines = result.rankings.map((r) => `${r.userId === result.shitheadId ? '💩' : MEDALS[r.place]} ${r.name}`);
    const text = `Shithead results:\n${lines.join('\n')}`;
    try {
      if (navigator.share) return await navigator.share({ title: 'Shithead results', text });
    } catch {
      /* fall through */
    }
    navigator.clipboard?.writeText(text).then(() => net.toast('Results copied'), () => {});
  };

  return (
    <div className="modal results">
      <div className="modal-body">
        <div className="results-hero">
          {iWon ? '🏆' : iLost ? '💩' : '🏁'}
          <h2>{iWon ? 'You went out first!' : iLost ? "You're the Shithead!" : 'Game over'}</h2>
          {shithead && !iLost && (
            <p>
              <b>{shithead.name}</b> is the Shithead 💩
            </p>
          )}
        </div>

        {result.payout && (
          <div className="payout">
            {result.payout.winnerId === profile.id ? (
              <>
                You won the pot: <b>+🪙 {result.payout.pot}</b>
              </>
            ) : (
              <>
                {result.rankings.find((r) => r.userId === result.payout!.winnerId)?.name ?? 'The winner'} took the pot of <b>🪙 {result.payout.pot}</b>
              </>
            )}
          </div>
        )}

        <ol className="rankings">
          {result.rankings.map((r) => (
            <li key={r.userId} className={`${r.userId === profile.id ? 'me' : ''} ${r.userId === result.shitheadId ? 'loser' : ''}`}>
              <span className="medal">{r.userId === result.shitheadId ? '💩' : MEDALS[r.place]}</span>
              <span className="name">{r.name}</span>
              <span className="muted small">{r.userId === result.shitheadId ? `${r.cardsLeft} cards left` : `finished ${r.place}`}</span>
            </li>
          ))}
        </ol>
        <p className="muted small center">
          Game length {mins}m {secs.toString().padStart(2, '0')}s
        </p>

        <div className="btn-col">
          {canReset ? (
            <button className="primary wide" onClick={() => net.reset()}>
              🔁 Play again
            </button>
          ) : (
            <p className="muted center small">Waiting for the host to start another round…</p>
          )}
          <div className="btn-row">
            <button onClick={share}>📤 Share</button>
            <button onClick={() => net.leave()}>🏠 Main menu</button>
          </div>
        </div>
      </div>
    </div>
  );
}
