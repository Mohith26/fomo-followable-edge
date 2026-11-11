import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  rng, randn, buildSeries, activityCumulative, sampleActivity, delayedLogReturn, nullWindow, permutationTest,
  benjaminiHochberg, amm, leaderNetReturn, followerNetReturn, simulateFollow, discoveryQuality, verify,
  nullExpectation, hydrate, timingEdge, backtest, feeRate
} from '../core/edge.js';

// Random-walk series with bursty volume, for synthetic checks.
function walk(seed, n = 3000) {
  const r = rng(seed);
  const candles = [];
  let p = 1;
  for (let i = 0; i < n; i++) {
    p *= Math.exp(0.004 * randn(r));
    candles.push([i * 60, p, p * 1.001, p * 0.999, p, r() < 0.3 ? 0 : 100 * Math.exp(randn(r))]);
  }
  return buildSeries(candles, 0, n);
}

test('rng is deterministic and roughly uniform', () => {
  const a = rng(42), b = rng(42);
  const xs = Array.from({ length: 20000 }, () => a());
  assert.deepEqual(xs.slice(0, 5), Array.from({ length: 5 }, () => b()));
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(Math.abs(m - 0.5) < 0.01);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test('buildSeries forward-fills gaps with flat price and zero volume', () => {
  const s = buildSeries([[0, 1, 1.2, 0.9, 1.1, 50], [180, 1.1, 1.3, 1.0, 1.25, 20]], 0, 5);
  assert.deepEqual(Array.from(s.c), [1.1, 1.1, 1.1, 1.25, 1.25]);
  assert.deepEqual(Array.from(s.v), [50, 0, 0, 20, 0]);
  assert.equal(s.cum.length, 6);
});

test('activity sampler matches volume weights (randomized)', () => {
  const v = new Float64Array([0, 10, 0, 30, 60]);
  const cum = activityCumulative(v);
  const r = rng(7), counts = [0, 0, 0, 0, 0];
  for (let i = 0; i < 50000; i++) counts[sampleActivity(cum, 0, 5, r)]++;
  const floor = 0.05 * 100 / 5; // 1 per minute
  const w = [0, 10, 0, 30, 60].map((x) => x + floor), W = w.reduce((a, b) => a + b, 0);
  counts.forEach((c, i) => assert.ok(Math.abs(c / 50000 - w[i] / W) < 0.01, `bin ${i}`));
  // window restriction respected
  for (let i = 0; i < 2000; i++) { const k = sampleActivity(cum, 1, 3, r); assert.ok(k >= 1 && k < 3); }
});

test('delayed log return shifts both legs and clamps at the end', () => {
  const s = buildSeries([[0, 1, 1, 1, 1, 1], [60, 2, 2, 2, 2, 1], [120, 4, 4, 4, 4, 1], [180, 8, 8, 8, 8, 1]], 0, 4);
  assert.ok(Math.abs(delayedLogReturn(s, 0, 1, 0) - Math.log(2)) < 1e-12);
  assert.ok(Math.abs(delayedLogReturn(s, 0, 1, 2) - Math.log(2)) < 1e-12);
  assert.equal(delayedLogReturn(s, 0, 2, 5), 0); // both legs clamp to the last minute
  const big = walk(1, 3000);
  const [lo, hi] = nullWindow(big, 800, 30, 1, 360);
  assert.equal(lo, 720); assert.equal(hi, 1440);
  const [lo2, hi2] = nullWindow(big, 2900, 30, 1, 360);
  assert.equal(lo2, 2880); assert.equal(hi2, 3000 - 30 - 5);
});

test('permutation p-values are valid under the null (property: random-timing traders, many seeds)', () => {
  const s = walk(11);
  const seriesBy = { X: s };
  const r = rng(99);
  let below05 = 0, below10 = 0; const M = 300;
  for (let k = 0; k < M; k++) {
    // H0 traders: activity-random entry anywhere feasible (same bound the null uses)
    const trades = Array.from({ length: 12 }, () => { const hold = 5 + Math.floor(r() * 60); const e = sampleActivity(s.cum, 0, s.n - hold - 5, r); return { tok: 'X', entry: e, exit: e + hold }; });
    const { p } = permutationTest(trades, seriesBy, { delay: 1, B: 199, W: 360, seed: k + 1 });
    assert.ok(p > 0 && p <= 1);
    if (p <= 0.05) below05++;
    if (p <= 0.1) below10++;
  }
  // super-uniform: P(p <= a) <= a (+ Monte Carlo slack)
  assert.ok(below05 / M <= 0.05 + 0.035, `size at 5%: ${below05 / M}`);
  assert.ok(below10 / M <= 0.1 + 0.045, `size at 10%: ${below10 / M}`);
});

test('permutation test detects an informed trader and loses it when the edge is only the first minute', () => {
  const s = walk(5);
  const seriesBy = { X: s };
  const r = rng(3);
  // informed: picks the best of 6 random entries by next-60-minute return
  const informed = Array.from({ length: 25 }, () => {
    let best = null, bv = -Infinity;
    for (let j = 0; j < 6; j++) { const e = sampleActivity(s.cum, 400, 2500, r); const v = Math.log(s.c[e + 60] / s.c[e]); if (v > bv) { bv = v; best = e; } }
    return { tok: 'X', entry: best, exit: best + 60 };
  });
  assert.ok(permutationTest(informed, seriesBy, { delay: 1, B: 499, W: 360, seed: 1 }).p < 0.01);
  // sniper: best next-1-minute return, hold 3 minutes. Edge at delay 0, gone at delay 2.
  const sniper = Array.from({ length: 30 }, () => {
    let best = null, bv = -Infinity;
    for (let j = 0; j < 12; j++) { const e = sampleActivity(s.cum, 400, 2500, r); const v = Math.log(s.c[e + 1] / s.c[e]); if (v > bv) { bv = v; best = e; } }
    return { tok: 'X', entry: best, exit: best + 3 };
  });
  assert.ok(permutationTest(sniper, seriesBy, { delay: 0, B: 499, W: 360, seed: 2 }).p < 0.01);
  assert.ok(permutationTest(sniper, seriesBy, { delay: 2, B: 499, W: 360, seed: 2 }).p > 0.05);
});

test('Benjamini-Hochberg: known example and step-up behaviour', () => {
  const p = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216];
  const { reject, k, threshold } = benjaminiHochberg(p, 0.05);
  assert.equal(k, 2);
  assert.deepEqual(reject.slice(0, 3), [true, true, false]);
  assert.ok(Math.abs(threshold - 0.01) < 1e-12);
  assert.equal(benjaminiHochberg([0.5, 0.9], 0.1).k, 0);
  assert.equal(benjaminiHochberg([0.04, 0.04], 0.05).k, 2); // step-up: both pass at 2/2*q
});

test('Benjamini-Hochberg controls FDR on simulated boards (property, 400 boards)', () => {
  const r = rng(2024);
  let fdpSum = 0; const B = 400, q = 0.1;
  for (let b = 0; b < B; b++) {
    const m = 200, alt = 20;
    const truth = Array.from({ length: m }, (_, i) => i < alt);
    const p = truth.map((t) => (t ? Math.pow(r(), 6) : r()));
    const { reject } = benjaminiHochberg(p, q);
    fdpSum += discoveryQuality(reject, truth).fdp;
  }
  // E[FDP] <= q * m0/m = 0.09
  assert.ok(fdpSum / B <= 0.09 + 0.02, `mean FDP ${fdpSum / B}`);
});

test('constant-product impact formulas match exact AMM math', () => {
  const Q = 1000, x = 50;
  // exact: pool (X tokens, Q quote) with price Q/X; buy with x quote -> tokens out = X*x/(Q+x)
  const X = 500, P = Q / X, out = (X * x) / (Q + x);
  assert.ok(Math.abs(x / out / P - 1 - amm.avgBuy(x, Q)) < 1e-12);
  const P2 = (Q + x) / (X - out);
  assert.ok(Math.abs(P2 / P - 1 - amm.afterBuy(x, Q)) < 1e-12);
  assert.ok(amm.afterSell(100, Q) > 0 && amm.afterSell(100, Q) < 1);
});

test('net returns: zero move loses exactly fees and impact; follower pays the leader\'s impact', () => {
  const fee = 0.0045;
  const r0 = leaderNetReturn(1, 1e-9, 1e12, fee);
  assert.ok(Math.abs(r0 - ((1 - fee) / (1 + fee) - 1)) < 1e-9);
  const tiny = followerNetReturn(1.05, 1e-9, 1e-9, 1e12, fee);
  assert.ok(Math.abs(tiny - (1.05 * (1 - fee) / (1 + fee) - 1)) < 1e-9);
  // a big leader on a thin pool makes copying strictly worse
  assert.ok(followerNetReturn(1.05, 20000, 100, 200000, fee) < followerNetReturn(1.05, 100, 100, 200000, fee));
  const sim = simulateFollow([{ tok: 'A', size: 10, g: { 1: 1.1 } }, { tok: 'A', size: 10, g: { 1: 0.9 } }], { delayKey: 1, copy: 100, fee, depth: { A: 1e12 } });
  assert.equal(sim.n, 2); assert.equal(sim.deployed, 200);
  assert.ok(sim.pnl < 0); // symmetric +/-10% loses fees
});

test('nullExpectation equals the Monte Carlo null mean', () => {
  const s = walk(21);
  const t = { tok: 'X', entry: 1500, exit: 1560 };
  const exact = nullExpectation(s, t.entry, 60, 1, 360);
  const mc = permutationTest([t], { X: s }, { delay: 1, B: 20000, W: 360, seed: 4 }).nullMean;
  assert.ok(Math.abs(exact - mc) < 0.0015, `${exact} vs ${mc}`);
});

// ------------- checks against the committed dataset
const board = JSON.parse(readFileSync(new URL('../data/board.json', import.meta.url)));
const results = JSON.parse(readFileSync(new URL('../data/results.json', import.meta.url)));
const H = hydrate(board);

test('dataset: committed board is internally consistent', () => {
  for (const t of H.traders) {
    assert.equal(t.trades.length, t.n);
    const pnl = t.trades.reduce((a, x) => a + x.size * x.lead, 0);
    assert.ok(Math.abs(pnl - t.pnl) < 0.02, `pnl ${t.handle}`);
    for (const d of H.delays) assert.ok(t.p[d] > 0 && t.p[d] <= 1);
    // displayed per-trade edge tracks the permutation statistic (obs - Monte Carlo null mean)
    const e = timingEdge(t.trades, 1);
    assert.ok(Math.abs(e - (t.obs[1] - t.nullMean[1])) < 0.004, `edge ${t.handle}: ${e} vs ${t.obs[1] - t.nullMean[1]}`);
  }
});

test('headline numbers recompute exactly from the committed board', () => {
  const d = results.defaults.delay, q = results.defaults.q, copy = results.defaults.copy;
  const v = verify(H.traders, { delayKey: d, q, minTrades: 5 });
  assert.equal(v.k, results.headline.verified);
  const top20 = [...H.traders].sort((a, b) => b.pnl - a.pnl).slice(0, 20).filter((t) => v.verified.has(t.id)).length;
  assert.equal(top20, results.headline.top20ByPnlVerified);
  const bt = backtest(H.traders, { delayKey: d, q, copy, fee: H.fee, depth: H.depth, net: H.net, split: H.meta.split, minTrades: 5 });
  assert.ok(Math.abs(bt.topPnl.ret - results.headline.oos.topPnl.ret) < 1e-9);
  assert.ok(Math.abs(bt.verified.ret - results.headline.oos.verified.ret) < 1e-9);
  assert.equal(bt.verified.traders, results.headline.oos.verified.traders);
  // the headline claim in the README / email
  assert.ok(bt.verified.ret > bt.topPnl.ret);
  assert.equal(results.headline.quality.falseFromPureLuck, 0);
});

test('backtest uses no test-period information for selection', () => {
  const d = 1, q = 0.1;
  // scramble every test-period return; the selected sets must not change
  const scrambled = H.traders.map((t) => ({ ...t, trades: t.trades.map((x) => (x.entry >= H.meta.split ? { ...x, g: { 0: 2, 1: 0.5, 2: 2, 5: 0.5 }, lead: 1 } : x)) }));
  const a = backtest(H.traders, { delayKey: d, q, copy: 100, fee: H.fee, depth: H.depth, net: H.net, split: H.meta.split });
  const b = backtest(scrambled, { delayKey: d, q, copy: 100, fee: H.fee, depth: H.depth, net: H.net, split: H.meta.split });
  assert.deepEqual(a.topPnl.ids, b.topPnl.ids);
  assert.deepEqual(a.verified.ids, b.verified.ids);
});

test('fee schedule follows fomo\'s published Solana bands and EVM rate', () => {
  assert.ok(Math.abs(feeRate(4) * 4 - 0.1) < 1e-12);       // $0.10 under $5
  assert.equal(feeRate(20), 0.02);                          // 2% from $5 to $47.50
  assert.ok(Math.abs(feeRate(100) * 100 - 0.95) < 1e-12);  // $0.95 flat from $47.50 to $190
  assert.equal(feeRate(500), 0.005);                        // 0.50% from $190
  assert.equal(feeRate(100, 'base'), 0.005);
  // fee in dollars never decreases as the trade grows (no band discontinuity that pays you to trade bigger)
  let prev = 0;
  for (let x = 1; x < 2000; x += 0.5) { const f = feeRate(x) * x; assert.ok(f >= prev - 1e-9, `at ${x}`); prev = f; }
});
