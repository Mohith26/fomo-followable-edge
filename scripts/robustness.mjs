// Re-runs the whole simulation with 20 different trader seeds (same real prices) and records the headline numbers.
// Run: node scripts/robustness.mjs  -> data/robustness.json
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const rows = [];
for (let k = 0; k < 20; k++) {
  const out = execFileSync(process.execPath, ['scripts/generate.mjs'], { env: { ...process.env, SEED: String(20261103 + 1000 * k), SUMMARY_ONLY: '1' } }).toString();
  rows.push(JSON.parse(out.trim().split('\n').pop()));
}
const mean = (k) => rows.reduce((a, r) => a + r[k], 0) / rows.length;
const summary = {
  runs: rows.length,
  verifiedBeatsTopPnl: rows.filter((r) => r.oosVerifiedRet > r.oosTopPnlRet).length,
  meanOosVerifiedRet: mean('oosVerifiedRet'), meanOosTopPnlRet: mean('oosTopPnlRet'),
  meanFdp: mean('fdp'), meanPower: mean('power'), meanPureLuckVerified: mean('pureLuckVerified'), meanNaivePureLuck: mean('naivePureLuck')
};
writeFileSync('data/robustness.json', JSON.stringify({ summary, rows }, null, 1));
console.log(JSON.stringify(summary, null, 1));
