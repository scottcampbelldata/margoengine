// Sheet row 8: Water's surf broke only on the GPU, so nothing on the CPU knew where the breakers were and a weather
// drive could not thicken the spray there. breakerDepth gives the depth the swell starts breaking at (the shoaled
// root-mean-square envelope reaching McCowan's 0.78 of the depth), contourSegments that depth's seabed contour, and
// Water.breakerLine both from the Water's own trains and `terrain.heights`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BREAKER_GAMMA, Water, breakerDepth, contourSegments } from '../dist/index.js';
const refused = { name: 'MargoError', code: 'unsupported', message: /errors#ocean/ };

const shoal = (k0, d) => {
  const k = k0 / Math.tanh((k0 * d) ** 0.75) ** (2 / 3),
    kh = k * d;
  return Math.sqrt((0.5 * k) / ((0.5 + kh / Math.sinh(2 * kh)) * k0));
};

test('breakerDepth: the deepest water where the shoaled swell reaches 0.78 of the depth', () => {
  assert.equal(BREAKER_GAMMA, 0.78);
  assert.equal(breakerDepth([]), 0);
  assert.equal(breakerDepth([{ amplitude: 0, wavenumber: 0.1 }]), 0);
  const k = (2 * Math.PI) / 60,
    d = breakerDepth([{ amplitude: 0.5, wavenumber: k }]);
  // The three spectral components of the train: 0.4, 0.35 and 0.25 of its amplitude at 1, 0.84 and 1.18 of its wavenumber.
  const height = (h) =>
    2 * Math.sqrt((0.2 * shoal(k, h)) ** 2 + (0.175 * shoal(0.84 * k, h)) ** 2 + (0.125 * shoal(1.18 * k, h)) ** 2);
  assert.ok(Math.abs(height(d) - 0.78 * d) < 2e-3, `at ${d} m the swell is ${height(d)} m against ${0.78 * d}`);
  for (let h = d + 0.01; h < 30; h *= 1.1) assert.ok(height(h) < 0.78 * h, `deeper, at ${h} m, it does not break`);
  assert.ok(d > 0.6 && d < 1.5, `a 1 m, 60 m swell breaks in about 1 m of water: ${d}`);
  // Twice the swell breaks in deeper water, though less than twice as deep (it shoals less there).
  const d2 = breakerDepth([{ amplitude: 1, wavenumber: k }]);
  assert.ok(d2 > 1.4 * d && d2 < 2 * d, `${d2} against ${d}`);
  // KB-WATER-SURFFIELD1: a wind sea's empty long trains (amplitude 1e-31) do not set the field; the peak train does.
  const peak = breakerDepth([
    { amplitude: 1e-31, wavenumber: (2 * Math.PI) / 1500 },
    { amplitude: 0.5, wavenumber: k },
  ]);
  assert.ok(Math.abs(peak - d) < 1e-9, `a negligible long train leaves the line: ${peak} against ${d}`);
  assert.throws(() => breakerDepth([{ amplitude: -1, wavenumber: k }]), RangeError);
  assert.throws(() => breakerDepth([{ amplitude: 1, wavenumber: 0 }]), RangeError);
});

test('contourSegments: the level crossing of a plane is a straight line through the texel centres, saddles split by the mean', () => {
  // Ground falling 1 in 50 toward +x over 100 x 20 m in 100 x 20 texels: the 1 m deep contour at x = 50.
  const w = 100,
    h = 20,
    data = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = -(i + 0.5) / 50;
  const lines = contourSegments({ data, width: w, height: h }, [0, 0], [100, 20], -1);
  assert.equal(lines.length, h - 1, 'one segment per cell row the line crosses');
  for (const line of lines)
    for (const [x, z] of line) {
      assert.ok(Math.abs(x - 50) < 1e-4, `on x = 50: ${x}`);
      assert.ok(z >= 0.5 && z <= 19.5);
    }
  assert.deepEqual(
    contourSegments({ data, width: w, height: h }, [0, 0], [100, 20], 5),
    [],
    'no ground at that height',
  );
  // A saddle: two opposite corners above.
  const saddle = contourSegments({ data: [1, -1, -1, 1], width: 2, height: 2 }, [0, 0], [2, 2], 0);
  assert.equal(saddle.length, 2);
});

test('Water.breakerLine follows its own trains and terrain.heights, and is empty without heights', () => {
  const w = 200,
    h = 16,
    data = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = -(-50 + i * 2 + 1) / 50;
  const terrain = {
      heightmap: () => undefined,
      origin: [-50, -16],
      size: [400, 32],
      heights: { data, width: w, height: h },
    },
    waves = [{ direction: [-1, 0], amplitude: 0.5, wavelength: 60, steepness: 0.35 }],
    water = new Water({ size: [400, 400], terrain, waves }),
    d = breakerDepth([{ amplitude: 0.5, wavenumber: Math.fround((2 * Math.PI) / 60) }]),
    lines = water.breakerLine();
  assert.ok(lines.length > 0);
  for (const line of lines)
    for (const [x] of line) assert.ok(Math.abs(x - 50 * d) < 1e-3, `the line at ${x} m, ${d} m deep on a 1:50 beach`);
  assert.equal(water.breakerLine(), lines, 'kept until the sea changes');
  assert.deepEqual(
    new Water({ size: [400, 400], terrain: { ...terrain, heights: undefined }, waves }).breakerLine(),
    [],
  );
  assert.deepEqual(new Water({ size: [400, 400], waves }).breakerLine(), []);
  // A rising wind raises the sea, and the line moves out into deeper water.
  const windy = new Water({ size: [400, 400], terrain, wind: 6 }),
    calm = Math.max(
      ...windy
        .breakerLine()
        .flat()
        .map(([x]) => x),
    );
  windy.setWind(14);
  const rough = Math.max(
    ...windy
      .breakerLine()
      .flat()
      .map(([x]) => x),
  );
  assert.ok(rough > calm + 5, `the breakers move out from ${calm} to ${rough} m`);
  assert.throws(
    () => new Water({ terrain: { ...terrain, heights: { data, width: w, height: h + 1 } }, waves }),
    refused,
  );
});

test('terrain.heights wider than 512 cells: accepted up to 8,192 a side, refused past it (FG-02)', () => {
  const ramp = (w, h) => {
    const data = new Float32Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = -(i + 0.5) / 100;
    return { data, width: w, height: h };
  };
  const waves = [{ direction: [-1, 0], amplitude: 0.5, wavelength: 60, steepness: 0.35 }],
    terrain = (heights, size) => ({ heightmap: () => undefined, origin: [0, 0], size, heights });
  const wide = new Water({ size: [4000, 400], terrain: terrain(ramp(2048, 4), [4096, 8]), waves });
  assert.ok(wide.breakerLine().length > 0, 'a 2,048-cell coast has a breaker line');
  assert.doesNotThrow(() => new Water({ size: [400, 400], terrain: terrain(ramp(8192, 2), [8192, 2]), waves }));
  assert.throws(() => new Water({ size: [400, 400], terrain: terrain(ramp(8193, 2), [8193, 2]), waves }), refused);
});
