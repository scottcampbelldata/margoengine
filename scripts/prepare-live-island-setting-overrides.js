import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  liveIslandSettingOverride,
  liveIslandSettingNames,
  pinnedLiveEntrySha,
} from '../test-results/live-island-setting-overrides.mjs';

const source = await readFile('test-results/live-afterlight-2026-10-13.js', 'utf8');
await mkdir('test-results', { recursive: true });
const report = {
  preparedAt: new Date().toISOString(),
  pinnedLiveEntrySha,
  productionChanged: false,
  browserLaunches: 0,
  builds: 0,
  gpuCommands: 0,
  benchmarks: 0,
  variants: [],
};
report.helperHashes = {};
for (const path of ['test-results/live-island-setting-overrides.mjs', 'test-results/live-island-quality-override.mjs'])
  report.helperHashes[path] = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
for (const setting of ['control', ...liveIslandSettingNames]) {
  const result = liveIslandSettingOverride(source, setting),
    path = `test-results/live-island-${setting}-private.js`;
  await writeFile(path, result.code);
  report.variants.push({
    path,
    helperMatches: result.helperMatches,
    dprMatches: result.dprMatches,
    settingMatches: result.settingMatches,
    ...result.metadata,
  });
}
await writeFile('test-results/live-island-setting-overrides-preparation.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
