import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformWithOxc } from 'vite';
import { readmeEntries } from '../../../scripts/support/readme-types.mjs';
import { parseCube } from '../dist/index.js';

test('the first tonemap README example supplies its own valid identity LUT and disposes both owners', async () => {
  const example = readmeEntries(readFileSync(new URL('../README.md', import.meta.url), 'utf8'))[0];
  const uploads = [];
  const disposed = [];
  const engine = {};
  const globals = {
    fetch() {
      assert.fail('the copy-paste example must supply every LUT input');
    },
    async createStage(selector, options) {
      assert.equal(selector, '#viewport');
      assert.equal(options.backend, 'webgpu');
      return { engine, dispose: () => disposed.push('stage') };
    },
    Tonemap: {
      attach(host, options) {
        assert.equal(host, engine);
        return {
          options,
          setLUT: (text) => uploads.push(text === null ? null : parseCube(text)),
          dispose: () => disposed.push('tonemap'),
        };
      },
    },
  };
  const source = example.code.replace(/^import[^\n]*\n/gm, '').replace(/^export \{\};\s*$/gm, '');
  const { code } = await transformWithOxc(source, 'tonemap-readme.ts', { target: 'es2022' });
  await runInNewContext(`(async()=>{${code}})()`, globals, { timeout: 5000 });
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].size, 2);
  assert.deepEqual([...uploads[0].domainMin], [0, 0, 0]);
  assert.deepEqual([...uploads[0].domainMax], [1, 1, 1]);
  assert.deepEqual(
    [...uploads[0].data],
    [0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 0, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1],
  );
  assert.equal(uploads[1], null);
  assert.deepEqual(disposed, ['tonemap', 'stage']);
});
