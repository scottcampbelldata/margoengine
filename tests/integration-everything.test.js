import assert from 'node:assert/strict';
import test from 'node:test';
import { resourceLedger } from '../examples/integration/resources.mjs';
import { planContext } from '../scripts/check-merge.mjs';

test('integration ledger catches leaked resources and credits only their owning device destruction', () => {
  class Device {
    createBuffer() {
      return { destroy() {} };
    }
    createTexture() {
      return { destroy() {} };
    }
    createQuerySet() {
      return { destroy() {} };
    }
    destroy() {}
  }
  const original = Device.prototype.createBuffer;
  const ledger = resourceLedger(Device.prototype);
  try {
    const first = new Device(),
      second = new Device();
    const buffer = first.createBuffer();
    first.createTexture();
    second.createQuerySet();
    assert.equal(ledger.snapshot().live.length, 3);
    buffer.destroy();
    buffer.destroy();
    assert.equal(ledger.snapshot().live.length, 2);
    first.destroy();
    assert.deepEqual(
      ledger.snapshot().live.map((r) => r.kind),
      ['QuerySet'],
    );
    second.destroy();
    assert.deepEqual(ledger.snapshot(), { created: 3, live: [] });
  } finally {
    ledger.restore();
  }
  assert.equal(Device.prototype.createBuffer, original);
});

test('everything test pages and their imports enter the GPU footprint', { timeout: 120000 }, async () => {
  const ctx = await planContext(process.cwd());
  const footprint = ctx.footprints['gpu/root/test:integration:browser'];
  assert.ok(footprint, 'integration suite must be registered');
  assert.ok(footprint.files.has('examples/test-pages/integration-game.html'));
  assert.ok(footprint.files.has('examples/test-pages/integration-sciviz.html'));
  for (const name of [
    'gltf',
    'animation',
    'physics',
    'navmesh',
    'shadows',
    'post',
    'audio',
    'input',
    'controls',
    'ui',
    'save',
    'sciviz',
    'points',
    'lines',
    'labels',
    'compute',
    'loaders',
    'video',
    'html',
  ])
    assert.ok(footprint.packages.has(`@margoengine/${name}`), name);
});
