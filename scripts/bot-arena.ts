/**
 * Pit bot levels against each other and print win/Shithead rates.
 *   npx tsx scripts/bot-arena.ts [games]
 */
import { applyAction, chooseBotAction, createGame, defaultSettings, type BotLevel } from '../shared/src/index.js';

export function arena(levels: BotLevel[], games: number, seed = 1) {
  let x = seed;
  const rng = () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const stats = levels.map(() => ({ first: 0, shithead: 0, place: 0 }));
  let played = 0;
  for (let g = 0; g < games; g++) {
    const seats = levels.map((_, i) => ({ id: `s${i}`, name: `S${i}` }));
    const st = createGame(seats, defaultSettings(), rng);
    let steps = 0;
    while (st.status !== 'FINISHED' && steps++ < 4000) {
      const actor = st.status === 'SETUP' ? st.players.find((p) => !p.setupReady)! : st.players[st.currentIdx];
      const i = Number(actor.id.slice(1));
      const a = chooseBotAction(st, actor.id, rng, levels[i])!;
      const r = applyAction(st, actor.id, a);
      if (!r.ok) throw new Error(r.error);
    }
    if (st.status !== 'FINISHED') continue;
    played++;
    for (const p of st.players) {
      const i = Number(p.id.slice(1));
      if (p.place === 1) stats[i].first++;
      if (st.shitheadId === p.id) stats[i].shithead++;
      stats[i].place += p.place!;
    }
  }
  return levels.map((lvl, i) => ({
    level: lvl,
    firstPct: +((100 * stats[i].first) / played).toFixed(1),
    shitheadPct: +((100 * stats[i].shithead) / played).toFixed(1),
    avgPlace: +(stats[i].place / played).toFixed(2),
  }));
}

if (process.argv[1]?.endsWith('bot-arena.ts')) {
  const n = Number(process.argv[2] ?? 2000);
  const t = Date.now();
  console.log('expert vs hard'); console.table(arena(['expert', 'hard'], n));
  console.log('hard vs normal'); console.table(arena(['hard', 'normal'], n));
  console.log('expert vs normal'); console.table(arena(['expert', 'normal'], n));
  console.log('3-way'); console.table(arena(['normal', 'hard', 'expert'], n));
  console.log('4p: expert vs 3 hard'); console.table(arena(['expert', 'hard', 'hard', 'hard'], n));
  console.log(`${Date.now() - t}ms`);
}
