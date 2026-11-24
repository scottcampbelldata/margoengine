import test from 'node:test';
import assert from 'node:assert/strict';
import { activePlugins } from './plugin-state.mjs';

test('readiness counts current plugin identities across name reuse and deferred material attachment', () => {
  const opaque = { name: 'materials:opaque-color' },
    replacement = { name: opaque.name },
    installation = { name: 'materials:model:1' },
    engine = { plugins: new Map([[opaque.name, opaque]]) };
  const history = [opaque, replacement];
  engine.plugins.set(replacement.name, replacement);
  assert.equal(history.filter((plugin) => engine.plugins.has(plugin.name)).length, 2,
    'historical instances falsely satisfy the two-plugin readiness bar');
  assert.deepEqual(activePlugins(engine, 'materials:'), [replacement]);
  engine.plugins.set(installation.name, installation);
  assert.deepEqual(activePlugins(engine, 'materials:'), [replacement, installation]);
  engine.plugins.delete(installation.name);
  assert.deepEqual(activePlugins(engine, 'materials:'), [replacement]);
  assert.deepEqual(activePlugins(undefined, 'materials:'), []);
});
