// Draws every recorded render pipeline of the WGSL corpus once through the compatibility device (run by
// `npm run test:browser`, part of check:merge; run from the repository root). Linking is not enough: ANGLE's Direct3D
// back end compiles the pixel shader at the first draw, for the formats bound then, and a shader its HLSL compiler
// cannot build loses the context there (a translation with emulated dynamic vector indexing in every uniform read did).
// Then every recorded compute pipeline is planned, translated for its tier and dispatched once (milestone M5).
// `--part=render`, `--part=compute` or `--part=compute-<package>-<n>` runs one part (corpus-draw-parts.mjs): each is its
// own package script, as the whole draw takes ANGLE's Direct3D compiler more than one GPU step's 10 minutes
// (KB-COMPAT-CORPUSTIME1). With no `--part` it runs them all.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { readCorpus } from './corpus/store.mjs';
import {
  assertOverUnits,
  assertUnmappedCounts,
  RECORDED_UNMAPPED_ENABLES,
} from './support/corpus-refusals.mjs';
import { PARTS, corpusDrawWork, partsOf } from './corpus-draw-parts.mjs';

const parts = partsOf(process.argv.slice(2));
const { modules } = readCorpus();
const sources = Object.fromEntries(modules.map((m) => [m.key, m.code]));
const work = corpusDrawWork(modules);
const stray = [...work.computes, ...work.records].filter((r) => !PARTS.includes(r.part));
if (stray.length)
  throw new Error(`${stray.map((r) => r.id).join(', ')}: in no part; raise OWN_COMPUTE_PART in corpus-draw-parts.mjs`);
const records = work.records.filter((r) => parts.includes(r.part)),
  computes = work.computes.filter((r) => parts.includes(r.part)),
  outOfScope = work.outOfScope;

const context = await openBrowser({ startPath: '/packages/webgl2-compat/test/corpus-draw.html', port: 'free' });
try {
  const { page } = context;
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  if (parts.includes('render')) {
    const result = await page.evaluate(({ records, sources }) => window.drawAll(records, sources), {
      records,
      sources,
    });
    const later = Object.entries(result.waiting)
      .map(([reason, n]) => `  ${n} x ${reason}`)
      .join('\n');
    console.log(
      `GLSL corpus draws: ${result.drawn} of ${records.length} recorded render pipelines drawn on WebGL2; waiting:\n${later}`,
    );
    if (result.failures.length) console.log(`FAILURES ${result.failures.length}:\n${result.failures.join('\n')}`);
    assert.deepEqual(result.failures, []);
    console.log(
      `refused for an unmapped enable: ${JSON.stringify(result.enables)}; refused for texture units: ${result.overUnits.length}`,
    );
    assertUnmappedCounts(result.enables, RECORDED_UNMAPPED_ENABLES.draw, 'corpus draws');
    assertOverUnits(result.overUnits, 'corpus draws');
    assert.ok(result.drawn > 200, `only ${result.drawn} pipelines drawn`);
  }
  if (computes.length) {
    const compute = await page.evaluate(({ computes, sources }) => window.dispatchAll(computes, sources), {
      computes,
      sources,
    });
    const tiers = Object.entries(compute.tiers)
      .map(([tier, n]) => `  ${n} x ${tier}`)
      .join('\n');
    console.log(
      `WGSL corpus compute (${parts.filter((p) => p !== 'render').join(', ')}): ${computes.length - compute.validatedInvalid} recorded compute pipelines dispatched on WebGL2, ${compute.validatedInvalid} invalid pipelines correctly rejected (${outOfScope} of the voxel path tracer, checked on their own, not dispatched):\n${tiers}`,
    );
    if (compute.failures.length) console.log(`FAILURES ${compute.failures.length}:\n${compute.failures.join('\n')}`);
    assert.deepEqual(compute.failures, []);
    assert.equal(
      Object.values(compute.tiers).reduce((a, b) => a + b, 0) + compute.validatedInvalid,
      computes.length,
      'every recorded compute pipeline must dispatch or prove its required validation rejection',
    );
    // Nothing is refused: the light probes' bake kernels, which sample a cube map on the CPU tier, were the last.
    assert.deepEqual(
      Object.keys(compute.tiers).filter((tier) => tier.startsWith('refused')),
      [],
    );
  }
} finally {
  await context.close();
}
