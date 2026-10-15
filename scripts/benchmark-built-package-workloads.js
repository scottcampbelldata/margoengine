import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPackageWorkloads } from './support/build-package-workloads.js';

// This adapter changes delivery only. It preserves the existing runner's actual
// scene/workload/control/count/worker/cleanup/strict-target assertions verbatim.
const arguments_ = process.argv.slice(2),
  buildOnly = arguments_.includes('--build-only'),
  existing = arguments_.find((value) => value.startsWith('--artifact='));
assert.ok(
  arguments_.every((value) => value === '--build-only' || value.startsWith('--artifact=')),
  'Unknown built fixture argument',
);
const directory = existing ? resolve(existing.slice('--artifact='.length)) : (await buildPackageWorkloads()).directory;
process.env.WORKLOAD_BUILT_DIR = directory;
console.log(JSON.stringify({ builtArtifact: directory, buildOnly, productionSourceChanged: false }));
if (!buildOnly) {
  process.env.WORKLOAD_PACKAGES ??= 'loaders,exporters,usdz-export,decoders,ifc,fbx,points,toon,transitions';
  process.env.WORKLOAD_REPORT_PREFIX ??= `package-built-assets-${new Date().toISOString().replace(/[^0-9TZ]/g, '')}`;
  let source = await readFile('scripts/benchmark-package-workloads.js', 'utf8');
  const replace = (before, after) => {
    assert.equal(source.split(before).length, 2, `Built runner anchor changed: ${before.slice(0, 100)}`);
    source = source.replace(before, after);
  };
  replace("'../tests/support/png.js'", JSON.stringify(pathToFileURL(resolve('tests/support/png.js')).href));
  replace("'./browser.js'", JSON.stringify(pathToFileURL(resolve('scripts/support/built-workload-browser.js')).href));
  replace(
    '`${origin}/examples/package-benchmarks/index.html?package=${name}`',
    '`${origin}/index.html?package=${name}`',
  );
  replace(
    'traceEnabled: trace,',
    "traceEnabled: trace, delivery: {kind: 'built-static-preview', artifact: browser.artifact, freshContexts: true, cacheDisabled: false, networkThrottle: null},",
  );
  replace(
    'Local Vite startup is not a cold production or physical-phone result.',
    'Built real dist fixtures use static preview and fresh contexts, without throttling or explicit cache disabling; this is not hosted cold-network or physical-phone acceptance.',
  );
  replace(
    'if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await runBenchmarks();',
    'await runBenchmarks();',
  );
  await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
