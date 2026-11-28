// KB-GPUMAIN1 (2026-11-28): stacked post stages joined their output's format, sample count, HDR flag and the canvas's
// premultiplied mark into a key string every frame to decide whether to rebuild their present pipeline. Each string cost
// about 28 B a frame and stage; when KB-POST-ALPHARIM1 (0b961a9441) added the premultiplied mark, the frame-alloc post
// scene (SSAO, Bloom, Tonemap, FXAA) rose from 1,528 B to 1,584 B a frame, over its floor. Stages now compare the
// fields through OutputKey, and pipeline caches key by format and then sample count: post measures 1,388 B.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OutputKey } from '../packages/shared/output-key.js';

test('OutputKey reports a change only when a field differs from the last build, and again after reset', () => {
  const key = new OutputKey(),
    output = { format: 'rgba8unorm', multisample: { count: 4 }, hdr: false };
  // `changed`, then `done` once the stage has built, as every stage calls them.
  const build = (o, straight, extra) => {
    const changed = key.changed(o, straight, extra);
    if (changed) key.done();
    return changed;
  };
  assert.equal(build(output, false), true, 'the first call builds');
  for (let i = 0; i < 3; i++) assert.equal(build(output, false), false, 'the same output keeps the pipeline');
  assert.equal(build({ ...output, format: 'bgra8unorm' }, false), true, 'format');
  assert.equal(build({ ...output, format: 'bgra8unorm', multisample: { count: 1 } }, false), true, 'samples');
  assert.equal(build({ format: 'bgra8unorm', multisample: { count: 1 }, hdr: true }, false), true, 'hdr');
  assert.equal(build({ format: 'bgra8unorm', multisample: { count: 1 }, hdr: true }, true), true, 'premultiplied');
  assert.equal(build({ format: 'bgra8unorm', multisample: { count: 1 }, hdr: true }, true, 5), true, 'extra');
  assert.equal(build({ format: 'bgra8unorm', multisample: { count: 1 }, hdr: true }, true, 5), false);
  assert.equal(build({ format: 'bgra8unorm', multisample: {} }, false), true, 'an unset sample count is a value');
  assert.equal(build({ format: 'bgra8unorm', multisample: {} }, false), false);
  key.reset();
  assert.equal(build({ format: 'bgra8unorm', multisample: {} }, false), true, 'reset forces a rebuild');
});

// KB-WATER-WARMUP1: a key that remembered the new fields in `changed` left a stage whose pipeline creation threw (a
// warm-up frame stopped there, @margoengine/quality/warm) with no pipeline on every later frame.
test('a build that throws is tried again on the next frame', () => {
  const key = new OutputKey(),
    output = { format: 'rgba8unorm', multisample: { count: 1 }, hdr: false };
  assert.equal(key.changed(output, false), true);
  // The stage threw before done(): the change stands.
  assert.equal(key.changed(output, false), true, 'the next frame builds again');
  key.done();
  assert.equal(key.changed(output, false), false);
});

test('every stage that asks an OutputKey whether it changed marks the build done', async () => {
  const missing = [];
  for (const pkg of await readdir('packages', { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = join('packages', pkg.name, 'src');
    let files;
    try {
      files = await readdir(src, { recursive: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!/\.(ts|tsx|js|mjs)$/.test(file)) continue;
      const text = await readFile(join(src, file), 'utf8');
      if (!text.includes('OutputKey')) continue;
      for (const [, name] of text.matchAll(/this\.(\w+)\.changed\(output/g))
        if (!text.includes(`this.${name}.done()`)) missing.push(`${join(src, file)} ${name}`);
    }
  }
  assert.deepEqual(missing, [], 'call done() once the stage has built from the changed key');
});

test('no stage joins its output format into a key string each frame', async () => {
  const found = [];
  for (const pkg of await readdir('packages', { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = join('packages', pkg.name, 'src');
    let files;
    try {
      files = await readdir(src, { recursive: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!/\.(ts|tsx|js|mjs)$/.test(file)) continue;
      const text = await readFile(join(src, file), 'utf8');
      if (/output\.format\s*\+/.test(text)) found.push(join(src, file));
    }
  }
  assert.deepEqual(found, [], 'compare the fields with OutputKey (packages/shared/output-key.js) instead');
});
