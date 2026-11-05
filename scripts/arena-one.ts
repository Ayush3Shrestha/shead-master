import { arena } from './bot-arena.js';
const [n, ...lv] = process.argv.slice(2);
const t = Date.now();
console.log(lv.join(' vs '), JSON.stringify(arena(lv as any, Number(n), Number(process.env.SEED ?? 7))), `${Date.now() - t}ms`);
