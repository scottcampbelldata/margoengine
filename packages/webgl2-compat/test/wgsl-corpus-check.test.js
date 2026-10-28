// The WGSL front end against the whole corpus (test/corpus: every module the packages create in their real-GPU
// checks, recorded by `npm run record:wgsl-corpus`). Every module parses and type-checks; the entry points it finds are
// the ones the manifest lists; and for every pipeline the browser accepted with an explicit layout, each resource the
// checked entry point reaches sits at a binding of the same kind, visible to its stage, and every pipeline constant
// names an override. The browser validated those pipelines, so a mismatch is a front-end bug.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWGSL } from '../dist/wgsl.js';
import { readCorpus } from './corpus/store.mjs';

const { modules } = readCorpus();
const checked = new Map();

test('every corpus module parses and type-checks', () => {
  const failures = [];
  for (const m of modules) {
    try {
      checked.set(m.key, checkWGSL(m.code));
    } catch (error) {
      failures.push(`${m.key} (${m.package}): ${error.message}`);
    }
  }
  assert.deepEqual(failures, []);
  assert.equal(checked.size, modules.length);
});

test('the entry points the checker finds are the ones the manifest lists', () => {
  for (const m of modules) {
    const ir = checked.get(m.key) ?? checkWGSL(m.code);
    const found = {};
    for (const e of ir.entryPoints) (found[e.stage] ??= []).push(e.name);
    for (const list of Object.values(found)) list.sort();
    const listed = Object.fromEntries(Object.entries(m.entryPoints).map(([s, l]) => [s, [...l].sort()]));
    assert.deepEqual(found, listed, m.key);
  }
});

const STAGE_BIT = { vertex: 1, fragment: 2, compute: 4 };
const DIMENSION = {
  '1d': '1d',
  '2d': '2d',
  '2d_array': '2d-array',
  '3d': '3d',
  cube: 'cube',
  cube_array: 'cube-array',
};
const ACCESS = { read: 'read-only', write: 'write-only', read_write: 'read-write' };

/** Why a resource variable cannot be bound at a layout entry, or undefined when it can (WebGPU "validating shader binding"). */
function mismatch(g, entry, stage) {
  if (!(entry.visibility & STAGE_BIT[stage])) return `not visible to the ${stage} stage`;
  const t = g.type;
  if (g.space === 'uniform') return entry.buffer?.type === 'uniform' ? undefined : 'expected a uniform buffer';
  if (g.space === 'storage') {
    const want = g.access === 'read' ? 'read-only-storage' : 'storage';
    return entry.buffer?.type === want ? undefined : `expected a ${want} buffer`;
  }
  if (t.kind === 'sampler') {
    if (!entry.sampler) return 'expected a sampler';
    return t.comparison === (entry.sampler.type === 'comparison') ? undefined : 'sampler comparison differs';
  }
  if (t.kind === 'texture') {
    if (t.shape === 'external') return entry.externalTexture ? undefined : 'expected an external texture';
    if (t.shape === 'storage') {
      const s = entry.storageTexture;
      if (!s) return 'expected a storage texture';
      if (s.format !== t.format) return `format ${s.format} vs ${t.format}`;
      if (s.access !== ACCESS[t.access]) return `access ${s.access} vs ${t.access}`;
      return s.viewDimension === DIMENSION[t.dimension] ? undefined : `dimension ${s.viewDimension} vs ${t.dimension}`;
    }
    const x = entry.texture;
    if (!x) return 'expected a texture';
    if (x.viewDimension !== DIMENSION[t.dimension]) return `dimension ${x.viewDimension} vs ${t.dimension}`;
    if (x.multisampled !== (t.shape === 'multisampled' || t.shape === 'depth_multisampled'))
      return 'multisampling differs';
    const sample = t.shape === 'depth' || t.shape === 'depth_multisampled' ? 'depth' : t.sampled.name;
    const allowed = {
      depth: ['depth', 'unfilterable-float'],
      f32: ['float', 'unfilterable-float'],
      i32: ['sint'],
      u32: ['uint'],
    }[sample];
    return allowed.includes(x.sampleType) ? undefined : `sample type ${x.sampleType} for ${sample}`;
  }
  return `unexpected resource type ${t.kind}`;
}

test('every recorded pipeline binds each resource its entry point reaches at a matching layout entry', () => {
  let pipelines = 0,
    bindings = 0;
  for (const m of modules) {
    const ir = checked.get(m.key) ?? checkWGSL(m.code);
    for (const p of m.pipelines) {
      for (const stage of ['vertex', 'fragment', 'compute']) {
        const s = p[stage];
        if (!s || s.module !== m.key) continue;
        const candidates = ir.entryPoints.filter((e) => e.stage === stage);
        const entry = s.entryPoint === undefined ? candidates : candidates.filter((e) => e.name === s.entryPoint);
        assert.equal(entry.length, 1, `${m.key}: ${stage} entry point ${s.entryPoint ?? '(default)'}`);
        const overrides = ir.globals.filter((g) => g.kind === 'override');
        for (const name of Object.keys(s.constants ?? {}))
          assert.ok(
            overrides.some((o) => o.name === name || String(o.id) === name),
            `${m.key}: pipeline constant '${name}' names no override`,
          );
        if (!Array.isArray(p.layout)) continue;
        pipelines++;
        for (const g of entry[0].globals) {
          if (g.kind !== 'var' || g.group === undefined) continue;
          const group = p.layout[g.group];
          if (group === 'unrecorded') continue;
          const at = Array.isArray(group) ? group.find((e) => e.binding === g.binding) : undefined;
          assert.ok(
            at,
            `${m.key} ${entry[0].name}: '${g.name}' at @group(${g.group}) @binding(${g.binding}) has no layout entry`,
          );
          const why = mismatch(g, at, stage);
          assert.equal(
            why,
            undefined,
            `${m.key} ${entry[0].name}: '${g.name}' at @group(${g.group}) @binding(${g.binding}): ${why}`,
          );
          bindings++;
        }
      }
    }
  }
  // The corpus has hundreds of explicit layouts; a near-empty count means the records were not read.
  assert.ok(pipelines > 200 && bindings > 1000, `${pipelines} pipelines, ${bindings} bindings`);
});
