// @margoengine/optics/screens without a GPU: looks pack into the flat values the shader reads, a live `set` rewrites only
// the values that changed, bad input is refused, and every set on one engine shares one RawShaders plugin. The pixels
// are checked on real WebGPU and on the WebGL2 compatibility layer by tests/screens-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OpticsScreens,
  packBeam,
  packFringes,
  packSpot,
  screensFragmentShader,
  screensVertexShader,
} from '../dist/screens.js';

function standIn() {
  const plugins = [];
  return {
    plugins,
    use(plugin) {
      if (plugins.some((p) => p.name === plugin.name)) throw new TypeError('Invalid plugin');
      plugins.push(plugin);
      plugin.engine = this;
      return this;
    },
  };
}
const parent = {};

test('each part kind has a branch, and the stages declare their entry points', () => {
  assert.match(screensVertexShader, /@vertex fn vertex/);
  assert.match(screensFragmentShader, /@fragment fn fragment/);
  for (const kind of ['i.kind<0.5', 'i.kind<2.5', 'i.kind<3.5', 'i.kind<4.5', 'reflect('])
    assert.ok(screensFragmentShader.includes(kind), kind);
});

test('a beam look packs its Gaussian weights, falloffs and colours in the order the shader reads them', () => {
  const slots = packBeam({
    edge: [0.1, 0.2, 0.3],
    core: [0.4, 0.5, 0.6],
    coreMix: 0.7,
    colorFalloff: 8,
    coreFalloff: 24,
    coreWeight: 0.9,
    haloFalloff: 4,
    haloWeight: 0.1,
    lengthBase: 1,
    lengthSlope: 0.3,
    lengthTaper: -0.2,
    opacity: 0.5,
  });
  assert.deepEqual(slots, [
    [0.1, 0.2, 0.3, 0.7],
    [0.4, 0.5, 0.6, 8],
    [24, 0.9, 4, 0.1],
    [1, 0.3, -0.2, 0.5],
    [0, 0, 0, 0],
  ]);
});

test('a spot packs its hard core and a fringe screen its frequency and cycles', () => {
  const spot = packSpot({
    edge: [0, 0, 0],
    core: [1, 1, 1],
    coreMix: 1,
    colorFalloff: 0,
    innerFalloff: 0,
    innerWeight: 1,
    outerFalloff: 0,
    outerWeight: 0,
    fade: 1,
    opacity: 1,
    hardCore: [0.035, 0.13],
  });
  assert.deepEqual(spot[4], [0.035, 0.13, 0, 0]);
  const fringes = packFringes({
    frequency: 3,
    cycles: 0.25,
    visibility: 0.9,
    waist: 1.5,
    edge: [1, 0, 0],
    core: [1, 1, 0],
    gamma: 0.8,
    gain: 2,
    body: [0, 0, 0],
    glow: [0.1, 0.1, 0.1],
    markWeight: 0.2,
  });
  assert.deepEqual(fringes[2], [3, 0.25, 1.5, 2]);
  assert.equal(fringes[0][3], 0.9);
});

test('every set on an engine shares one RawShaders plugin, and parts carry one vertex value per corner', () => {
  const engine = standIn();
  const glow = OpticsScreens.attach(engine),
    solid = OpticsScreens.attach(engine, { blending: 'none' });
  assert.equal(engine.plugins.length, 1);
  assert.equal(glow.raw, solid.raw);
  assert.equal(glow.material.transparent, true);
  assert.equal(solid.material.transparent, false);
  assert.equal(solid.material.depthWrite, true);
  const beam = glow.beam(parent, { opacity: 0.83 });
  assert.equal(beam.mesh.getAttribute('a').data.length, 8 * 4);
  assert.equal(beam.mesh.getAttribute('d').data[3], Math.fround(0.83));
  const facet = solid.facet(parent, [[0, 0, 0], [1, 0, 0], [0, 1, 0]], [0, 0, 1], { tint: [0, 1, 0] });
  assert.deepEqual([...facet.mesh.getAttribute('direction').data], [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  glow.dispose();
  solid.dispose();
});

test('set rewrites only the flat values that changed, and a plate turns into a disc', () => {
  const screens = OpticsScreens.attach(standIn());
  const detector = screens.fringes(parent, 0.1, { frequency: 2 });
  const written = [];
  const original = detector.mesh.setAttribute.bind(detector.mesh);
  detector.mesh.setAttribute = (name, data) => {
    written.push(name);
    return original(name, data);
  };
  detector.set({ cycles: 0.5 });
  assert.deepEqual(written, ['c']);
  assert.equal(detector.mesh.getAttribute('c').data[1], 0.5);
  const plate = screens.plate(parent, 0.2, 0.1);
  assert.equal(plate.mesh.getAttribute('kind').data[0], 1);
  plate.set({ shape: 'disc' });
  assert.equal(plate.mesh.getAttribute('kind').data[0], 2);
  screens.dispose();
});

test('unknown fields, non-finite numbers, bad sizes and bad blends are refused', () => {
  const screens = OpticsScreens.attach(standIn());
  assert.throws(() => screens.beam(parent, { colour: [1, 0, 0] }), /unknown look field colour/);
  assert.throws(() => screens.beam(parent, { opacity: Number.NaN }), /finite/);
  assert.throws(() => screens.spot(parent, 0, 1), /positive/);
  assert.throws(() => screens.plate(parent, 1, 1, { shape: 'hex' }), /rect or disc/);
  assert.throws(() => screens.facet(parent, [[0, 0, 0]], [0, 0, 1]), /three/);
  assert.throws(() => OpticsScreens.attach(standIn(), { blending: 'multiply' }), /none, normal or additive/);
  screens.dispose();
});
