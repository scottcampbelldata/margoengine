import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformWithOxc } from 'vite';
import { dilateGrid } from '../dist/index.js';

test('README shader-brush comparison computes its CPU reference once for every voxel', async () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = readme.slice(readme.indexOf('## Shader brushes'));
  const code = section.match(/```ts\r?\n([\s\S]*?)```/)[1];
  const { code: transpiled } = await transformWithOxc(code, 'brush-readme.ts');
  const js = transpiled.replace(/^import .*;\r?\n/gm, '');
  let references = 0,
    disposed = 0;
  const logs = [],
    brushes = { grow: 'grow' };
  const shaderBrush = {
    async create(_device, source) {
      return {
        async run(grid, options) {
          return source === brushes.grow ? dilateGrid(grid, { iterations: options.passes }) : { grid };
        },
        dispose() {
          disposed++;
        },
      };
    },
  };
  const reference = (...args) => {
    references++;
    assert.equal(references, 1, 'full-grid reference must not repeat inside a per-cell comparison');
    return dilateGrid(...args);
  };
  const navigator = {
    gpu: {
      async requestAdapter() {
        return {
          async requestDevice() {
            return {};
          },
        };
      },
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('dilateGrid', 'brushes', 'ShaderBrush', 'navigator', 'console', js)(
    reference,
    brushes,
    shaderBrush,
    navigator,
    { log: (...args) => logs.push(args) },
  );
  assert.equal(references, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1], true);
  assert.ok(logs[0][0] > 0);
  assert.equal(disposed, 2);
});
