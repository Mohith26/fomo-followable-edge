// Downloads 1-minute OHLCV (USD, base token) for every pool in data/pools.json over the replay window
// 2026-11-03 00:00 UTC to 2026-11-10 00:00 UTC from GeckoTerminal's public API. Resumable.
// Output: data/raw/<SYMBOL>.json = [[unixSec, o, h, l, c, volUsd], ...] ascending.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
const H = { Accept: 'application/json;version=20230302' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const WINDOW = { start: Date.UTC(2026, 10, 3) / 1000, end: Date.UTC(2026, 10, 10) / 1000 };
async function get(url) {
  for (let i = 0; i < 12; i++) {
    const r = await fetch(url, { headers: H });
    if (r.status === 429) { await sleep(12000); continue; }
    if (!r.ok) throw new Error(r.status + ' ' + url);
    return r.json();
  }
  throw new Error('rate limited ' + url);
}
mkdirSync('data/raw', { recursive: true });
const { pools } = JSON.parse(readFileSync('data/pools.json', 'utf8'));
for (const p of pools) {
  const f = `data/raw/${p.symbol}.json`;
  if (existsSync(f)) continue;
  const rows = new Map();
  let before = WINDOW.end;
  while (before > WINDOW.start) {
    const d = await get(`https://api.geckoterminal.com/api/v2/networks/${p.network}/pools/${p.pool}/ohlcv/minute?aggregate=1&limit=1000&currency=usd&token=base&before_timestamp=${before}`);
    const list = d.data.attributes.ohlcv_list;
    if (!list.length) break;
    for (const r of list) if (r[0] >= WINDOW.start && r[0] < WINDOW.end) rows.set(r[0], r);
    const minT = Math.min(...list.map((r) => r[0]));
    if (minT >= before) break;
    before = minT;
    await sleep(2300);
  }
  const arr = [...rows.values()].sort((a, b) => a[0] - b[0]);
  writeFileSync(f, JSON.stringify(arr));
  console.log(p.symbol, arr.length, 'candles');
}
