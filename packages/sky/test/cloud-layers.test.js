// Two cloud layers on one engine (KB-SKY-CLOUDTWO1): until 2026-11-28 every VolumetricClouds was named
// 'sky:volumetric-clouds' and added a pass of that name, so the engine refused a second layer with "Invalid plugin".
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VolumetricClouds,
  CLOUD_FLOATS,
  CLOUD_LAYER_NAME,
  cloudDeckTransmittance,
  isCloudLayerName,
  layerOf,
} from '@margoengine/sky/volumetric-clouds';
import { Sky } from '@margoengine/sky';
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

// Scud under a deck (storm-sky plan step 2): the link, its closed-form light, the air bands and the camera's order.
const uniformsOf = (h) => {
  const seen = new Map(),
    queue = h.engine.gpu.queue,
    write = queue.writeBuffer.bind(queue);
  queue.writeBuffer = (buffer, offset, data, ...rest) => {
    if (data instanceof Float32Array && data.length === CLOUD_FLOATS) seen.set(buffer, data.slice());
    return write(buffer, offset, data, ...rest);
  };
  return seen;
};
async function linked(camera = [0, 2, 0], extra = {}) {
  const h = tracedGPU();
  h.context.camera.position = camera;
  const seen = uniformsOf(h),
    deck = VolumetricClouds.attach(h.engine, {
      bottom: 650,
      top: 1300,
      coverage: 0.9,
      density: 0.06,
      sunDirection: [0.2, 0.8, 0.1],
      mist: { visibility: 6000 },
    }),
    scud = VolumetricClouds.attach(h.engine, {
      type: 'scud',
      above: deck,
      weather: { cloud: 1, rain: 1 },
      sunDirection: [0.2, 0.8, 0.1],
      ...extra,
    });
  await scud.ready;
  const order = [];
  for (const [name, layer] of [
    ['deck', deck],
    ['scud', scud],
  ]) {
    const paint = layer.paint.bind(layer);
    layer.paint = (c) => (order.push(name), paint(c));
  }
  frame(h, deck, scud);
  return { h, deck, scud, order, seen };
}

test('a scud layer under a deck takes its defaults from the deck and the weather', async () => {
  const { deck, scud } = await linked();
  assert.equal(scud.name, 'sky:volumetric-clouds:scud');
  const layer = layerOf(scud.options);
  assert.equal(layer.bottom, 260, '0.4 of the deck base');
  assert.equal(layer.top, 460);
  assert.equal(layer.coverage, 0.35, 'full rain');
  assert.equal(layerOf({ type: 'scud', weather: { cloud: 1 } }).coverage, 0, 'none in dry air');
  assert.throws(
    () => new VolumetricClouds({ above: deck, bottom: 500, top: 800 }),
    /must be at or below the base of the layer above \(650 m\)/,
  );
  assert.throws(() => new VolumetricClouds({ above: {} }), /above must be the other VolumetricClouds layer/);
  assert.throws(() => new VolumetricClouds({ shear: 1e6 }), /Invalid VolumetricClouds options/);
});

test('the upper draws both layers once, in the camera order', async () => {
  const under = await linked([0, 2, 0]);
  assert.deepEqual(under.order, ['deck', 'scud'], 'from the street the deck is farther: it draws first');
  assert.equal(draws(under.h), 2, 'each layer one fullscreen draw');
  const gap = await linked([0, 560, 0]);
  assert.deepEqual(gap.order, ['scud', 'deck'], 'from between them the scud below is the farther');
  under.scud.dispose();
  const before = under.order.length;
  frame(under.h, under.deck);
  assert.deepEqual(under.order.slice(before), ['deck'], 'the deck alone again');
});

test('the link: the deck dims the scud, the scud the ground lights on the deck, and the deck air stops at the scud', async () => {
  const { h, deck, scud, seen } = await linked([0, 2, 0]);
  const d = seen.get(deck.uniform),
    s = seen.get(scud.uniform),
    upper = layerOf(deck.options),
    lower = layerOf(scud.options);
  assert.ok(d && s, 'both layers wrote their uniform');
  assert.equal(d[303], lower.top, "the deck's air band ends on the scud's tops");
  assert.equal(s[303], 0, "the scud's goes to the ground");
  assert.ok(Math.abs(s[306] - cloudDeckTransmittance(upper, 0.6)) < 1e-6, 'sky light through the deck');
  assert.ok(Math.abs(s[304] - cloudDeckTransmittance(upper, Math.max(s[21], 0.1))) < 1e-6, 'sun through the deck');
  assert.equal(s[308], 650, 'the deck base glows back down from its height');
  assert.ok(s[309] > 0 && s[309] < 1, 'by its reflectance');
  assert.equal(s[302], 1, 'the scud shape');
  assert.ok(Math.abs(s[32] - 1 / 2200) < 1e-9, 'scud scale');
  assert.ok(Math.hypot(s[300], s[301]) > 0, 'scud leans with the wind');
  assert.equal(d[300], 0, 'the deck stands upright by default');
  assert.ok(s[296] > 0, "the scud takes the deck's mist under it");
  assert.ok([...h.shaders.values()].join(' ').includes('fn cloudScudDensity('), 'the scud shape is compiled in');
});

test("the sky's deck is the product of both layers, and the deck's own again once the scud goes", async () => {
  const h = tracedGPU(),
    sky = new Sky({ hours: 10, timeScale: 0 });
  h.engine.use(sky);
  const deck = VolumetricClouds.attach(h.engine, { sky, bottom: 650, top: 1300, coverage: 0.9 }),
    scud = VolumetricClouds.attach(h.engine, { sky, type: 'scud', above: deck, weather: { cloud: 1, rain: 1 } });
  await scud.ready;
  frame(h, sky, deck, scud);
  const both = sky.deck(0.8),
    alone = cloudDeckTransmittance(layerOf(deck.options), 0.8) * cloudDeckTransmittance(layerOf(scud.options), 0.8);
  assert.ok(Math.abs(both - alone) < 1e-12, `${both} against ${alone}`);
  scud.dispose();
  frame(h, sky, deck);
  assert.ok(Math.abs(sky.deck(0.8) - cloudDeckTransmittance(layerOf(deck.options), 0.8)) < 1e-12);
  deck.dispose();
  assert.equal(sky.deck, undefined);
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
