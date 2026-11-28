// Two cloud layers on one engine (KB-SKY-CLOUDTWO1): until 2026-11-28 every VolumetricClouds was named
// 'sky:volumetric-clouds' and added a pass of that name, so the engine refused a second layer with "Invalid plugin".
import test from 'node:test';
import assert from 'node:assert/strict';
import { VolumetricClouds, CLOUD_LAYER_NAME, isCloudLayerName } from '@margoengine/sky/volumetric-clouds';
import { Weather } from '@margoengine/sky/weather';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';

const draws = (h) => h.commands().filter((c) => c === 'draw 3').length;
function frame(h, ...plugins) {
  for (const p of plugins) p.onPreUpdate(h.context.delta);
  h.context.bindings = [];
  h.engine.frameGraph.execute(h.context);
}

test('two cloud layers attach to one engine, each under its own name and pass', () => {
  const h = tracedGPU(),
    deck = VolumetricClouds.attach(h.engine, { bottom: 650, top: 1300, sunDirection: [0.2, 0.8, 0.1] }),
    scud = VolumetricClouds.attach(h.engine, {
      name: 'sky:volumetric-clouds:scud',
      bottom: 250,
      top: 450,
      sunDirection: [0.2, 0.8, 0.1],
    });
  assert.equal(deck.name, CLOUD_LAYER_NAME);
  assert.equal(scud.name, 'sky:volumetric-clouds:scud');
  assert.equal(h.engine.plugins.get(CLOUD_LAYER_NAME), deck);
  assert.equal(h.engine.plugins.get('sky:volumetric-clouds:scud'), scud);
  frame(h, deck, scud);
  assert.equal(draws(h), 2, 'both layers draw their fullscreen pass');
  // Removing one leaves the other drawing.
  scud.dispose();
  assert.equal(h.engine.plugins.has('sky:volumetric-clouds:scud'), false);
  assert.equal(h.engine.plugins.get(CLOUD_LAYER_NAME), deck);
  const before = draws(h);
  frame(h, deck);
  assert.equal(draws(h) - before, 1, 'the deck alone still draws');
  deck.dispose();
  // A layer under a name already taken is still refused, as any plugin is (core: "Invalid plugin"; this mock refuses
  // its pass).
  const again = tracedGPU();
  VolumetricClouds.attach(again.engine, {});
  assert.throws(() => VolumetricClouds.attach(again.engine, {}), /Invalid (plugin|pass)/);
});

test('a cloud layer name is the prefix or starts with it and a colon, and must be text', () => {
  assert.equal(isCloudLayerName('sky:volumetric-clouds'), true);
  assert.equal(isCloudLayerName('sky:volumetric-clouds:scud'), true);
  assert.equal(isCloudLayerName('sky:volumetric-cloudsx'), false);
  assert.equal(isCloudLayerName('sky:shafts'), false);
  assert.throws(() => new VolumetricClouds({ name: '' }), /name must be a non-empty string/);
  assert.throws(() => new VolumetricClouds({ name: 3 }), /name must be a non-empty string/);
});

test("the lightning flash reaches every cloud layer found by the name's prefix", () => {
  const h = tracedGPU(),
    deck = { name: 'sky:volumetric-clouds', options: { weather: { cloud: 1, rain: 1, lightning: 1 } }, setup() {} },
    scud = { name: 'sky:volumetric-clouds:scud', options: { bottom: 250, top: 450 }, setup() {} },
    other = { name: 'sky:volumetric-cloudsx', options: {}, setup() {} };
  for (const p of [deck, scud, other]) h.engine.use(p);
  const weather = new Weather({ intensity: 0.9, lightning: { seed: 3 } });
  h.engine.use(weather);
  weather.onPreUpdate(0.016);
  assert.equal(deck.options.flash, weather.cloudFlash);
  assert.equal(scud.options.flash, weather.cloudFlash);
  assert.equal(other.options.flash, undefined);
  weather.dispose();
});
