/** Compares two golden dumps for exact parity. Usage: node scripts/perf-compare-golden.mjs before after2 */
import fs from "node:fs";
const [a, b] = [process.argv[2], process.argv[3]];
const before = JSON.parse(fs.readFileSync(`perf-results/golden-${a}.json`));
const after = JSON.parse(fs.readFileSync(`perf-results/golden-${b}.json`));
let diffs = 0;
const cmp = (x, y, label) => {
  const sx = JSON.stringify(x), sy = JSON.stringify(y);
  if (sx !== sy) {
    diffs++;
    console.log("DIFF at", label);
    if (diffs <= 3) { console.log(" before:", sx.slice(0, 400)); console.log(" after :", sy.slice(0, 400)); }
  }
};
for (const pid of Object.keys(before.player_history))
  for (const variant of Object.keys(before.player_history[pid]))
    cmp(before.player_history[pid][variant], after.player_history[pid]?.[variant], `${pid}/${variant}`);
cmp(before.events_league, after.events_league, "events_league");
cmp(before.events_one_match, after.events_one_match, "events_one_match");
cmp(before.history, after.history, "history");
console.log(diffs === 0 ? "PARITY OK — all outputs identical" : `${diffs} diffs found`);
