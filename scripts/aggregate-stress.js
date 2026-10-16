import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { stressProfile, scenarios } from '../tests/support/stress-profiles.js';

export function aggregateStress(reports) {
  assert.ok(reports.length, 'Provide every shard report');
  const first = reports[0],
    sessions = [],
    seen = new Set(),
    shards = new Set();
  for (const report of reports) {
    assert.equal(report.version, 1);
    assert.equal(report.revision, first.revision, 'Mixed Git revisions');
    assert.equal(report.dirty, false, 'Release evidence must come from a clean checkout');
    assert.ok(report.finished && !report.fatal, 'Incomplete/fatal shard');
    for (const [name, value] of Object.entries(first.options))
      if (name !== 'shard') assert.equal(report.options[name], value, `Mixed ${name}`);
    const { shard, shards: totalShards } = report.options;
    assert.ok(shard >= 0 && shard < totalShards && !shards.has(shard), 'Duplicate/invalid shard');
    shards.add(shard);
    for (const session of report.sessions) {
      assert.ok(
        Number.isInteger(session.index) &&
          session.index >= 0 &&
          session.index < first.options.sessions &&
          session.index % totalShards === shard &&
          !seen.has(session.index),
        'Duplicate/out-of-range session',
      );
      assert.deepEqual(session.profile, stressProfile(first.options.seed, session.index), 'Changed profile');
      seen.add(session.index);
      sessions.push(session);
    }
  }
  assert.equal(shards.size, first.options.shards, 'Missing shards');
  assert.equal(seen.size, first.options.sessions, 'Missing sessions');
  const failed = sessions.filter((session) => session.status !== 'passed');
  return {
    version: 1,
    revision: first.revision,
    options: first.options,
    hardware: reports.map((report) => report.hardware),
    sessions: sessions.length,
    passed: sessions.length - failed.length,
    failed: failed.length,
    failures: failed.map(({ index, profile, failure }) => ({ index, scenario: profile.scenario, failure })),
    coverage: Object.fromEntries(
      scenarios.map((name) => [name, sessions.filter((session) => session.profile.scenario === name).length]),
    ),
  };
}

if (process.argv[1]?.endsWith('aggregate-stress.js')) {
  const result = aggregateStress(
    await Promise.all(process.argv.slice(2).map(async (path) => JSON.parse(await readFile(path, 'utf8')))),
  );
  await writeFile('test-results/stress/summary.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.failed, 0, 'Stress failures block release');
}
