// The objects entry without a GPU: argument checks (its drawing is proved on a real GPU by objects-check.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeObjects } from '../dist/objects.js';

test('BiomeObjects.attach checks its engine, placement, heightmap, bounds and distances', async () => {
  const engine = { camera: { position: [0, 0, 0] } },
    placement = { tile() {}, species: [], details: [], tileSize: 256 };
  await assert.rejects(BiomeObjects.attach(engine, {}, {}), TypeError);
  await assert.rejects(BiomeObjects.attach(engine, placement, { bounds: [0, 0, 1, 1] }), TypeError);
  await assert.rejects(
    BiomeObjects.attach(engine, placement, { heightmap: () => undefined, bounds: [0, 0, 1, 1], radius: 0 }),
    RangeError,
  );
});

test('detail maps have a byte budget and the device texture limit, checked before anything is allocated (bug 64)', async () => {
  const { detailFits, DETAIL_BUDGET } = await import('../dist/objects.js'),
    engine = { camera: { position: [0, 0, 0] }, gpu: { limits: { maxTextureDimension2D: 8192 } } },
    details = [{ id: 'grass' }, { id: 'fern' }, { id: 'reeds' }],
    placement = { tile() {}, species: [], details, tileSize: 256 },
    heightmap = () => undefined;
  assert.equal(DETAIL_BUDGET, 128 * 1024 * 1024);
  // The zero-config world (4 km, 2 m texels, five detail species) fits.
  assert.ok(detailFits([-2049, -2049, 2049, 2049], 2, 5, 8192));
  // A 1,000 km world at 1 cm would ask for 10^16 bytes per species: refused with the coded error, at once.
  const start = performance.now();
  await assert.rejects(
    BiomeObjects.attach(engine, placement, { heightmap, bounds: [0, 0, 1e6, 1e6], detailResolution: 0.01 }),
    (error) => error.code === 'unsupported' && /detailBudget/.test(error.message),
  );
  assert.ok(performance.now() - start < 100, 'no allocation before the check');
  // Within the texture limit but over the default budget; a raised budget lets it through the check.
  const bounds = [0, 0, 8000, 8000];
  assert.ok(!detailFits(bounds, 1, 3, 8192));
  assert.ok(detailFits(bounds, 1, 3, 8192, 3 * 8000 * 8000));
  // Past the device's largest texture no budget helps.
  assert.ok(!detailFits([0, 0, 20000, 20000], 2, 1, 8192, 1e12));
  await assert.rejects(
    BiomeObjects.attach(engine, placement, { heightmap, bounds: [0, 0, 20000, 20000], detailBudget: 1e12 }),
    { code: 'unsupported' },
  );
  await assert.rejects(BiomeObjects.attach(engine, placement, { heightmap, bounds, detailBudget: 0 }), RangeError);
  await assert.rejects(BiomeObjects.attach(engine, placement, { heightmap, bounds: [10, 0, 0, 10] }), RangeError);
});
