import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformWithOxc } from 'vite';
import { VoxelPathTracer } from '../dist/index.js';
import { fakeEngine } from './support.js';

test('the introductory README scene attaches with exactly the documented voxel data', async () => {
  const markdown = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const code = markdown.match(/```ts\r?\n([\s\S]*?)```/)[1];
  // Execute the actual example up to capture with its real tracer and scene
  // validation. Browser execution also checks its capture in check:readme-run.
  const prefix = code.slice(0, code.indexOf('const png =')).replace(/^import .*;\r?\n/gm, '');
  const { code: javascript } = await transformWithOxc(prefix, 'readme.ts', { lang: 'ts' });
  const h = fakeEngine();
  const run = new Function(
    'Engine',
    'VoxelPathTracer',
    'document',
    `return (async()=>{${javascript};return {scene,tracer};})()`,
  );
  const { scene, tracer } = await run({ create: async () => h.engine }, VoxelPathTracer, { querySelector: () => ({}) });
  try {
    const model = scene.models[0];
    assert.equal(
      model.voxels.length,
      model.size.reduce((a, b) => a * b, 1),
    );
    assert.ok(model.voxels.some((value) => value !== 0));
  } finally {
    tracer.dispose();
  }
});
