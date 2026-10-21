// Markdown tables from bench results files (bench/run.mjs), one row per run, for the capacity report.
//   node bench/table.mjs bench/results.json [bench/results-entitycodec-before.json ...]
import { readFile } from 'node:fs/promises';

const kib = (b) => (b / 1024).toFixed(1),
  ms = (q, k = 'median') => (q ? Math.round(q[k]) : '-'),
  dec = (q, k) => (q ? q[k].toFixed(1) : '-');
for (const file of process.argv.slice(2)) {
  const results = JSON.parse(await readFile(file, 'utf8'));
  console.log(`\n${file} (${results.date.slice(0, 10)}, ${results.machine.cpu}, Node ${results.machine.node})\n`);
  console.log(
    '| Scenario | Players | Tick ms median / p95 / max | Ticks/s | Main thread busy | CPU cores | RSS MB | Out KiB/s per player / total | In KiB/s per player | Spawn ms median / p95 | Full view ms median / p95 | Edit to others ms median / p95 | In budget |',
  );
  console.log('| --- | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | --- | --- | --- | --- |');
  for (const r of results.runs) {
    const w = r.window,
      t = w.tickWorkMs;
    console.log(
      `| ${r.scenario} | ${r.playersInWindow} | ${dec(t, 'median')} / ${dec(t, 'p95')} / ${dec(t, 'max')} | ${w.ticksPerSecond} | ` +
        `${Math.round(w.mainThreadBusy * 100)}% | ${w.processCpuCores} | ${Math.round(w.memory.rssMB)} | ` +
        `${kib(w.bytesOutPerClientPerSecond)} / ${Math.round(w.bytesOutPerSecond / 1024)} | ${kib(w.bytesInPerClientPerSecond)} | ` +
        `${ms(r.join.spawnMs)} / ${ms(r.join.spawnMs, 'p95')} | ${ms(r.join.fullViewMs)} / ${ms(r.join.fullViewMs, 'p95')} | ` +
        `${ms(w.editToOtherClientMs)} / ${ms(w.editToOtherClientMs, 'p95')} | ${r.withinBudget ? 'yes' : '**no**'} |`,
    );
  }
  for (const s of ['spread', 'crowd'])
    if (results[`${s}Limit`])
      console.log(
        `\n${s}: last in budget ${results[`${s}Limit`].lastWithinBudget}, first over ${results[`${s}Limit`].firstOverBudget}`,
      );
}
