// Followable Edge: core statistics (isomorphic ES module; used by the app, the data script and the tests).
//
// Question it answers for a leaderboard trader: "if I act on this trader's notifications d minutes late,
// do their entries still beat random entries into the same tokens?"  The test is a Monte Carlo permutation
// test against an activity-matched null (random entry times drawn in proportion to the token's traded volume,
// inside the same fixed 12-hour block as each real entry, same holding time), evaluated at the follower's delay. P-values are
// exactly valid under the null, so Benjamini-Hochberg across the board controls the false discovery rate of the
// "Verified edge" badge.

/** Deterministic PRNG (mulberry32). Returns floats in [0, 1). */
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller. */
export function randn(r) {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/**
 * Builds a minute series from sparse candles [[unixSec,o,h,l,c,volUsd],...].
 * Missing minutes are forward-filled (flat price, zero volume).
 */
export function buildSeries(candles, startSec, minutes) {
  const o = new Float64Array(minutes), h = new Float64Array(minutes), l = new Float64Array(minutes);
  const c = new Float64Array(minutes), v = new Float64Array(minutes);
  const byMin = new Map();
  for (const k of candles) byMin.set(Math.round((k[0] - startSec) / 60), k);
  let last = candles.length ? candles[0][1] : 1;
  for (let i = 0; i < minutes; i++) {
    const k = byMin.get(i);
    if (k) { o[i] = k[1]; h[i] = k[2]; l[i] = k[3]; c[i] = k[4]; v[i] = k[5]; last = k[4]; }
    else { o[i] = h[i] = l[i] = c[i] = last; v[i] = 0; }
  }
  return { o, h, l, c, v, n: minutes, cum: activityCumulative(v) };
}

/**
 * Cumulative activity weights. Each minute gets weight volume + floor, floor = 5% of mean volume, so quiet
 * minutes stay possible but rare (people trade when a token is active).
 */
export function activityCumulative(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i];
  const floor = (0.05 * s) / Math.max(1, v.length) + 1e-12;
  const cum = new Float64Array(v.length + 1);
  for (let i = 0; i < v.length; i++) cum[i + 1] = cum[i] + v[i] + floor;
  return cum;
}

/** Draws a minute index in [lo, hi) with probability proportional to activity weight. */
export function sampleActivity(cum, lo, hi, r) {
  const a = cum[lo], b = cum[hi];
  const x = a + r() * (b - a);
  let L = lo, H = hi - 1;
  while (L < H) {
    const m = (L + H) >> 1;
    if (cum[m + 1] <= x) L = m + 1; else H = m;
  }
  return L;
}

/** Log return of holding from entry to exit, both shifted by the follower's delay (minutes). */
export function delayedLogReturn(series, entry, exit, delay) {
  const e = Math.min(series.n - 1, entry + delay), x = Math.min(series.n - 1, exit + delay);
  return Math.log(series.c[x] / series.c[e]);
}

export const MAX_DELAY = 5;
/**
 * Null window for a trade: the fixed clock block of length 2W (12 h for W = 360) that contains the entry,
 * cut so that exit + MAX_DELAY stays inside the data. Fixed blocks (not a window centred on the real entry)
 * make the real entry and the null draws exchangeable under H0, so the Monte Carlo p-value is exact.
 */
export function nullWindow(series, entry, hold, delay, W) {
  const B = 2 * W;
  const lo = Math.floor(entry / B) * B;
  const hi = Math.min(lo + B, series.n - hold - MAX_DELAY);
  return [lo, Math.max(hi, Math.min(entry + 1, lo + B))];
}

/**
 * Monte Carlo permutation test of entry-timing edge at a given delay.
 * trades: [{tok, entry, exit}] (minute indices); seriesBy: {tok: series}.
 * Statistic: mean delayed log return over the trader's trades. Null: each entry redrawn from the activity-matched
 * distribution in its 12-hour block, same hold. p = (1 + #{null >= observed}) / (B + 1)  (valid, never 0).
 */
export function permutationTest(trades, seriesBy, { delay = 0, B = 999, W = 360, seed = 1, bins = 0 } = {}) {
  const r = rng(seed);
  const n = trades.length;
  if (!n) return { n: 0, obs: 0, nullMean: 0, excess: 0, p: 1, hist: null };
  const prepared = trades.map((t) => {
    const s = seriesBy[t.tok];
    const hold = t.exit - t.entry;
    const [lo, hi] = nullWindow(s, t.entry, hold, delay, W);
    return { s, hold, lo, hi, obs: delayedLogReturn(s, t.entry, t.exit, delay) };
  });
  let obs = 0;
  for (const q of prepared) obs += q.obs;
  obs /= n;
  let ge = 0, sum = 0;
  const nulls = bins ? new Float64Array(B) : null;
  for (let b = 0; b < B; b++) {
    let m = 0;
    for (const q of prepared) {
      const e = sampleActivity(q.s.cum, q.lo, q.hi, r);
      m += delayedLogReturn(q.s, e, e + q.hold, delay);
    }
    m /= n;
    sum += m;
    if (m >= obs - 1e-15) ge++;
    if (nulls) nulls[b] = m;
  }
  const nullMean = sum / B;
  return { n, obs, nullMean, excess: obs - nullMean, p: (1 + ge) / (B + 1), hist: nulls ? histogram(nulls, obs, bins) : null };
}

/** Histogram of null statistics, range widened to include the observed value. */
export function histogram(xs, obs, bins) {
  let lo = Infinity, hi = -Infinity;
  for (const x of xs) { if (x < lo) lo = x; if (x > hi) hi = x; }
  lo = Math.min(lo, obs); hi = Math.max(hi, obs);
  const pad = (hi - lo) * 0.04 || 1e-4;
  lo -= pad; hi += pad;
  const counts = new Array(bins).fill(0);
  for (const x of xs) counts[Math.min(bins - 1, Math.floor(((x - lo) / (hi - lo)) * bins))]++;
  return { lo, hi, counts };
}

/**
 * Benjamini-Hochberg step-up. Returns {reject: bool[], k, threshold}. Controls FDR at level q for independent or
 * positively dependent (PRDS) p-values.
 */
export function benjaminiHochberg(pvals, q) {
  const m = pvals.length;
  const idx = pvals.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  let k = 0;
  for (let j = 0; j < m; j++) if (idx[j][0] <= ((j + 1) / m) * q) k = j + 1;
  const reject = new Array(m).fill(false);
  for (let j = 0; j < k; j++) reject[idx[j][1]] = true;
  return { reject, k, threshold: k ? (k / m) * q : 0 };
}

/**
 * Constant-product AMM price impact. Q = quote-side reserve (USD, half the pool's reported reserve).
 * avg(x): average execution premium for a buy of size x; after(x): permanent move of the marginal price.
 */
export const amm = {
  avgBuy: (x, Q) => x / Q,
  afterBuy: (x, Q) => (1 + x / Q) ** 2 - 1,
  avgSell: (y, Q) => y / (Q + y),
  afterSell: (y, Q) => 1 - (Q / (Q + y)) ** 2
};

/**
 * Net return of one round trip for the trader themself: fees on both sides, own average impact.
 * gross = exit/entry price ratio at mid.
 */
export function leaderNetReturn(gross, size, Q, fee) {
  const buy = (1 + fee) * (1 + amm.avgBuy(size, Q));
  const proceeds = size * gross; // value at exit mid before sell impact
  const sell = (1 - fee) * (1 - amm.avgSell(proceeds, Q));
  return (gross * sell) / buy - 1;
}

/**
 * Net return of a follower copying one trade d minutes late with copy size c.
 * The follower buys after the leader's buy has moved the price (permanent impact) and sells after the leader's
 * sell has moved it down; both legs pay fees and the follower's own average impact.
 * grossD = price(exit+d) / price(entry+d) at mid (from real candles).
 */
export function followerNetReturn(grossD, leaderSize, copy, Q, fee) {
  const inPx = (1 + amm.afterBuy(leaderSize, Q)) * (1 + amm.avgBuy(copy, Q)) * (1 + fee);
  const leaderExitValue = leaderSize * grossD;
  const outPx = grossD * (1 - amm.afterSell(leaderExitValue, Q)) * (1 - amm.avgSell(copy * grossD, Q)) * (1 - fee);
  return outPx / inPx - 1;
}

/** Simulates a follower copying every trade in `trades` with fixed copy size. Returns $ PnL and return on capital. */
export function simulateFollow(trades, { delayKey, copy, fee, depth, net = {} }) {
  let pnl = 0, deployed = 0;
  const per = [];
  for (const t of trades) {
    const g = t.g[delayKey];
    const f = typeof fee === 'function' ? fee(copy, net[t.tok]) : fee;
    const r = followerNetReturn(g, t.size, copy, depth[t.tok], f);
    pnl += copy * r;
    deployed += copy;
    per.push(r);
  }
  return { pnl, deployed, ret: deployed ? pnl / deployed : 0, n: trades.length, per };
}

/** Pearson-free summary helpers. */
export function mean(a) { let s = 0; for (const x of a) s += x; return a.length ? s / a.length : 0; }
export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, b = Math.floor(pos), r = pos - b;
  return sorted[b + 1] !== undefined ? sorted[b] + r * (sorted[b + 1] - sorted[b]) : sorted[b];
}

/** Realized false discovery proportion and power against known ground truth (synthetic evaluation only). */
export function discoveryQuality(reject, truth) {
  let R = 0, V = 0, T = 0, S = 0;
  for (let i = 0; i < reject.length; i++) {
    if (truth[i]) T++;
    if (reject[i]) { R++; if (truth[i]) S++; else V++; }
  }
  return { discoveries: R, false: V, fdp: R ? V / R : 0, power: T ? S / T : 0, trueCount: T };
}

/**
 * Board model used by the app: given precomputed per-trader p-values at each delay, choose delay and q, run BH
 * over eligible traders (>= minTrades), and return badges.
 */
export function verify(traders, { delayKey, q, minTrades = 5, pKey = 'p' }) {
  const elig = traders.filter((t) => t.n >= minTrades);
  const { reject, k, threshold } = benjaminiHochberg(elig.map((t) => t[pKey][delayKey]), q);
  const set = new Set();
  elig.forEach((t, i) => { if (reject[i]) set.add(t.id); });
  return { verified: set, k, threshold, eligible: elig.length };
}

export const DELAYS = [0, 1, 2, 5];
export const FEE = 0.005; // fomo standard spot fee per side (0.50%, help.fomo.family "Trading fees on fomo")
/**
 * fomo's published spot fee schedule as a rate for a trade of `usd` (help.fomo.family, read 2026-11-11).
 * Solana, lowest-fee route: $0.10 under $5, 2% from $5 to $47.50, $0.95 flat from $47.50 to $190, 0.50% above.
 * Base and other EVM networks: 0.50% (network gas not modelled).
 */
export function feeRate(usd, network = 'solana') {
  if (network !== 'solana') return 0.005;
  if (usd < 5) return 0.1 / Math.max(usd, 1e-9);
  if (usd < 47.5) return 0.02;
  if (usd < 190) return 0.95 / usd;
  return 0.005;
}

/**
 * Exact expectation of the delayed log return under the activity-matched null for one trade
 * (sum over every admissible entry minute in the window, weighted by activity). Used for per-trade "timing edge".
 */
export function nullExpectation(series, entry, hold, delay, W) {
  const [lo, hi] = nullWindow(series, entry, hold, delay, W);
  let s = 0, w = 0;
  for (let e = lo; e < hi; e++) {
    const a = series.cum[e + 1] - series.cum[e];
    s += a * delayedLogReturn(series, e, e + hold, delay);
    w += a;
  }
  return w ? s / w : 0;
}

/** Turns the compact board.json into trader objects with trade objects and the trader's own net return. */
export function hydrate(board) {
  const depth = Object.fromEntries(board.tokens.map((t) => [t.symbol, t.depth]));
  const net = Object.fromEntries(board.tokens.map((t) => [t.symbol, t.network]));
  const D = board.meta.delays;
  const fee = feeRate;
  const traders = board.traders.map((t) => {
    const trades = t.trades.map((a) => {
      const g = {}, base = {};
      D.forEach((d, i) => { g[d] = a[4 + i]; base[d] = a[4 + D.length + i]; });
      return { tok: a[0], entry: a[1], exit: a[2], size: a[3], g, base, lead: leaderNetReturn(g[0], a[3], depth[a[0]], feeRate(a[3], net[a[0]])) };
    });
    return { ...t, trades };
  });
  return { traders, depth, net, fee, delays: D, meta: board.meta, tokens: board.tokens };
}

/** Mean per-trade timing edge after delay d: mean(log g_d - exact null expectation). */
export function timingEdge(trades, d) {
  if (!trades.length) return 0;
  let s = 0;
  for (const t of trades) s += Math.log(t.g[d]) - t.base[d];
  return s / trades.length;
}

/**
 * Out-of-sample backtest. Selection uses only trades closed before `split` (days 1-4); the follower then copies
 * every trade the selected traders open at or after `split` (days 5-7), d minutes late.
 * Strategy A: top N by days-1-4 realized PnL. Strategy B: traders verified by BH on days-1-4 p-values.
 */
export function backtest(traders, { delayKey, q, copy, fee, depth, net, split, minTrades = 5, topN = 10 }) {
  const trainOf = (t) => t.trades.filter((x) => x.exit + 5 < split);
  const ranked = traders
    .map((t) => { const tr = trainOf(t); return { t, n: tr.length, pnl: tr.reduce((a, x) => a + x.size * x.lead, 0) }; })
    .filter((x) => x.n >= minTrades)
    .sort((a, b) => b.pnl - a.pnl);
  const topPnl = ranked.slice(0, topN).map((x) => x.t);
  const elig = traders.filter((t) => t.nTrain >= minTrades);
  const bh = benjaminiHochberg(elig.map((t) => t.pTrain[delayKey]), q);
  const verified = elig.filter((_, i) => bh.reject[i]);
  const run = (set) => {
    const trades = set.flatMap((t) => t.trades.filter((x) => x.entry >= split));
    const sim = simulateFollow(trades, { delayKey, copy, fee, depth, net });
    const ev = trades.map((x, i) => [x.exit + delayKey, copy * sim.per[i]]).sort((a, b) => a[0] - b[0]);
    let c = 0;
    const curve = ev.map(([m, v]) => [m, (c += v)]);
    return { ids: set.map((t) => t.id), traders: set.length, trades: sim.n, pnl: sim.pnl, ret: sim.ret, curve };
  };
  return { topPnl: run(topPnl), verified: run(verified) };
}
