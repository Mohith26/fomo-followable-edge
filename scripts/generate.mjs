// Builds the demo dataset: real 1-minute prices (GeckoTerminal, Nov 3-10 2026) + seeded synthetic traders,
// then precomputes the permutation tests (heavy) so the app stays fast. Everything the UI shows is derived from
// data/board.json by core/edge.js in the browser (BH, follower sims, backtest) or from these precomputed p-values.
// Run: node scripts/generate.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import {
  rng, randn, buildSeries, sampleActivity, permutationTest, benjaminiHochberg, discoveryQuality,
  leaderNetReturn, simulateFollow, DELAYS, FEE, feeRate, mean, verify, nullExpectation, backtest, nullWindow, delayedLogReturn
} from '../core/edge.js';

const SEED = +(process.env.SEED || 20261103);
const START = Date.UTC(2026, 10, 3) / 1000; // 2026-11-03 00:00 UTC
const N = 7 * 1440; // minutes
const SPLIT = 4 * 1440; // train: days 1-4, test: days 5-7
const W = 360; // null blocks of 2W = 12 h
const NTRADERS = 600;

const pools = JSON.parse(readFileSync('data/pools.json', 'utf8')).pools;
const have = new Set(readdirSync('data/raw').map((f) => f.replace('.json', '')));
const tokens = pools.filter((p) => have.has(p.symbol));
const series = {};
const depth = {};
const net = {};
for (const p of tokens) {
  const raw = JSON.parse(readFileSync(`data/raw/${p.symbol}.json`, 'utf8'));
  series[p.symbol] = buildSeries(raw, START, N);
  net[p.symbol] = p.network;
  depth[p.symbol] = p.reserve_usd; // depth proxy: deepest pool's total reserve (routing across pools usually does better)
}
const syms = tokens.map((t) => t.symbol);
const vol = syms.map((s) => series[s].v.reduce((a, b) => a + b, 0));
const wTok = vol.map((v) => v ** 0.7);
const wSum = wTok.reduce((a, b) => a + b, 0);

const R = rng(SEED);
const pickTok = () => { let x = R() * wSum; for (let i = 0; i < syms.length; i++) { x -= wTok[i]; if (x <= 0) return syms[i]; } return syms[syms.length - 1]; };
const logn = (med, sig, lo, hi) => Math.min(hi, Math.max(lo, Math.round(med * Math.exp(sig * randn(R)))));

// --- handles (synthetic) ---
const A = ['sol', 'degen', 'moon', 'based', 'chad', 'anon', 'giga', 'alpha', 'turbo', 'frog', 'pepe', 'bonk', 'wagmi', 'kek', 'ape', 'cope', 'jeet', 'mfer', 'wen', 'gm', 'ser', 'fren', 'rekt', 'pump', 'send', 'bag', 'cook', 'lfg', 'nova', 'luna', 'zen', 'echo', 'pixel', 'neon', 'ghost', 'drip', 'orbit', 'vault', 'tide', 'ember'];
const B2 = ['maxi', 'lord', 'hunter', 'trader', 'whale', 'cat', 'dog', 'king', 'queen', 'enjoyer', 'szn', 'labs', 'capital', 'sniper', 'monk', 'chef', 'pilot', 'wizard', 'ninja', 'farmer', 'scout', 'oracle', 'mint', 'flip', 'swing', 'printer', 'slayer', 'guy', 'gal', 'kid'];
const used = new Set();
function handle() {
  for (;;) {
    const s = R();
    let h = A[Math.floor(R() * A.length)] + (s < 0.5 ? B2[Math.floor(R() * B2.length)] : s < 0.75 ? '_' + B2[Math.floor(R() * B2.length)] : String(Math.floor(R() * 999)));
    if (R() < 0.25) h = h.charAt(0).toUpperCase() + h.slice(1);
    if (!used.has(h)) { used.add(h); return h; }
  }
}

// --- trader types: ground truth for the synthetic evaluation ---
const TYPES = [
  ['random', 0.52], ['chaser', 0.23], ['whale', 0.13], ['swing', 0.07], ['sniper', 0.05]
];
function pickType() { let x = R(); for (const [t, w] of TYPES) { x -= w; if (x <= 0) return t; } return 'random'; }

function fwd(s, t, h) { return Math.log(s.c[Math.min(N - 1, t + h)] / s.c[t]); }
function past(s, t, h) { return Math.log(s.c[t] / s.c[Math.max(0, t - h)]); }

function makeTrade(type) {
  const tok = pickTok();
  const s = series[tok];
  let hold;
  if (type === 'swing') hold = logn(90, 0.6, 20, 600);
  else if (type === 'sniper') hold = logn(4, 0.5, 1, 20);
  else if (type === 'whale') hold = logn(180, 1.2, 5, 4320);
  else hold = logn(55, 1.3, 2, 2880);
  const lo = 0, hi = N - hold - 5; // same feasibility bound as the null (exit + max delay inside the data)
  let entry;
  if (type === 'random' || type === 'whale') entry = sampleActivity(s.cum, lo, hi, R);
  else {
    const K = type === 'chaser' ? 6 : type === 'swing' ? 5 : 12;
    let best = -Infinity;
    // informed traders see a noisy version of the future; chasers rank by the last 30 minutes
    const cands = Array.from({ length: K }, () => sampleActivity(s.cum, lo, hi, R));
    const sd = Math.sqrt(mean(cands.map((c) => fwd(s, c, hold) ** 2))) || 1e-3;
    for (const c of cands) {
      let score;
      if (type === 'chaser') score = past(s, c, 30) + 0.3 * sd * randn(R);
      else if (type === 'swing') score = fwd(s, c, hold) + 1.2 * sd * randn(R);
      else score = fwd(s, c, 1) + 0.15 * sd * randn(R); // sniper: only the next minute
      if (score > best) { best = score; entry = c; }
    }
  }
  // traders size to liquidity: nobody market-buys more than 1% of the deepest pool's quote reserve
  const raw = type === 'whale' ? logn(7000, 0.9, 1500, 150000) : logn(350, 1.25, 15, 40000);
  const size = Math.max(15, Math.min(raw, Math.round(0.01 * depth[tok])));
  return { tok, entry, exit: entry + hold, size };
}

const traders = [];
for (let i = 0; i < NTRADERS; i++) {
  const type = pickType();
  const nT = type === 'swing' || type === 'sniper' ? logn(26, 0.45, 8, 80) : logn(13, 0.75, 2, 80);
  const trades = [];
  for (let j = 0; j < nT; j++) trades.push(makeTrade(type));
  trades.sort((a, b) => a.entry - b.entry);
  for (const t of trades) {
    const s = series[t.tok];
    t.g = {};
    for (const d of DELAYS) t.g[d] = +(s.c[Math.min(N - 1, t.exit + d)] / s.c[Math.min(N - 1, t.entry + d)]).toPrecision(6);
    t.lead = leaderNetReturn(t.g[0], t.size, depth[t.tok], feeRate(t.size, net[t.tok]));
    t.base = {};
    for (const d of DELAYS) t.base[d] = +nullExpectation(s, t.entry, t.exit - t.entry, d, W).toPrecision(6);
  }
  const pnl = trades.reduce((a, t) => a + t.size * t.lead, 0);
  traders.push({ id: i, handle: handle(), type, trades, pnl, vol: trades.reduce((a, t) => a + 2 * t.size, 0) });
}

// --- precompute permutation tests ---
const t0 = Date.now();
for (const tr of traders) {
  tr.p = {}; tr.obs = {}; tr.nullMean = {}; tr.hist = {}; tr.pTrain = {};
  const train = tr.trades.filter((t) => t.exit + 5 < SPLIT);
  tr.nTrain = train.length;
  for (const d of DELAYS) {
    const res = permutationTest(tr.trades, series, { delay: d, B: 999, W, seed: SEED + tr.id * 31 + d, bins: 28 });
    tr.p[d] = res.p; tr.obs[d] = res.obs; tr.nullMean[d] = res.nullMean; tr.hist[d] = res.hist;
    tr.pTrain[d] = train.length ? permutationTest(train, series, { delay: d, B: 499, W, seed: SEED + tr.id * 37 + d }).p : 1;
  }
}
// ablation: uniform-in-window null (ignores when the token was actually being traded), delay 1
function uniformP(tr, d) {
  const r = rng(SEED + 7 + tr.id);
  const prep = tr.trades.map((t) => { const s = series[t.tok]; const hold = t.exit - t.entry; const [lo, hi] = nullWindow(s, t.entry, hold, d, W); return { s, hold, lo, hi, o: delayedLogReturn(s, t.entry, t.exit, d) }; });
  const obs = mean(prep.map((q) => q.o));
  let ge = 0; const B = 499;
  for (let b = 0; b < B; b++) {
    let m = 0;
    for (const q of prep) { const e = q.lo + Math.floor(r() * (q.hi - q.lo)); m += delayedLogReturn(q.s, e, e + q.hold, d); }
    if (m / prep.length >= obs - 1e-15) ge++;
  }
  return (1 + ge) / (B + 1);
}
for (const tr of traders) tr.pUniform1 = uniformP(tr, 1);
console.log('permutation tests', ((Date.now() - t0) / 1000).toFixed(1), 's');

// --- headline results at the default settings ---
const DEF = { delay: 1, q: 0.1, copy: 250, minTrades: 5 };
const board = traders.map((t) => ({ id: t.id, n: t.trades.length, p: t.p, pTrain: t.pTrain, nTrain: t.nTrain }));
const nullTrue = (t) => t.type === 'random' || t.type === 'whale';
function quality(delay, q, pKey = 'p') {
  const v = verify(board, { delayKey: delay, q, minTrades: DEF.minTrades, pKey });
  const elig = traders.filter((t) => t.trades.length >= DEF.minTrades);
  const reject = elig.map((t) => v.verified.has(t.id));
  const followable = elig.map((t) => (delay === 0 ? t.type === 'swing' || t.type === 'sniper' : t.type === 'swing'));
  const nullIdx = elig.map(nullTrue);
  const dq = discoveryQuality(reject, followable);
  const falseNull = reject.filter((r, i) => r && nullIdx[i]).length;
  const byType = {};
  elig.forEach((t, i) => { byType[t.type] = byType[t.type] || { n: 0, verified: 0 }; byType[t.type].n++; if (reject[i]) byType[t.type].verified++; });
  return { verified: v.k, eligible: v.eligible, threshold: v.threshold, fdpVsFollowable: dq.fdp, powerFollowable: dq.power, followableCount: dq.trueCount, falseFromPureLuck: falseNull, byType };
}
const byPnl = [...traders].sort((a, b) => b.pnl - a.pnl);
const v1 = verify(board, { delayKey: DEF.delay, q: DEF.q, minTrades: DEF.minTrades });
const top20 = byPnl.slice(0, 20);
const top20Verified = top20.filter((t) => v1.verified.has(t.id)).length;
const top20Skilled = top20.filter((t) => t.type === 'swing').length;

// out-of-sample: select on days 1-4, follow on days 5-7 (same function the app runs)
function oos(delay, q, copy) {
  const bt = backtest(traders.map((t) => ({ ...t, nTrain: t.nTrain, pTrain: t.pTrain })), { delayKey: delay, q, copy, fee: feeRate, depth, net, split: SPLIT, minTrades: DEF.minTrades });
  const typ = (ids) => ids.filter((id) => traders[id].type === 'swing').length;
  return {
    topPnl: { traders: bt.topPnl.traders, trades: bt.topPnl.trades, pnl: bt.topPnl.pnl, ret: bt.topPnl.ret, skilled: typ(bt.topPnl.ids) },
    verified: { traders: bt.verified.traders, trades: bt.verified.trades, pnl: bt.verified.pnl, ret: bt.verified.ret, skilled: typ(bt.verified.ids) }
  };
}

const results = {
  generated_at: new Date().toISOString(),
  seed: SEED,
  window: { start: '2026-11-03T00:00:00Z', end: '2026-11-10T00:00:00Z', minutes: N, split_minute: SPLIT },
  tokens: syms.length,
  traders: traders.length,
  trades: traders.reduce((a, t) => a + t.trades.length, 0),
  defaults: DEF,
  headline: {
    verified: v1.k,
    eligible: v1.eligible,
    top20ByPnlVerified: top20Verified,
    top20ByPnlSkilled: top20Skilled,
    quality: quality(DEF.delay, DEF.q),
    oos: oos(DEF.delay, DEF.q, DEF.copy)
  },
  byDelay: Object.fromEntries(DELAYS.map((d) => [d, { quality: quality(d, DEF.q), oos: oos(d, DEF.q, DEF.copy) }])),
  ablationUniformNull: (() => {
    const elig = traders.filter((t) => t.trades.length >= DEF.minTrades);
    const bh = benjaminiHochberg(elig.map((t) => t.pUniform1), DEF.q);
    const falseNull = elig.filter((t, i) => bh.reject[i] && nullTrue(t)).length;
    return { verified: bh.k, falseFromPureLuck: falseNull, fdp: bh.k ? elig.filter((t, i) => bh.reject[i] && t.type !== 'swing').length / bh.k : 0 };
  })()
};

if (process.env.SUMMARY_ONLY) {
  const h = results.headline;
  console.log(JSON.stringify({ seed: SEED, verified: h.verified, eligible: h.eligible, pureLuckVerified: h.quality.falseFromPureLuck, fdp: h.quality.fdpVsFollowable, power: h.quality.powerFollowable, top20Verified: h.top20ByPnlVerified, oosTopPnlRet: h.oos.topPnl.ret, oosVerifiedRet: h.oos.verified.ret, naivePureLuck: results.ablationUniformNull.falseFromPureLuck }));
  process.exit(0);
}
// --- write app data ---
mkdirSync('data/prices', { recursive: true });
const r6 = (x) => +x.toPrecision(6);
for (const s of syms) {
  const se = series[s];
  writeFileSync(`data/prices/${s}.json`, JSON.stringify({ symbol: s, start: START, step: 60, o: Array.from(se.o, r6), h: Array.from(se.h, r6), l: Array.from(se.l, r6), c: Array.from(se.c, r6), v: Array.from(se.v, (x) => Math.round(x)) }));
}
const r5 = (x) => +x.toPrecision(5);
const out = {
  meta: { start: START, minutes: N, split: SPLIT, window: W, fee: 'fomo published schedule (core/edge.js feeRate)', delays: DELAYS, seed: SEED, source: 'Prices: GeckoTerminal public API (1-minute OHLCV, USD). Traders: synthetic, seeded.' },
  tokens: tokens.map((p, i) => ({ symbol: p.symbol, network: p.network, pool: p.pool, dex: p.dex, depth: depth[p.symbol], vol7d: Math.round(vol[i]), last: r6(series[p.symbol].c[N - 1]), first: r6(series[p.symbol].c[0]) })),
  traders: traders.map((t) => ({
    id: t.id, handle: t.handle, type: t.type, pnl: +t.pnl.toFixed(2), vol: Math.round(t.vol), n: t.trades.length, nTrain: t.nTrain,
    p: t.p, pTrain: t.pTrain, obs: Object.fromEntries(DELAYS.map((d) => [d, r5(t.obs[d])])), nullMean: Object.fromEntries(DELAYS.map((d) => [d, r5(t.nullMean[d])])),
    hist: Object.fromEntries(DELAYS.map((d) => [d, { lo: r5(t.hist[d].lo), hi: r5(t.hist[d].hi), c: t.hist[d].counts }])),
    pUniform1: t.pUniform1,
    trades: t.trades.map((x) => [x.tok, x.entry, x.exit, Math.round(x.size), ...DELAYS.map((d) => x.g[d]), ...DELAYS.map((d) => x.base[d])])
  }))
};
writeFileSync('data/board.json', JSON.stringify(out));
writeFileSync('data/results.json', JSON.stringify(results, null, 1));
console.log(JSON.stringify(results.headline, null, 1));
console.log('byDelay', JSON.stringify(Object.fromEntries(Object.entries(results.byDelay).map(([d, r]) => [d, { v: r.quality.verified, fdp: +r.quality.fdpVsFollowable.toFixed(3), pow: +r.quality.powerFollowable.toFixed(3), luck: r.quality.falseFromPureLuck, oosTop: +r.oos.topPnl.ret.toFixed(4), oosVer: +r.oos.verified.ret.toFixed(4) }]))));
console.log('ablation', results.ablationUniformNull);
