// Draws every recorded render pipeline of the WGSL corpus once through the compatibility device (run by
// `npm run test:browser`, part of check:merge; run from the repository root). Linking is not enough: ANGLE's Direct3D
// back end compiles the pixel shader at the first draw, for the formats bound then, and a shader its HLSL compiler
// cannot build loses the context there (a translation with emulated dynamic vector indexing in every uniform read did).
// Pipelines that need storage resources or compute wait for later milestones and are counted, not drawn.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { readCorpus } from './corpus/store.mjs';

const { modules } = readCorpus();
const sources = {},
  records = [],
  seen = new Set();
for (const m of modules) {
  sources[m.key] = m.code;
  for (const p of m.pipelines) {
    if (p.kind !== 'render' || !p.vertex || p.vertex.module !== m.key) continue;
    const id = JSON.stringify([p.vertex, p.fragment, p.primitive, p.depthStencil, p.multisample]);
    if (seen.has(id)) continue;
    seen.add(id);
    records.push({ ...p, id: `${m.package} ${m.key} ${p.vertex.entryPoint ?? ''}/${p.fragment?.entryPoint ?? ''}` });
  }
}

const context = await openBrowser({ startPath: '/packages/webgl2-compat/test/corpus-draw.html', port: 'free' });
try {
  const { page } = context;
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const result = await page.evaluate(({ records, sources }) => window.drawAll(records, sources), { records, sources });
  const later = Object.entries(result.waiting)
    .map(([reason, n]) => `  ${n} x ${reason}`)
    .join('\n');
  console.log(
    `GLSL corpus draws: ${result.drawn} of ${records.length} recorded render pipelines drawn on WebGL2; waiting:\n${later}`,
  );
  if (result.failures.length) console.log(`FAILURES ${result.failures.length}:\n${result.failures.join('\n')}`);
  assert.deepEqual(result.failures, []);
  assert.ok(result.drawn > 200, `only ${result.drawn} pipelines drawn`);
} finally {
  await context.close();
}
