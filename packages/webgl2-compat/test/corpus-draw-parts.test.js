// The corpus draw check runs in parts, one package script each, so each part runs every one of its pipelines in full
// under the 10 minute GPU step limit (KB-COMPAT-CORPUSTIME1). The parts together must be the whole corpus.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readCorpus } from './corpus/store.mjs';
import { OWN_COMPUTE_PART, PARTS, corpusDrawWork, partsOf, scriptOf } from './corpus-draw-parts.mjs';

const { modules } = readCorpus();
const work = corpusDrawWork(modules);
const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;

test('every distinct corpus pipeline is drawn in exactly one part, and no part is empty', () => {
  // Counted here on their own: each module's pipelines that start in it, render by their stages and state, compute by
  // their stage; the voxel path tracer's compute pipelines run in its own browser check.
  const render = new Set(),
    compute = new Set();
  let pathTracer = 0;
  for (const m of modules)
    for (const p of m.pipelines) {
      if (p.compute?.module === m.key) {
        const id = JSON.stringify(p.compute);
        if (compute.has(id)) continue;
        compute.add(id);
        if (m.package === 'voxel-pathtracer') pathTracer++;
      } else if (p.kind === 'render' && p.vertex?.module === m.key)
        render.add(JSON.stringify([p.vertex, p.fragment, p.primitive, p.depthStencil, p.multisample]));
    }
  assert.equal(work.records.length, render.size);
  assert.equal(work.computes.length + work.outOfScope, compute.size);
  assert.equal(work.outOfScope, pathTracer);
  const ids = [...work.records, ...work.computes].map((r) => `${r.part} ${JSON.stringify([r.vertex, r.fragment, r.compute, r.primitive, r.depthStencil, r.multisample])}`);
  assert.equal(new Set(ids).size, ids.length, 'a pipeline is listed twice');
  for (const part of PARTS)
    assert.ok(
      [...work.records, ...work.computes].some((r) => r.part === part),
      `part ${part} has no pipelines: remove it from OWN_COMPUTE_PART`,
    );
  for (const r of work.records) assert.equal(r.part, 'render');
  for (const r of work.computes) {
    assert.ok(PARTS.includes(r.part), `${r.id} is in no listed part (${r.part}): raise its OWN_COMPUTE_PART count`);
    const own = Object.keys(OWN_COMPUTE_PART).find((name) => r.id.startsWith(`${name} `));
    assert.match(r.part, own ? new RegExp(`^compute-${own}-[0-9]+$`) : /^compute$/, r.id);
  }
  // A package of its own parts: one kernel in each, as many kernels as it says.
  for (const [name, count] of Object.entries(OWN_COMPUTE_PART)) {
    const kernels = work.computes.filter((r) => r.id.startsWith(`${name} `));
    assert.equal(kernels.length, count, `${name} records ${kernels.length} compute kernels; OWN_COMPUTE_PART says ${count}`);
    assert.equal(new Set(kernels.map((r) => r.part)).size, count);
  }
});

test('each part has its own package script running corpus-draw-browser.mjs on that part alone', () => {
  for (const part of PARTS) {
    const script = scripts[scriptOf(part)];
    assert.ok(script, `package.json has no "${scriptOf(part)}"`);
    const runs = [...script.matchAll(/corpus-draw-browser\.mjs((?:\s+--[\w-]+(?:=[\w,-]+)?)*)/g)].map((m) => m[1].trim());
    assert.deepEqual(runs, [`--part=${part}`], scriptOf(part));
  }
  // No other script draws the corpus, so no part runs twice in a GPU check.
  const drawing = Object.keys(scripts).filter((name) => scripts[name].includes('corpus-draw-browser.mjs'));
  assert.deepEqual(drawing.sort(), PARTS.map(scriptOf).sort());
});

test('partsOf reads --part, defaults to every part and names the parts for an unknown one', () => {
  assert.deepEqual(partsOf([]), PARTS);
  assert.deepEqual(partsOf(['--part=render']), ['render']);
  assert.deepEqual(partsOf(['--part=compute,render']), ['compute', 'render']);
  assert.throws(() => partsOf(['--part=draw']), /Unknown corpus draw part 'draw'; the parts are render, compute/);
});
