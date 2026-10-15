// Prints the core-prototype step table from results-<step>-<case>.json: node examples/package-benchmarks/cad/summary.mjs s0 s1 s2 s3 s5
import { readFileSync, existsSync } from 'node:fs';
const steps = process.argv.slice(2),
  f = (v) => (v == null ? '-' : v.toFixed(v < 10 ? 2 : 1));
console.log('| step | case | size | kernel (frame) | collect | frame CPU | render CPU, GPU idle | FPS | pick |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const c of ['orbit', 'still', 'move'])
  for (const s of steps) {
    const file = new URL(`./results-${s}-${c}.json`, import.meta.url);
    if (!existsSync(file)) continue;
    const r = JSON.parse(readFileSync(file, 'utf8'));
    if (!r.acPowerAtStart || !r.acPowerAtEnd) throw new Error(`${s}-${c}: not on AC power`);
    for (const x of r.runs)
      console.log(
        `| ${s} | ${c} | ${x.size} | ${f(x.frame.kernelMs.median)} | ${f(x.frame.collectMs.median)} | ${f(x.frame.cpuMs.median)} | ${f(x.isolated.cpuMs.median)} | ${x.frame.fps} | ${f(x.enginePick?.ms?.median)} |`,
      );
  }
