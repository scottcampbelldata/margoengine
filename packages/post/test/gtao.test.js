import test from 'node:test';
import assert from 'node:assert/strict';
import { GTAO, PostStack, SSAO } from '../dist/index.js';
import { harness, modules, written } from './support.js';

const kernel = (log) => modules(log).find((code) => code.includes('fn arc('));

for (const samples of [4, 1])
  test(`GTAO runs SSAO's G-buffer, blur and ambient replay with its own horizon kernel (${samples}x)`, () => {
    const h = harness({ samples }),
      gtao = new GTAO({ radius: 1.5, slices: 3, steps: 5 }),
      ssao = harness({ samples });
    const log = h.gpu.record(() => {
        h.engine.use(new PostStack([gtao]));
        h.frame();
      }),
      reference = ssao.gpu.record(() => {
        ssao.engine.use(new PostStack([new SSAO()]));
        ssao.frame();
      });
    const code = kernel(log);
    assert.ok(code, 'GTAO kernel compiled');
    assert.match(code, /0\.25\*\(cos\(g\)-cos\(2\.0\*h-g\)\+2\.0\*h\*sin\(g\)\)/, 'the closed-form slice visibility');
    // Every other shader is SSAO's own (extract, blur, ambient replay, composite).
    const others = modules(log).filter((c) => c !== code),
      expected = modules(reference).filter((c) => !c.includes('kernel[i]'));
    assert.deepEqual(others, expected);
    // Frame uniform: radius, steps, slices, enabled, then the viewport.
    const v = written(log, 224);
    assert.deepEqual([...v.subarray(48, 56)], [1.5, 5, 3, 1, 1280, 720, 0, 0]);
    // The 4x4 tile: each slice rotation and each step offset once.
    const tile = written(log, 512),
      rotations = [],
      offsets = [];
    for (let i = 0; i < 16; i++) {
      rotations.push(tile[i * 4] * 16 - 0.5);
      offsets.push(tile[i * 4 + 1] * 16 - 0.5);
    }
    assert.deepEqual(
      rotations.slice().sort((a, b) => a - b),
      [...Array(16).keys()],
    );
    assert.deepEqual(
      offsets.slice().sort((a, b) => a - b),
      [...Array(16).keys()],
    );
    assert.equal(h.draws.filter((d) => d.pipeline).length, 1, 'one ambient replay per frame');
    gtao.options.slices = 1;
    gtao.enabled = false;
    const next = written(
      h.gpu.record(() => h.frame()),
      224,
    );
    assert.deepEqual([next[50], next[51]], [1, 0], 'options and enabled are read per frame');
    h.engine.removePlugin('post:stack');
    assert.deepEqual(h.live(), [], 'disposal releases every GPU resource');
  });

test('GTAO runs only in a PostStack; GTAO.attach gives it one of its own', () => {
  const h = harness();
  assert.throws(() => h.engine.use(new GTAO()), {
    name: 'MargoError',
    code: 'state',
    message: /GTAO.attach\(engine\)/,
  });
  const gtao = GTAO.attach(h.engine, { radius: 2 });
  assert.ok(h.engine.hasPlugin('post:stack') && h.engine.hasPlugin('gtao'));
  assert.ok(gtao instanceof GTAO && gtao.name === 'gtao');
  h.frame();
  gtao.dispose();
  assert.ok(!h.engine.hasPlugin('post:stack') && !h.engine.hasPlugin('gtao'), 'disposal removes its stack');
  assert.deepEqual(h.live(), []);
});

test('GTAO rejects invalid options and ignores the SSAO tier preset', () => {
  for (const options of [{ radius: 0 }, { radius: 101 }, { slices: 0 }, { slices: 5 }, { steps: 2.5 }, { steps: 17 }])
    assert.throws(() => new GTAO(options), RangeError);
  assert.throws(() => new GTAO({ enabled: 1 }), RangeError);
  globalThis.margoPreset = { ssao: { enabled: false, samples: 4 } };
  try {
    assert.deepEqual(new GTAO().options, {});
    assert.equal(new SSAO().options.samples, 4, 'SSAO still reads its own');
  } finally {
    delete globalThis.margoPreset;
  }
});

test("GTAO's slice visibility integrates to 1 over the open hemisphere for any normal", () => {
  // The shader's own closed form (eq. 10 of Jimenez et al. 2016), evaluated here over the slices the kernel takes.
  const h = harness();
  const code = kernel(h.gpu.record(() => h.engine.use(new PostStack([new GTAO()])))),
    body = code.match(/fn arc\(h:f32,g:f32\)->f32 \{return ([^;]+);\}/)[1],
    arc = new Function('h', 'g', `const {cos,sin}=Math;return ${body};`);
  for (const tilt of [0, 0.3, 0.9, 1.4]) {
    const n = [Math.sin(tilt), 0, Math.cos(tilt)];
    let sum = 0;
    const slices = 720;
    for (let k = 0; k < slices; k++) {
      const phi = ((k + 0.5) * Math.PI) / slices,
        side = [Math.cos(phi), Math.sin(phi), 0],
        axis = [-side[1], side[0], 0],
        along = n[0] * axis[0] + n[1] * axis[1],
        p = [n[0] - axis[0] * along, n[1] - axis[1] * along, n[2]],
        weight = Math.hypot(...p),
        g = Math.sign(p[0] * side[0] + p[1] * side[1] || 1) * Math.acos(Math.min(1, p[2] / weight));
      sum += weight * (arc(g - Math.PI / 2, g) + arc(g + Math.PI / 2, g));
    }
    assert.ok(Math.abs(sum / slices - 1) < 1e-4, `tilt ${tilt}: ${sum / slices}`);
  }
});
