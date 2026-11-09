import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { transformWithOxc } from 'vite';
import { readmeEntries } from '../scripts/support/readme-types.mjs';

// Execute the pasted examples against a strict single-owner engine. The real GPU runner
// separately proves the rendering APIs; this keeps accidental double attachment visible in verify.
for (const [name, marker] of [
  ['shadows', 'const sun ='],
  ['quality', 'const crisp ='],
  ['post', 'SMAA.attach('],
]) {
  test(`${name} README releases the current effect before replacing its owner`, async () => {
    const markdown = readFileSync(`packages/${name}/README.md`, 'utf8');
    const example = readmeEntries(markdown).find(({ code }) => code.includes(marker));
    assert.ok(example, `${name} ownership example must remain executable`);
    const engine = { createMesh: () => mesh(), start() {} },
      owners = [];
    const mesh = () => ({
      setGeometry() {
        return this;
      },
      setScale() {
        return this;
      },
      setPosition() {
        return this;
      },
    });
    let live;
    const attach = (host, options = {}) => {
      assert.equal(host, engine);
      assert.equal(live, undefined, 'release the old owner before attaching its replacement');
      const owner = {
        options,
        members: [],
        disposed: false,
        add(source) {
          this.members.push(source);
          return () => {};
        },
        dispose() {
          assert.equal(live, this);
          this.disposed = true;
          live = undefined;
        },
      };
      live = owner;
      owners.push(owner);
      return owner;
    };
    const effect = class {
      static attach = attach;
    };
    const globals = {
      document: { querySelector: () => ({}) },
      Engine: { create: async () => engine },
      EngineKernel: { create: async () => engine },
      box: () => ({}),
      Shadows: effect,
      SMAA: effect,
      PostStack: effect,
      Bloom: effect,
      Tonemap: effect,
      Glitch: effect,
      createStage: async () => ({ engine }),
      applyQualityTier() {},
      qualityPreset: () => ({}),
    };
    const source = example.code.replace(/^import[^\n]*\n/gm, '').replace(/^export \{\};\s*$/gm, '');
    const { code } = await transformWithOxc(source, 'ownership.ts', { target: 'es2022' });
    await runInNewContext(`(async () => {${code}\n})()`, globals, { timeout: 5000 });
    assert.equal(owners.length, 2, 'both documented configurations are exercised');
    assert.equal(owners[0].disposed, true);
    assert.equal(owners[1].disposed, false);
    if (name === 'shadows')
      assert.deepEqual(owners[1].members, owners[0].members, 'replacement keeps both scene casters');
  });
}
