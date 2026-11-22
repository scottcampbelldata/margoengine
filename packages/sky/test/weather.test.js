// Weather: rain, snow and lightning, imported by the package specifier like an app does.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Weather,
  lightningFlash,
  thunderDelay,
  speedOfSound,
  LIGHTNING_PEAK_CANDELA,
  LIGHTNING_LIGHT_HEIGHT,
  LIGHTNING_COLOR,
  weatherLens,
  snowflakeBokeh,
  snowflakeDiameter,
  snowflakeSizeLaw,
  SNOWFLAKE_MASS_COEFFICIENT,
  SNOWFLAKE_FALL_COEFFICIENT,
  SNOWFLAKE_FALL_EXPONENT,
  snowflakeFallSpeed,
  LIGHTNING_CLOUD_BASE,
  lightningCloudShare,
  rainDropDiameter,
  rainFallSpeed,
  rainFall,
  rainSlant,
  rainIntensity,
  rainDropCount,
  RAIN_FALL_DEFAULT,
} from '@margoengine/sky/weather';
import { snowNight } from '@margoengine/sky/scene-kits';
import { MargoError } from '@margoengine/math/errors';
import { chromaticityToLinearSRGB } from '@margoengine/math/color';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

/** Runs a Weather on the mock GPU, recording every render pass: [{ descriptor, draws: [[vertices, instances]] }]. */
function rig(options) {
  const h = optionalGPU(),
    passes = [];
  h.context.encoder.beginRenderPass = (descriptor) => {
    const record = { descriptor, draws: [] };
    passes.push(record);
    return {
      setPipeline() {},
      setBindGroup() {},
      setViewport() {},
      setScissorRect() {},
      draw: (vertices, instances = 1) => record.draws.push([vertices, instances]),
      end() {},
    };
  };
  const weather = new Weather(options);
  h.engine.use(weather);
  return { h, weather, passes };
}
const uniform = (h) => new Float32Array(h.resources.find((r) => !r.destroyed && r.size === 192).data);

test('amount eases to the intensity over fadeSeconds and holds', () => {
  const w = new Weather({ intensity: 1, fadeSeconds: 4 });
  w.onPreUpdate(1);
  assert.equal(w.amount, 0.25);
  w.onPreUpdate(2);
  assert.equal(w.amount, 0.75);
  w.onPreUpdate(10);
  assert.equal(w.amount, 1);
  w.options.intensity = 0.2;
  w.onPreUpdate(4);
  assert.ok(Math.abs(w.amount - 0.2) < 1e-12, 'It falls back without overshooting');
  w.options.fadeSeconds = 0;
  w.options.intensity = 0.9;
  w.onPreUpdate(0.001);
  assert.equal(w.amount, 0.9, 'Zero fade jumps');
  w.options.precipitation = 'none';
  w.onPreUpdate(0.001);
  assert.equal(w.amount, 0, 'No precipitation is no amount whatever the intensity');
});

test('rain wets surfaces and dries again; snow settles and melts more slowly', () => {
  const w = new Weather({ precipitation: 'rain', intensity: 1, fadeSeconds: 0 });
  for (let i = 0; i < 100; i++) w.onPreUpdate(1);
  assert.ok(w.wetness > 0.98, `wet ${w.wetness}`);
  assert.equal(w.snowCover, 0);
  w.options.precipitation = 'none';
  for (let i = 0; i < 90; i++) w.onPreUpdate(1);
  assert.ok(w.wetness < 0.4 && w.wetness > 0.3, `drying ${w.wetness}`);
  w.options.precipitation = 'snow';
  for (let i = 0; i < 600; i++) w.onPreUpdate(1);
  assert.ok(w.snowCover > 0.99);
  assert.ok(w.wetness < 0.01, 'Snow does not wet');
  w.options.precipitation = 'none';
  for (let i = 0; i < 300; i++) w.onPreUpdate(1);
  assert.ok(w.snowCover > 0.3 && w.snowCover < 0.4, `melting ${w.snowCover}`);
});

test('the flash envelope rises in 8 ms, decays with 70 ms and is the brightest stroke', () => {
  assert.equal(lightningFlash(-0.01, [0], [1]), 0);
  assert.equal(lightningFlash(0, [0], [1]), 0);
  assert.equal(lightningFlash(0.008, [0], [1]), 1);
  assert.ok(Math.abs(lightningFlash(0.078, [0], [1]) - Math.exp(-1)) < 1e-12);
  assert.equal(
    lightningFlash(0.5, [0, 0.1], [1, 0.5]),
    Math.max(Math.exp(-0.492 / 0.07), 0.5 * Math.exp(-0.392 / 0.07)),
  );
  assert.ok(lightningFlash(0.108, [0, 0.1], [1, 0.9]) > 0.9 * 0.99, 'A return stroke relights the flash');
});

test('thunder arrives after distance over the speed of sound', () => {
  assert.equal(thunderDelay(343), 1);
  assert.equal(thunderDelay(3430), 10);
  assert.equal(thunderDelay(0), 0);
  assert.equal(thunderDelay(100, 100), 1);
  assert.equal(speedOfSound, 343);
  for (const bad of [[-1], [NaN], [Infinity], [10, 0], [10, -5], [10, NaN]])
    assert.throws(() => thunderDelay(...bad), RangeError, String(bad));
});

test('a manual strike flashes, reports once and thunders after its delay', () => {
  const w = new Weather({ intensity: 0, lightning: {} });
  const lightning = [],
    thunder = [];
  w.onLightning((s) => lightning.push(s));
  w.onThunder((s) => thunder.push([s, w.elapsed]));
  w.listener.set([10, 2, -5]);
  const s = w.strike({ distance: 686, azimuth: Math.PI / 2, strength: 0.8 });
  assert.equal(lightning.length, 1);
  assert.equal(lightning[0], s);
  assert.equal(s.id, 1);
  assert.equal(s.thunderDelay, 2);
  assert.ok(Math.abs(s.position[0] - (10 + 686)) < 1e-3 && Math.abs(s.position[2] + 5) < 1e-3);
  assert.equal(s.position[1], 0);
  assert.ok(s.strokes >= 1 && s.strokes <= 4);
  assert.ok(s.loudness > 0 && s.loudness < 1 && s.rumble >= 1);
  let peak = 0;
  for (let i = 0; i < 250; i++) {
    w.onPreUpdate(0.004);
    peak = Math.max(peak, w.flash);
  }
  assert.ok(peak > 0.7 && peak <= 0.8 + 1e-9, `peak ${peak}`);
  assert.ok(w.flash < 0.001, 'The flash has died away');
  assert.equal(thunder.length, 0, 'One second in, the thunder has not arrived');
  for (let i = 0; i < 300; i++) w.onPreUpdate(0.01);
  assert.equal(thunder.length, 1, 'Thunder is heard once');
  assert.ok(thunder[0][1] >= 2 && thunder[0][1] < 2.05, `heard at ${thunder[0][1]}`);
  assert.equal(thunder[0][0], s);
  assert.equal(lightning.length, 1);
});

test('listeners can be removed, a throwing one does not hide the others, and re-entry is refused', () => {
  const w = new Weather({ lightning: {} });
  const seen = [];
  const off = w.onLightning((s) => seen.push(['a', s.id]));
  w.onLightning(() => {
    throw new Error('listener failed');
  });
  w.onLightning((s) => seen.push(['c', s.id]));
  assert.throws(() => w.strike({ distance: 100 }), /listener failed/);
  assert.deepEqual(seen, [
    ['a', 1],
    ['c', 1],
  ]);
  off();
  assert.throws(() => w.strike({ distance: 100 }), /listener failed/);
  assert.deepEqual(seen.at(-1), ['c', 2]);
  assert.equal(seen.filter(([k]) => k === 'a').length, 1);
  const again = new Weather({});
  again.onLightning(() => again.strike());
  assert.throws(
    () => again.strike(),
    (e) => e instanceof MargoError && e.code === 'state' && /next frame/.test(e.message),
  );
  assert.throws(() => again.onLightning(1), TypeError);
  assert.throws(() => again.onThunder('x'), TypeError);
});

test('storms are deterministic by seed, need intensity above the threshold and scale with the rate', () => {
  const run = (options, seconds, intensity = 1) => {
    const w = new Weather({ intensity, fadeSeconds: 0, lightning: options });
    const strikes = [];
    w.onLightning((s) => strikes.push({ time: s.time, distance: s.distance, azimuth: s.azimuth, strokes: s.strokes }));
    for (let i = 0; i < seconds * 30; i++) w.onPreUpdate(1 / 30);
    return strikes;
  };
  const a = run({ seed: 7, rate: 12 }, 600),
    b = run({ seed: 7, rate: 12 }, 600),
    c = run({ seed: 8, rate: 12 }, 600);
  assert.deepEqual(a, b, 'Same seed, same storm');
  assert.notDeepEqual(a, c);
  // 12 strikes a minute for 10 minutes: 120 expected; a Poisson count stays within five sigma (about 55).
  assert.ok(a.length > 120 - 55 && a.length < 120 + 55, `count ${a.length}`);
  for (const s of a) assert.ok(s.distance >= 300 && s.distance <= 6000);
  assert.equal(run({ seed: 1 }, 300, 0.6).length, 0, 'At the threshold there is no rate');
  assert.equal(run({ seed: 1, rate: 0 }, 300).length, 0);
  assert.ok(run({ seed: 1, threshold: 0.2, rate: 30 }, 120, 0.6).length > 0);
  const half = run({ seed: 3, rate: 24 }, 600, 0.8).length, // (0.8 - 0.6) / 0.4 = half the rate: 120 expected
    full = run({ seed: 3, rate: 24 }, 600, 1).length; // 240 expected
  assert.ok(full > half * 1.4, `${half} vs ${full}`);
  const far = run({ seed: 5, rate: 30, minDistance: 1000, maxDistance: 1000 }, 60);
  assert.ok(far.length > 0 && far.every((s) => s.distance === 1000));
});

test('a long step makes at most one strike and a zero step none', () => {
  const w = new Weather({ intensity: 1, fadeSeconds: 0, lightning: { rate: 600, seed: 2 } });
  let n = 0;
  w.onLightning(() => n++);
  w.onPreUpdate(0);
  assert.equal(n, 0);
  w.onPreUpdate(3600);
  assert.ok(n <= 1);
});

test('invalid options name the problem and the fix', () => {
  const rejects = (options, type, text) =>
    assert.throws(
      () => new Weather(options),
      (e) => e instanceof type && text.test(e.message),
      JSON.stringify(options),
    );
  rejects({ precipitation: 'hail' }, TypeError, /"rain", "snow", "sleet" or "none"/);
  rejects({ intensity: 2 }, RangeError, /intensity must be a number from 0 to 1/);
  rejects({ intensity: NaN }, RangeError, /finite/);
  rejects({ intensity: '1' }, RangeError, /intensity/);
  rejects({ fadeSeconds: -1 }, RangeError, /fadeSeconds/);
  rejects({ radius: 1 }, RangeError, /radius/);
  rejects({ height: 500 }, RangeError, /height/);
  rejects({ particles: -1 }, RangeError, /particles/);
  rejects({ particles: 1e7 }, RangeError, /particles/);
  rejects({ opacity: 2 }, RangeError, /opacity/);
  rejects({ brightness: -1 }, RangeError, /brightness/);
  rejects({ reactive: 1 }, TypeError, /reactive must be true or false/);
  rejects({ wind: [1] }, TypeError, /\[x, z\]/);
  rejects({ wind: [1, 200] }, RangeError, /wind\[1\]/);
  rejects({ color: [-1, 0, 0] }, RangeError, /non-negative/);
  rejects({ lightning: 3 }, TypeError, /options object/);
  rejects({ lightning: { rate: -1 } }, RangeError, /lightning.rate/);
  rejects({ lightning: { threshold: 2 } }, RangeError, /threshold/);
  rejects({ lightning: { minDistance: 500, maxDistance: 100 } }, RangeError, /swap them/);
  rejects({ lightning: { color: [0, -1, 0] } }, RangeError, /non-negative/);
  assert.throws(() => new Weather({ color: [1, 1] }));
  const w = new Weather();
  w.options.intensity = 5;
  assert.throws(() => w.onPreUpdate(0.1), RangeError, 'Options are checked again each frame');
  w.options.intensity = 0.5;
  assert.throws(() => w.onPreUpdate(-1), RangeError);
  assert.throws(() => w.onPreUpdate(NaN), RangeError);
  assert.throws(() => w.strike({ distance: -1 }), RangeError);
  assert.throws(() => w.strike({ strength: 2 }), RangeError);
  assert.throws(() => w.strike({ azimuth: NaN }), RangeError);
});

test('it needs WebGPU, draws only while it rains and draws the share of particles the amount gives', () => {
  assert.throws(
    () => new Weather().setup({ gpu: undefined }),
    (e) => e instanceof MargoError && e.code === 'unsupported' && /WebGPU/.test(e.message),
  );
  const { h, weather, passes } = rig({ intensity: 1, fadeSeconds: 0, particles: 1000 });
  h.frame();
  const first = passes.at(-1);
  assert.deepEqual(first.draws, [[6, 1000]]);
  assert.equal(first.descriptor.depthStencilAttachment.depthReadOnly, true, 'Depth is tested, never written');
  const pipeline = h.pipelines.find((p) => p.fragment.targets[0].blend.color.srcFactor === 'src-alpha');
  assert.equal(pipeline.depthStencil.depthCompare, 'greater-equal');
  assert.equal(pipeline.depthStencil.depthWriteEnabled, false);
  assert.equal(pipeline.multisample.count, 4);
  weather.options.intensity = 0.25;
  h.frame();
  assert.deepEqual(passes.at(-1).draws, [[6, 250]]);
  weather.options.precipitation = 'none';
  const before = passes.length;
  h.frame();
  assert.equal(passes.length, before, 'Nothing is drawn without precipitation');
  weather.options.precipitation = 'snow';
  weather.options.particles = undefined;
  weather.options.intensity = 1;
  h.frame();
  // 500,000 since flakes are drawn at their real size, each keeping only its own light (KB-SNOW-NEARCAM2).
  assert.deepEqual(passes.at(-1).draws, [[6, 500000]], 'Snow defaults to 500,000 flakes');
  weather.options.precipitation = 'rain';
  h.frame();
  assert.deepEqual(passes.at(-1).draws, [[6, 24000]], 'Rain defaults to 24,000 streaks');
  weather.dispose();
});

test('the uniform carries the camera, the box, the wrapped drift, the colour and the viewport', () => {
  const { h, weather } = rig({
    intensity: 1,
    fadeSeconds: 0,
    radius: 10,
    height: 8,
    wind: [3, -2],
    color: [0.5, 0.25, 1],
    brightness: 2,
    opacity: 0.4,
  });
  h.context.delta = 1000.3;
  h.frame();
  const u = uniform(h);
  assert.deepEqual([...u.subarray(0, 16)], [...h.context.camera.matrix]);
  assert.deepEqual([...u.subarray(16, 19)], [0, 1, 4]);
  assert.deepEqual([...u.subarray(20, 23)], [20, 8, 20]);
  const wrap = (v, size) => ((v % size) + size) % size;
  assert.ok(Math.abs(u[24] - wrap(3 * 1000.3, 20)) < 1e-3, 'Wind drifts the box contents, wrapped in double precision');
  assert.ok(Math.abs(u[25] - wrap(-9 * 1000.3, 8)) < 1e-3);
  assert.ok(Math.abs(u[26] - wrap(-2 * 1000.3, 20)) < 1e-3);
  assert.deepEqual([...u.subarray(28, 32)], [1, 0.5, 2, Math.fround(0.4)]);
  assert.equal(u[32], 128);
  assert.equal(u[33], 96);
  assert.ok(Math.abs(u[34] - 96 / (2 * Math.tan(Math.PI / 6))) < 1e-3, 'Focal length in pixels from the 60 degree fov');
  assert.equal(u[36], 0, 'Rain');
  assert.deepEqual([u[40], u[41], u[42]], [3, 9, -2]);
  weather.options.precipitation = 'snow';
  h.frame();
  assert.equal(uniform(h)[36], 1);
  assert.equal(
    uniform(h)[41],
    Math.fround(0.8),
    'Flakes fall at 0.8 D^0.16 m/s, each at its own size (KB-SNOW-FALLSPEED1)',
  );
});

/** The snow shader the rig compiles, from its shader modules. */
function snowShader(options) {
  const r = rig(options),
    codes = [],
    device = r.h.context.device,
    create = device.createShaderModule;
  device.createShaderModule = (descriptor) => (codes.push(descriptor.code), create.call(device, descriptor));
  r.h.frame();
  r.weather.dispose();
  const code = codes.find((c) => c.includes('let snow=w.params.x>0.5;'));
  assert.ok(code, 'The weather shader compiled');
  return code;
}
// Exact JS twin of the WGSL PCG hash (Jarzynski and Olano, JCGT 9(3), 2020) in the weather shader.
const pcg = (v) => {
  const s = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const w = Math.imul((s >>> ((s >>> 28) + 4)) ^ s, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
};

test('snow sways on a phase of its own, so the flakes stay evenly spread instead of folding into sheets', () => {
  // Regression (lane SC17, Whiteout Pass whiteout-window end frame): the sway phase was the flake's own x * 3.1 (and
  // z * 2.7), so x -> x + 0.35 sin(t + 3.1 x) folded the snow into sheets of x = constant (slope 1 + 1.085 cos, which
  // passes zero) that showed as a column of flakes whenever one passed the camera. The phase is now drawn per flake.
  const code = snowShader({ precipitation: 'snow', intensity: 1, fadeSeconds: 0, wind: [5, 17] });
  assert.ok(
    code.includes(' let ph=pcg(pcg(ii*4u+3u+bitcast<u32>(w.params.z)));\n'),
    'One hash per flake for its phases',
  );
  assert.ok(
    code.includes(' let phase=vec2f(f32(ph&0xffffu),f32(ph>>16u))*9.5873799e-5;\n'),
    'Two 16-bit phases, 0 to 2 pi',
  );
  assert.ok(code.includes('if(snow){q+=vec3f(sin(w.drift.w+phase.x),0.0,cos(w.drift.w*0.8+phase.y))*0.35;}'));
  assert.ok(code.includes('let sway=vec3f(cos(w.drift.w+phase.x)*1.3,0.0,-sin(w.drift.w*0.8+phase.y)*1.04)*0.35;'));
  assert.doesNotMatch(code, /start\.[xz]\*/, 'No phase follows the place along the swing');
  // The twin over the shader's 60,000 flakes of a 32 m box: the fullest of 128 slices of x against the even share, at
  // five sway times. Per-flake phases stay at the count's own noise (about 1.15 here); the old place-bound phases
  // measured 3.9 times the even share.
  const seed = 1,
    size = 32,
    count = 60000,
    slices = 128,
    rnd = (i, k) => (pcg((i * 4 + k + seed) >>> 0) >>> 8) * 5.9604645e-8,
    fullest = (phaseOf) => {
      let worst = 0;
      for (const t of [0, 0.7, 1.9, 3.3, 5.1]) {
        const bins = new Float64Array(slices);
        for (let i = 0; i < count; i++) {
          const x = rnd(i, 0) * size,
            moved = (((x + 0.35 * Math.sin(t + phaseOf(i, x))) % size) + size) % size;
          bins[Math.floor((moved / size) * slices)]++;
        }
        worst = Math.max(worst, Math.max(...bins) / (count / slices));
      }
      return worst;
    };
  const even = fullest((i) => (pcg(pcg((i * 4 + 3 + seed) >>> 0)) & 0xffff) * 9.5873799e-5),
    folded = fullest((_, x) => x * 3.1);
  assert.ok(even < 1.25, `Per-flake phases keep the snow even (fullest slice ${even.toFixed(3)} of the even share)`);
  assert.ok(folded > 2.5, `The twin sees the old fold (fullest slice ${folded.toFixed(3)})`);
});

test('a swept flake shades the time average of the moving disc, so sub-frame capsules add up to an even streak', () => {
  // Regression (lane SC17, Whiteout Pass): each sub-frame's capsule was shaded at full strength out to its round ends
  // (scaled by 1.596 / (1.596 + 1.4 sweep)), so where two consecutive capsules met the light doubled and the streaks of
  // a shot summing sub-frames showed as rows of beads. The fragment now integrates the disc along its sweep.
  const code = snowShader({ precipitation: 'snow', intensity: 1, fadeSeconds: 0, wind: [18, 0], exposure: 1 / 960 });
  const body = [
    'fn disc(r:f32)->f32 {return 1.0-smoothstep(0.4,1.0,r);}',
    'const gauss=array<vec2f,4>(vec2f(0.18343464,0.36268378),vec2f(0.52553241,0.31370665),vec2f(0.79666648,0.22238103),vec2f(0.96028986,0.10122854));',
    'fn flake(uv:vec2f,sweep:f32)->f32 {',
    ' if(sweep<1e-4){return disc(length(uv));}',
    ' let hw=sqrt(max(0.0,1.0-uv.x*uv.x));',
    ' let s0=max(0.0,uv.y-hw);',
    ' let s1=min(sweep,uv.y+hw);',
    ' if(s1<=s0){return 0.0;}',
    ' let m=(s0+s1)*0.5;',
    ' let h=(s1-s0)*0.5;',
    ' var g=0.0;',
    ' for(var k=0;k<4;k++){let n=gauss[k];g+=n.y*(disc(length(vec2f(uv.x,uv.y-m-h*n.x)))+disc(length(vec2f(uv.x,uv.y-m+h*n.x))));}',
    ' return g*h/sweep;',
    '}',
  ].join('\n');
  assert.ok(code.includes(body), 'The fragment integrates the disc along the sweep');
  assert.ok(code.includes('if(w.params.x>0.5){a*=flake(i.uv,i.sweep);}'));
  assert.ok(
    code.includes(' out.alpha=fade*sharp*sharp/(px*px);'),
    'No light share for the sweep: the average keeps it',
  );
  assert.doesNotMatch(code, /1\.596/);
  // The twin of flake(): consecutive capsules (8 sub-frames) of one flake add up to within 1.5 % of even along the
  // middle of the streak, and each keeps the still disc's light, 1.596 radii squared.
  const smooth = (a, b, x) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    },
    disc = (r) => 1 - smooth(0.4, 1, r),
    gauss = [
      [0.18343464, 0.36268378],
      [0.52553241, 0.31370665],
      [0.79666648, 0.22238103],
      [0.96028986, 0.10122854],
    ],
    flake = (x, y, sweep) => {
      if (sweep < 1e-4) return disc(Math.hypot(x, y));
      const hw = Math.sqrt(Math.max(0, 1 - x * x)),
        s0 = Math.max(0, y - hw),
        s1 = Math.min(sweep, y + hw);
      if (s1 <= s0) return 0;
      const m = (s0 + s1) / 2,
        h = (s1 - s0) / 2;
      let g = 0;
      for (const [u, w] of gauss) g += w * (disc(Math.hypot(x, y - m - h * u)) + disc(Math.hypot(x, y - m + h * u)));
      return (g * h) / sweep;
    };
  for (const sweep of [0.5, 2, 6]) {
    for (const x of [0, 0.5]) {
      let low = Infinity,
        high = 0;
      for (let y = 1.5; y < 8 * sweep - 1.5; y += 0.01) {
        let sum = 0;
        for (let k = 0; k < 8; k++) sum += flake(x, y - k * sweep, sweep);
        low = Math.min(low, sum);
        high = Math.max(high, sum);
      }
      assert.ok(high / low < 1.015, `Sweep ${sweep}, x ${x}: an even streak (${low.toFixed(4)} to ${high.toFixed(4)})`);
    }
    let area = 0;
    for (let x = -1; x <= 1; x += 0.01)
      for (let y = -1.5; y < sweep + 1.5; y += 0.01) area += flake(x, y, sweep) * 1e-4;
    assert.ok(Math.abs(area - 1.596) < 0.01, `Sweep ${sweep}: the disc's light (${area.toFixed(4)})`);
  }
});

test('a wind that changes moves the particles on from where they are (gusts do not jump the snow)', () => {
  // Regression (lane SC3, Whiteout Pass): the drift was wind * time, so a gust after 37 s of snow moved every flake by
  // the change of wind times 37 s in one frame; it is now the running sum of wind times delta.
  const { h, weather } = rig({
    precipitation: 'snow',
    intensity: 1,
    fadeSeconds: 0,
    radius: 50,
    height: 8,
    wind: [3, 0],
  });
  h.context.delta = 37;
  h.frame();
  const before = uniform(h)[24];
  assert.ok(Math.abs(before - 11) < 1e-3, 'Steady wind: 3 m/s for 37 s is 111 m, 11 m into the 100 m box');
  weather.options.wind = [4, -1];
  h.context.delta = 0.02;
  h.frame();
  const u = uniform(h);
  assert.ok(Math.abs(u[24] - (before + 4 * 0.02)) < 1e-3, `X moves on by 8 cm, not to 4 * 37.02 m (got ${u[24]})`);
  assert.ok(Math.abs(u[26] - (100 - 0.02)) < 1e-3, `Z moves back by 2 cm from 0 (got ${u[26]})`);
  weather.dispose();
});

test('exposure: snow takes the shutter time in its uniform, rain keeps its own streak, and the range is checked', () => {
  // Regression (lane SC5, Whiteout Pass): snow had no exposure, so flakes in a gale summed over a shot's sub-frames
  // showed as rows of dots. The flake is now swept over options.exposure seconds (screen.w of the uniform).
  const { h, weather } = rig({ precipitation: 'snow', intensity: 1, fadeSeconds: 0, wind: [18, 0] });
  h.frame();
  assert.equal(uniform(h)[35], 0, 'No exposure by default: a still disc');
  weather.options.exposure = 1 / 60;
  h.frame();
  assert.ok(Math.abs(uniform(h)[35] - 1 / 60) < 1e-7, `Snow sweeps over the exposure (got ${uniform(h)[35]})`);
  weather.options.precipitation = 'rain';
  h.frame();
  assert.equal(uniform(h)[35], 0, 'Rain keeps its fixed streak');
  weather.dispose();
  for (const exposure of [-0.01, 1.5, Number.NaN])
    assert.throws(() => new Weather({ exposure }), RangeError, `exposure ${exposure}`);
});

test('the listener follows the camera and a flash adds its colour to the frame', () => {
  const { h, weather, passes } = rig({ intensity: 0, lightning: { strength: 0.5, color: [1, 0.5, 0] } });
  h.context.camera.position = [7, 1, 9];
  h.context.delta = 0.0001;
  h.frame();
  assert.deepEqual([...weather.listener], [7, 1, 9]);
  assert.equal(passes.length, 0, 'No flash, no rain: no passes');
  weather.strike({ distance: 500, strength: 1 });
  h.context.delta = 0.008;
  h.frame();
  assert.equal(passes.length, 1);
  assert.deepEqual(passes[0].draws, [[3, 1]]);
  assert.equal(passes[0].descriptor.colorAttachments[0].loadOp, 'load');
  const flash = new Float32Array(h.resources.find((r) => !r.destroyed && r.size === 16).data);
  assert.ok(
    Math.abs(flash[0] - 0.5) < 1e-6 && Math.abs(flash[1] - 0.25) < 1e-6 && flash[2] === 0,
    JSON.stringify([...flash]),
  );
  const pipeline = h.pipelines.find((p) => p.fragment.targets[0].blend.color.dstFactor === 'one');
  assert.ok(pipeline, 'Additive blend');
  assert.equal(pipeline.depthStencil, undefined);
  h.context.delta = 3;
  h.frame();
  assert.equal(passes.length, 1, 'The flash is over');
  const quiet = new Weather({ intensity: 0, lightning: { strength: 0 } });
  quiet.strike({ distance: 100 });
  quiet.onPreUpdate(0.008);
  assert.ok(quiet.flash > 0, 'The state still reports it, for lights that follow it');
});

test('precipitation is brightened by the flash through the uniform', () => {
  const { h, weather } = rig({ intensity: 1, fadeSeconds: 0, lightning: {} });
  weather.strike({ distance: 800 });
  h.context.delta = 0.008;
  h.frame();
  assert.ok(uniform(h)[39] > 0 && uniform(h)[39] <= 1);
});

test('dispose frees the GPU, is idempotent and blocks later use', () => {
  const { h, weather } = rig({ intensity: 1 });
  h.frame();
  const buffers = h.resources.filter((r) => r.size === 192 || r.size === 16);
  assert.ok(buffers.length >= 1);
  weather.dispose();
  weather.dispose();
  assert.ok(buffers.every((b) => b.destroyed));
  assert.throws(
    () => weather.onPreUpdate(0.1),
    (e) => e instanceof MargoError && e.code === 'disposed' && /new Weather/.test(e.message),
  );
  assert.throws(
    () => weather.strike(),
    (e) => e.code === 'disposed',
  );
  weather[Symbol.dispose]();
});

test('device restoration rebuilds the buffers and pipelines', () => {
  const { h, weather, passes } = rig({ intensity: 1, fadeSeconds: 0, particles: 10 });
  h.frame();
  const old = h.resources.filter((r) => r.size === 192);
  weather.onDeviceRestored(h.engine);
  assert.ok(old.every((b) => b.destroyed));
  h.frame();
  assert.deepEqual(passes.at(-1).draws, [[6, 10]]);
  assert.ok(h.resources.some((r) => r.size === 192 && !r.destroyed));
});

test('a strike lights the scene: a point light of a measured first stroke, at the strike, through the flash', () => {
  // Guo and Krider (JGR 87, 1982): 2.3e9 W at peak in 0.4 to 1.1 um. Orville (1968): a 30,000 K channel. Its Planck
  // spectrum weighted by Wyman, Sloan and Shirley's (JCGT 2013) photopic fit, over that band, recomputed here.
  const g = (x, m, a, b) => Math.exp(-0.5 * ((x - m) * (x < m ? a : b)) ** 2),
    Y = (l) => 0.821 * g(l, 568.8, 0.0213, 0.0247) + 0.286 * g(l, 530.9, 0.0613, 0.0322),
    X = (l) =>
      1.056 * g(l, 599.8, 0.0264, 0.0323) + 0.362 * g(l, 442.0, 0.0624, 0.0374) - 0.065 * g(l, 501.1, 0.049, 0.0382),
    Z = (l) => 1.217 * g(l, 437.0, 0.0845, 0.0278) + 0.681 * g(l, 459.0, 0.0385, 0.0725),
    planck = (l) => 1 / ((l * 1e-9) ** 5 * (Math.exp(1.4387769e-2 / (l * 1e-9 * 30000)) - 1));
  let x = 0,
    y = 0,
    z = 0,
    band = 0;
  // The colour over the whole visible range (360 nm up), the efficacy over the measured band.
  for (let l = 360; l <= 1100; l += 0.5) {
    const b = planck(l);
    x += X(l) * b;
    y += Y(l) * b;
    z += Z(l) * b;
    if (l >= 400) band += b;
  }
  const efficacy = (683 * y) / band;
  assert.ok(Math.abs(efficacy - 161.7) < 0.2, `efficacy ${efficacy}`);
  // Quick and Krider (JGR Atmos. 122, 2017): 150 J/m over 4.2 MW/m, a 36 us width; the energy over the flash
  // envelope's area at unit peak: an 8 ms linear rise (0.004 s) and a 70 ms exponential fall (0.07 s).
  let area = 0;
  for (let t = 0; t < 2; t += 1e-5) area += lightningFlash(t + 5e-6, [0], [1]) * 1e-5;
  assert.ok(Math.abs(area - 0.074) < 1e-4, `envelope ${area}`);
  const candela = (2.3e9 * (150 / 4.2e6) * efficacy) / (area * 4 * Math.PI);
  assert.ok(Math.abs(LIGHTNING_PEAK_CANDELA / candela - 1) < 3e-3, `${LIGHTNING_PEAK_CANDELA} against ${candela}`);
  assert.ok(Math.abs(LIGHTNING_PEAK_CANDELA - 1.43e7) < 0.01e7);
  assert.ok(Math.abs(x / (x + y + z) - 0.2502) < 5e-4 && Math.abs(y / (x + y + z) - 0.2488) < 5e-4);
  assert.equal(Math.max(...LIGHTNING_COLOR), 1);
  const rgb = chromaticityToLinearSRGB(0.2502, 0.2488);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(LIGHTNING_COLOR[i] - rgb[i] / Math.max(...rgb)) < 1e-4);
  assert.ok(LIGHTNING_COLOR[2] === 1 && LIGHTNING_COLOR[0] < 1, 'a hot channel is blue-white');
  assert.equal(LIGHTNING_LIGHT_HEIGHT, 700);

  const luminance = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2],
    w = new Weather({ intensity: 0, lightning: {} }),
    light = w.lightningLight;
  w.onPreUpdate(0.01);
  assert.equal(light.intensity, 0, 'no light between flashes');
  assert.equal(light.decay, 2);
  w.listener.set([10, 2, -5]);
  const s = w.strike({ distance: 2000, azimuth: 0, strength: 0.2 });
  let peak = 0;
  for (let i = 0; i < 100; i++) {
    w.onPreUpdate(0.002);
    peak = Math.max(peak, light.intensity * luminance(light.color));
    assert.equal(light, w.lightningLight, 'the same object, changed in place');
  }
  // The strokes' own level drives it, not the overlay's strength: distance dims it by the inverse square.
  assert.ok(peak > 0.95 * LIGHTNING_PEAK_CANDELA && peak <= LIGHTNING_PEAK_CANDELA * (1 + 1e-9), `peak ${peak}`);
  assert.deepEqual(light.position, [s.position[0], 700, s.position[2]]);
  assert.equal(light.range, 9000);
  for (let i = 0; i < 200; i++) w.onPreUpdate(0.01);
  assert.ok(light.intensity < 1e-6 * LIGHTNING_PEAK_CANDELA, 'it dies with the flash');

  // Every part is an option: a held flash for stills, a dimmer stroke, its height, colour and reach.
  w.options.lightning = { hold: 0.5, light: { peak: 1e9, height: 420, color: [2, 2, 4], range: 5000 } };
  w.onPreUpdate(0.01);
  assert.equal(w.flash, 0.5);
  assert.deepEqual(light.color, [0.5, 0.5, 1]);
  assert.ok(Math.abs(light.intensity * luminance(light.color) - 0.5e9) < 1);
  assert.equal(light.position[1], 420);
  assert.equal(light.range, 5000);
  for (const bad of [
    { hold: 2 },
    { light: { peak: -1 } },
    { light: { color: [0, 0, 0] } },
    { light: { height: -1 } },
  ]) {
    w.options.lightning = bad;
    assert.throws(() => w.onPreUpdate(0.01), RangeError);
  }
  w.options.lightning = { light: 3 };
  assert.throws(() => w.onPreUpdate(0.01), TypeError);
});

test('flakes off the focal plane draw as the lens blurs them, their light spread over the blur disc (KB-SNOW-NEARCAM1)', () => {
  // Regression: every flake drew as a sharp disc of its own size, so a flake passing a metre from the camera showed
  // as a large hard speck on the lens. A real lens focused on the scene blurs it to its circle of confusion, the thin
  // lens's A f |d - S| / (d (S - f)) on the sensor (Potmesil and Chakravarty 1981), and spreads its light over it.
  const width = 1280,
    height = 720,
    fov = 40,
    pixels = height / (2 * Math.tan((fov * Math.PI) / 360)),
    // Cabin Hearth's outside view: the snowNight kit's lens, focused 14.9 m out on the lit window.
    kit = snowNight({ focalDistance: 14.9 }),
    lens = weatherLens(kit.precipitation.lens, width, height, fov),
    // Full frame (36 mm across the 1280 px side): the focal length the field of view gives, the aperture at f/1.4.
    f = (0.036 / width) * pixels,
    aperture = f / 1.4;
  assert.ok(Math.abs(lens.focalLength - f) < 1e-12 && lens.focus === 14.9);
  const coc = (d) => (aperture * f * Math.abs(d - 14.9)) / (d * (14.9 - f)) / (0.036 / width) / 2;
  // The kit's flakes: radius 0.012 m times 0.6 to 1.4, faded in from 0.4 to 2 m.
  for (const d of [0.5, 1, 1.5, 2, 3, 5]) {
    for (const size of [0.0072, 0.012, 0.0168]) {
      const sharp = (size * pixels) / d,
        drawn = snowflakeBokeh(sharp, d, lens);
      assert.ok(Math.abs(drawn.radius - Math.hypot(sharp, coc(d))) < 1e-9, `${d} m: the blur disc`);
      // The flake's light, opacity times disc area, is kept: its peak falls as its disc grows.
      assert.ok(Math.abs(drawn.alpha * drawn.radius ** 2 - sharp ** 2) < 1e-6, `${d} m: light kept`);
      // Inside the near distance every flake is at least the lens's blur disc wide, and the kit's mean flake keeps
      // under two thirds of its peak there: soft, not a speck.
      if (d <= 2) assert.ok(drawn.radius >= coc(d) && coc(d) > 4, `${d} m: blurred by ${coc(d).toFixed(2)} px`);
      if (d <= 2 && size === 0.012) assert.ok(drawn.alpha < 0.67, `${d} m: peak ${drawn.alpha.toFixed(3)}`);
    }
  }
  // In focus the flake is sharp; `lens: false` keeps every flake sharp.
  const inFocus = snowflakeBokeh(5, 14.9, lens);
  assert.ok(Math.abs(inFocus.radius - 5) < 1e-9 && Math.abs(inFocus.alpha - 1) < 1e-9);
  assert.deepEqual(snowflakeBokeh(20, 0.6, weatherLens(false, width, height, fov)), { radius: 20, alpha: 1 });
  // Defaults follow @margoengine/dof: f/2.8 on a 36 mm sensor, focused 10 m out.
  const d = weatherLens(undefined, width, height, fov);
  assert.ok(Math.abs(d.scale - 0.5 * (f / 2.8) * pixels) < 1e-12 && d.focus === 10);

  // The shader draws the same disc: the uniform carries the lens and the near fade, and the vertex stage adds the
  // circle of confusion in quadrature and divides the light by the disc's area.
  const code = snowShader({
    precipitation: 'snow',
    intensity: 1,
    fadeSeconds: 0,
    lens: { focalDistance: 14.9, aperture: 1.4 },
  });
  assert.ok(code.includes('let coc=w.lens.x*abs(c.w-w.lens.y)/(c.w*w.eye.w);'));
  assert.ok(code.includes('let px=max(sqrt(sharp*sharp+coc*coc),1.0);'));
  assert.ok(code.includes(' out.alpha=fade*sharp*sharp/(px*px);'), 'Light over the disc: true area over drawn area');
  assert.ok(code.includes('smoothstep(w.lens.z,w.lens.w,nearDistance)'));
  const { h, weather } = rig({
    precipitation: 'snow',
    intensity: 1,
    fadeSeconds: 0,
    lens: { focalDistance: 14.9, aperture: 1.4 },
    nearFade: [0.6, 3],
  });
  h.frame();
  const u = uniform(h),
    camera = h.engine.camera,
    expected = weatherLens({ focalDistance: 14.9, aperture: 1.4 }, u[32], u[33], camera.fov);
  assert.ok(Math.abs(u[44] - expected.scale) < 1e-4 * expected.scale, 'lens scale');
  assert.equal(u[45], Math.fround(14.9));
  assert.ok(Math.abs(u[19] - (14.9 - expected.focalLength)) < 1e-5, 'focus less the focal length');
  assert.deepEqual([u[46], u[47]], [Math.fround(Math.max(0.6, camera.near)), 3]);
  weather.options.lens = false;
  h.frame();
  assert.equal(uniform(h)[44], 0, 'lens false: sharp flakes');
  weather.options.nearFade = undefined;
  h.frame();
  assert.deepEqual([uniform(h)[46], uniform(h)[47]], [Math.fround(Math.max(0.4, camera.near)), 2]);
  weather.dispose();
  for (const bad of [
    { lens: 1 },
    { lens: { aperture: 0.1 } },
    { lens: { focalDistance: 0.1 } },
    { lens: { filmGauge: 0 } },
    { nearFade: [2, 1] },
    { nearFade: [1] },
  ])
    assert.throws(() => new Weather(bad), /lens|nearFade/);
});

// KB-SNOW-NEARCAM2: flakes were drawn 12 mm in radius (24 mm across) so distant snow stayed visible, five times a real
// flake, and a flake under a pixel kept alpha sharp (its size in pixels) on a pixel-wide disc, more light than it has.
// A flake a metre from the lens still showed as a 30 px soft disc. The twins below follow the shader's sums.
const KIT = { width: 1280, height: 720, fov: 40 };
const focalPixels = KIT.height / (2 * Math.tan((KIT.fov * Math.PI) / 360));
// The size law from the papers alone: melted diameter m (mm) exponential with slope 25.5 R^-0.48 per cm (Gunn and
// Marshall 1958), largest dimension D from pi m^3 / 6 = 0.073 D^1.4 mg (Locatelli and Hobbs 1974), D in mm.
const melted = (D) => Math.cbrt((6 * 0.073 * D ** 1.4) / Math.PI);
const largest = (m) => ((Math.PI * m ** 3) / (6 * 0.073)) ** (1 / 1.4);
function sizeMoments(rate, [small, big]) {
  const lambda = 2.55 * rate ** -0.48,
    a = melted(small),
    b = melted(big),
    n = 200000,
    h = (b - a) / n;
  let w0 = 0,
    w1 = 0,
    w2 = 0;
  for (let i = 0; i < n; i++) {
    const m = a + (i + 0.5) * h,
      w = Math.exp(-lambda * m),
      D = largest(m);
    w0 += w;
    w1 += w * D;
    w2 += w * D * D;
  }
  const mean = w1 / w0;
  return { mean, spread: Math.sqrt(w2 / w0 - mean * mean) };
}

test('flakes take the measured sizes of aggregate snowflakes, Gunn and Marshall 1958 with Locatelli and Hobbs 1974 (KB-SNOW-NEARCAM2)', () => {
  assert.equal(SNOWFLAKE_MASS_COEFFICIENT, 0.073);
  for (const [rate, sizes] of [
    [1, [2, 10]],
    [0.3, [2, 10]],
    [4, [1, 15]],
  ]) {
    const want = sizeMoments(rate, sizes),
      n = 100000;
    let s1 = 0,
      s2 = 0;
    for (let i = 0; i < n; i++) {
      const D = snowflakeDiameter((i + 0.5) / n, rate, sizes) * 1000;
      assert.ok(D >= sizes[0] - 1e-9 && D <= sizes[1] + 1e-9, `${D} mm inside ${sizes}`);
      s1 += D;
      s2 += D * D;
    }
    const mean = s1 / n,
      spread = Math.sqrt(s2 / n - mean * mean);
    assert.ok(
      Math.abs(mean - want.mean) < 2e-3 * want.mean,
      `${rate} mm/h: mean ${mean.toFixed(4)} mm, the papers' ${want.mean.toFixed(4)}`,
    );
    assert.ok(
      Math.abs(spread - want.spread) < 5e-3 * want.spread,
      `${rate} mm/h: spread ${spread.toFixed(4)} mm, the papers' ${want.spread.toFixed(4)}`,
    );
  }
  // At the default 1 mm/h over 2 to 10 mm: a mean flake 4.2 mm across with a spread of 2.0 mm, a fifth of the 24 mm
  // drawn before; harder snow has larger flakes, as Gunn and Marshall measured.
  const d = sizeMoments(1, [2, 10]);
  assert.ok(Math.abs(d.mean - 4.215) < 0.01 && Math.abs(d.spread - 1.985) < 0.01, `${d.mean} ${d.spread}`);
  assert.ok(sizeMoments(3, [2, 10]).mean > d.mean && sizeMoments(0.3, [2, 10]).mean < d.mean);
  // The shader draws the same law from the uniform: slope (params.y), smallest melted diameter (volume.w) and share
  // (extra.w); rain keeps its streak seconds and width there.
  const code = snowShader({ precipitation: 'snow', intensity: 1, fadeSeconds: 0 });
  assert.ok(code.includes(' let melted=w.volume.w-log(1.0-rnd(ii,3u)*w.extra.w)/w.params.y;'));
  assert.ok(code.includes(' let sizeMeters=0.0005*pow(7.172586*melted*melted*melted,0.71428571);'));
  assert.ok(Math.abs(7.172586 - Math.PI / (6 * 0.073)) < 1e-6);
  const { h, weather } = rig({
    precipitation: 'snow',
    intensity: 1,
    fadeSeconds: 0,
    snowfallRate: 2,
    flakeSizes: [3, 12],
  });
  h.frame();
  const law = snowflakeSizeLaw(2, [3, 12]),
    u = uniform(h);
  assert.deepEqual([u[37], u[23], u[43]], [Math.fround(law.lambda), Math.fround(law.low), Math.fround(law.span)]);
  weather.options.precipitation = 'rain';
  h.frame();
  assert.deepEqual([uniform(h)[37], uniform(h)[23]], [Math.fround(0.035), 0], 'Rain: its streak seconds');
  weather.dispose();
  for (const bad of [
    { snowfallRate: 0 },
    { snowfallRate: 31 },
    { flakeSizes: [10, 2] },
    { flakeSizes: [0.1, 2] },
    { flakeSizes: [2] },
  ])
    assert.throws(() => new Weather(bad), /snowfallRate|flakeSizes/);
});

test('a flake under a pixel is drawn a pixel wide with alpha its true area over the pixel, so it keeps its light (KB-SNOW-NEARCAM2)', () => {
  const sharp = weatherLens(false, KIT.width, KIT.height, KIT.fov),
    lens = weatherLens(snowNight({ focalDistance: 14.9 }).precipitation.lens, KIT.width, KIT.height, KIT.fov);
  for (const pixels of [0.02, 0.1, 0.35, 0.7, 0.99, 1, 2.5]) {
    for (const [l, depth] of [
      [sharp, 20],
      [lens, 14.9],
      [lens, 30],
    ]) {
      const drawn = snowflakeBokeh(pixels, depth, l);
      assert.ok(drawn.radius >= 1, 'At least a pixel wide');
      // Light is opacity times disc area: the drawn flake's equals the true flake's.
      assert.ok(
        Math.abs(drawn.alpha * drawn.radius ** 2 - pixels ** 2) < 1e-9,
        `${pixels} px at ${depth} m: light kept`,
      );
    }
  }
  assert.deepEqual(snowflakeBokeh(0.25, 20, sharp), { radius: 1, alpha: 0.0625 });
});

test('a flake streaks over the shutter: the streak is its speed times the exposure, projected (KB-SNOW-NEARCAM2)', () => {
  const kit = snowNight();
  assert.equal(kit.precipitation.exposure, 1 / 48, 'A night exterior: 180 degree shutter at 24 fps');
  // The vertex stage: tail at q - velocity * exposure, head at q, both projected; the sweep is the pixels between.
  const code = snowShader({ precipitation: 'snow', intensity: 1, fadeSeconds: 0, exposure: 1 / 48, wind: [0.6, -0.3] });
  assert.ok(code.includes('var t=w.camera*vec4f(q-velocity*w.screen.w,1);'));
  assert.ok(code.includes('let pa=c.xy/c.w*vp*0.5;') && code.includes('let pb=t.xy/t.w*vp*0.5;'));
  assert.ok(code.includes('let sweep=length(d);'));
  // Twin on the kit's view: a camera at the origin looking down -z; a flake d metres out moving across the view.
  const f = 1 / Math.tan((KIT.fov * Math.PI) / 360),
    aspect = KIT.width / KIT.height,
    project = ([x, y, z]) => [(((f / aspect) * x) / -z) * KIT.width * 0.5, ((f * y) / -z) * KIT.height * 0.5];
  for (const d of [0.5, 1, 2, 8])
    for (const v of [
      [0, -1.2, 0],
      [0.6, -1.2, 0],
      [3, 0.5, 0],
    ]) {
      const T = kit.precipitation.exposure,
        q = [0.2, -0.1, -d],
        a = project(q),
        b = project([q[0] - v[0] * T, q[1] - v[1] * T, q[2] - v[2] * T]),
        sweep = Math.hypot(a[0] - b[0], a[1] - b[1]),
        want = (Math.hypot(v[0], v[1]) * T * focalPixels) / d;
      assert.ok(Math.abs(sweep - want) < 1e-9 * want, `${d} m: ${sweep} px, speed x shutter x f / d = ${want}`);
    }
  const { h, weather } = rig({ ...kit.precipitation });
  h.frame();
  assert.ok(Math.abs(uniform(h)[35] - 1 / 48) < 1e-7, 'The kit opens the shutter for 1/48 s');
  weather.dispose();
});

// KB-SNOW-FALLSPEED1: every flake fell at 1.2 m/s whatever its size (extra.y), though the flakes have real sizes since
// KB-SNOW-NEARCAM2. Locatelli and Hobbs (1974, Table 1) measured the aggregates of unrimed dendrites whose mass law
// draws those sizes falling at V = 0.8 D^0.16 m/s (D their largest dimension in mm, 2 to 10 mm). Each flake now falls
// at that speed for its own size, in steps of 1/512 m/s, with its fall phase an exact 24-bit count (drift.y) multiplied in u32.
const FALL_STEP = 512;
const fallLaw = (D) => 0.8 * (D * 1000) ** 0.16;
const fallSteps = (D) => Math.round(Math.fround(0.8 * Math.fround(Math.fround(D / 2) * 2000) ** 0.16) * FALL_STEP);

test('each flake falls at the measured speed of its own size, Locatelli and Hobbs 1974 (KB-SNOW-FALLSPEED1)', () => {
  assert.deepEqual([SNOWFLAKE_FALL_COEFFICIENT, SNOWFLAKE_FALL_EXPONENT], [0.8, 0.16]);
  for (const D of [0.002, 0.0042, 0.006, 0.01])
    assert.ok(Math.abs(snowflakeFallSpeed(D) - fallLaw(D)) < 1e-12, `${D * 1000} mm falls at ${fallLaw(D)} m/s`);
  assert.ok(Math.abs(snowflakeFallSpeed(0.002) - 0.894) < 1e-3 && Math.abs(snowflakeFallSpeed(0.01) - 1.156) < 1e-3);
  // The shader: each flake's speed from its own sampled size, the size the disc is drawn at.
  const code = snowShader({ precipitation: 'snow', intensity: 1, fadeSeconds: 0 });
  assert.ok(
    code.includes(' let k=u32(round(w.extra.y*pow(sizeMeters*2000.0,0.16)*512.0));'),
    'Speed from the flake size',
  );
  assert.ok(code.includes(' let fall=select(w.extra.y,f32(k)*0.001953125,flakes);'));
  assert.ok(
    code.includes(' let fallen=select(w.drift.y,-f32((k*u32(w.drift.y))&0xffffffu)*5.9604645e-8*size.y,flakes);'),
  );
  assert.ok(code.includes(' let rel=fract((start+vec3f(w.drift.x,fallen,w.drift.z)-w.eye.xyz)/size)-0.5;'));
  // Twin over the flakes the shader draws (hash seed 1): every flake's speed is the law at its size, to half a step.
  const rnd = (i, k) => (pcg((i * 4 + k + 1) >>> 0) >>> 8) * 5.9604645e-8;
  let slowest = Infinity,
    fastest = 0;
  for (let i = 0; i < 20000; i++) {
    const D = snowflakeDiameter(rnd(i, 3)),
      v = fallSteps(D) / FALL_STEP;
    assert.ok(
      Math.abs(v - fallLaw(D)) <= 0.5 / FALL_STEP + 1e-6,
      `flake ${i}: ${v} m/s against ${fallLaw(D)} at ${D * 1000} mm`,
    );
    slowest = Math.min(slowest, v);
    fastest = Math.max(fastest, v);
  }
  assert.ok(slowest < 0.9 && fastest > 1.1, `The flakes fall at ${slowest} to ${fastest} m/s, not all at one speed`);
  // The uniform: the law's coefficient (extra.y) and the fall phase, seconds / (512 height) as a 24-bit fraction, so
  // flake k has fallen k * phase heights (mod 1) exactly, its speed times the time.
  const { h, weather } = rig({ precipitation: 'snow', intensity: 1, fadeSeconds: 0, height: 16 });
  h.context.delta = 1000.3;
  h.frame();
  const u = uniform(h),
    bits = u[25],
    phase = 1000.3 / (FALL_STEP * 16);
  assert.equal(u[41], Math.fround(0.8), 'extra.y carries the law coefficient');
  assert.ok(Number.isInteger(bits) && Math.abs(bits - Math.floor((phase % 1) * 2 ** 24)) <= 1, `Fall phase ${bits}`);
  for (const k of [458, 512, 592]) {
    const fallen = (Math.imul(k, bits) & 0xffffff) * 5.9604645e-8 * 16,
      want = ((((k / FALL_STEP) * 1000.3) % 16) + 16) % 16;
    assert.ok(
      Math.abs(fallen - want) < 2e-3,
      `${k / FALL_STEP} m/s for 1000.3 s: ${fallen} m of the box, want ${want}`,
    );
  }
  weather.options.precipitation = 'rain';
  h.frame();
  assert.equal(uniform(h)[41], 9, 'Rain keeps its 9 m/s');
  assert.ok(
    Math.abs(uniform(h)[25] - ((((-9 * 2000.6) % 16) + 16) % 16)) < 1e-3,
    'Rain keeps its float drift, 9 m/s times the time',
  );
  weather.dispose();
});

test('the mean fall speed at the kit default is within the measured 0.89 to 1.16 m/s (KB-SNOW-FALLSPEED1)', () => {
  const p = snowNight().precipitation,
    n = 100000;
  let sum = 0;
  for (let i = 0; i < n; i++)
    sum += snowflakeFallSpeed(snowflakeDiameter((i + 0.5) / n, p.snowfallRate ?? 1, p.flakeSizes ?? [2, 10]));
  const mean = sum / n;
  // Locatelli and Hobbs's aggregates of dendrites, 2 to 10 mm: 0.89 to 1.16 m/s; about 1 m/s at the mean 4.2 mm flake.
  assert.ok(mean > 0.89 && mean < 1.16, `Mean ${mean.toFixed(3)} m/s`);
  assert.ok(Math.abs(mean - 1.0) < 0.03, `Mean ${mean.toFixed(3)} m/s, about 1 m/s`);
  assert.ok(Math.abs(mean - 1.2) > 0.15, 'Slower than the 1.2 m/s every flake fell at before');
});

test('the shutter streak is each flake speed times the exposure, projected (KB-SNOW-FALLSPEED1)', () => {
  const code = snowShader({ precipitation: 'snow', intensity: 1, fadeSeconds: 0, exposure: 1 / 48 });
  assert.ok(code.includes('let velocity=vec3f(w.extra.x,-fall,w.extra.z)+sway;'), 'The streak takes the flake speed');
  assert.ok(code.includes('var t=w.camera*vec4f(q-velocity*w.screen.w,1);'));
  // Twin: a small and a large flake, 2 m out, still air, no sway: the streaks are their speeds times 1/48 s, projected.
  const T = 1 / 48,
    d = 2,
    streak = (D) => ((fallSteps(D) / FALL_STEP) * T * focalPixels) / d,
    small = streak(0.002),
    large = streak(0.01);
  assert.ok(Math.abs(small - (fallLaw(0.002) * T * focalPixels) / d) < 0.01, `2 mm: ${small} px`);
  assert.ok(
    Math.abs(large / small - (10 / 2) ** 0.16) < 3e-3,
    `10 mm streaks ${(large / small).toFixed(3)} times a 2 mm one`,
  );
});

test('no flake near the lens reads as a disc bigger than a real flake, and distant snow keeps its density (KB-SNOW-NEARCAM2)', () => {
  // A near flake reads as a disc where it is at least half as opaque as a sharp flake (its full width at half
  // maximum). Bound: the largest measured flake (10 mm, Locatelli and Hobbs's upper limit) seen sharp at the end of
  // the near fade, the nearest distance at which a flake is drawn at full strength: 0.005 * f / 2 = 2.47 px.
  const smooth = (a, b, x) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    },
    kit = snowNight(),
    [nearIn, nearFull] = [0.4, 2],
    bound = (0.005 * focalPixels) / nearFull;
  assert.equal(kit.precipitation.nearFade, undefined, 'The kit keeps the default near fade, 0.4 to 2 m');
  const reads = (fade, sharp, coc) => {
    const r = Math.max(Math.hypot(sharp, coc), 1);
    return fade * (sharp / r) ** 2 >= 0.5 ? r : 0;
  };
  for (const focus of [10, 14.9]) {
    const lens = weatherLens(snowNight({ focalDistance: focus }).precipitation.lens, KIT.width, KIT.height, KIT.fov);
    let worstNew = 0,
      worstOld = 0;
    for (let d = nearIn; d <= nearFull + 1e-9; d += 0.01) {
      const fade = smooth(nearIn, nearFull, d),
        coc = (lens.scale * Math.abs(d - lens.focus)) / (d * (lens.focus - lens.focalLength));
      // Still flakes, the worst case: a flake moving along the view axis does not streak.
      for (let u = 0.0005; u < 1; u += 0.001)
        worstNew = Math.max(worstNew, reads(fade, (snowflakeDiameter(u) / 2) * (focalPixels / d), coc));
      // The flakes as drawn before: 12 mm times 0.6 to 1.4 in radius.
      for (let k = 0.6; k <= 1.4; k += 0.01)
        worstOld = Math.max(worstOld, reads(fade, (0.012 * k * focalPixels) / d, coc));
    }
    assert.ok(
      worstNew <= bound,
      `focus ${focus} m: the largest near disc is ${worstNew.toFixed(2)} px, at most ${bound.toFixed(2)}`,
    );
    assert.ok(worstOld > 4 * bound, `focus ${focus} m: the 24 mm flakes read as ${worstOld.toFixed(1)} px discs`);
  }

  // Distant snow: the light the flakes beyond the near fade add to the frame, at the kit's defaults, against the 24 mm
  // flakes at their old count (24,000). Light of a flake: fade times its sharp area in pixels squared (the lens and the
  // streak spread it without changing it); before, a flake under a pixel kept alpha sharp on a pixel-wide disc.
  // Tolerance: the kit's snowfall band (FMH-1 moderate, 5/16 to 5/8 statute mile) spans a factor 2 of visibility, so
  // of extinction (Koschmieder); within a factor sqrt 2 either way the snow stays in the band it is named for.
  const rnd = (i, k) => (pcg((i * 4 + k + 1) >>> 0) >>> 8) * 5.9604645e-8,
    halfY = Math.tan((KIT.fov * Math.PI) / 360),
    halfX = halfY * (KIT.width / KIT.height),
    { radius, height, particles } = kit.precipitation,
    light = (count, flakeLight) => {
      let sum = 0;
      for (let i = 0; i < count; i++) {
        const x = (rnd(i, 0) - 0.5) * 2 * radius,
          y = (rnd(i, 1) - 0.5) * height,
          z = (rnd(i, 2) - 0.5) * 2 * radius,
          depth = -z;
        if (depth < 0.1 || Math.hypot(x, y, z) < nearFull || Math.abs(x) > halfX * depth || Math.abs(y) > halfY * depth)
          continue;
        sum += flakeLight(i, depth);
      }
      return sum;
    },
    before = light(24000, (i, depth) => {
      const sharp = (0.012 * (0.6 + 0.8 * rnd(i, 3)) * focalPixels) / depth;
      return sharp < 1 ? sharp : sharp * sharp;
    }),
    after = light(particles, (i, depth) => ((snowflakeDiameter(rnd(i, 3)) / 2) * (focalPixels / depth)) ** 2),
    ratio = after / before;
  assert.equal(particles, 750000);
  assert.ok(ratio > Math.SQRT1_2 && ratio < Math.SQRT2, `Distant snow keeps its light: ${ratio.toFixed(3)} of before`);
});

// Regression (KB-STORM-OPTIONS1): storm-light lit its cloud deck from inside with a hand-set 1.6e6 at 950 m over the
// strike. The weather now gives that light: the channel's share above the cloud base (Jordan and Uman 1983).
test('cloudFlash: the stroke light given off above the cloud base, one decay length above it, for the clouds', () => {
  const luminance = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2],
    w = new Weather({ intensity: 0, lightning: { hold: 1 } }),
    cloud = w.cloudFlash;
  assert.equal(LIGHTNING_CLOUD_BASE, 1500);
  assert.ok(Math.abs(lightningCloudShare(1500) - Math.exp(-1500 / 700)) < 1e-15);
  assert.ok(Math.abs(lightningCloudShare(650) - 0.3951) < 1e-4);
  assert.throws(() => lightningCloudShare(-1), RangeError);
  const s = w.strike({ distance: 2000, azimuth: 1, strength: 1 });
  w.onPreUpdate(0.01);
  assert.equal(cloud, w.cloudFlash, 'the same object, changed in place');
  assert.deepEqual(cloud.position, [s.position[0], 2200, s.position[2]]);
  assert.deepEqual(cloud.color, w.lightningLight.color);
  assert.equal(cloud.radius, 200);
  assert.ok(Math.abs(cloud.intensity * luminance(cloud.color) - LIGHTNING_PEAK_CANDELA * Math.exp(-1500 / 700)) < 1e-3);
  // A storm deck's base, a set peak and core.
  w.options.lightning = { hold: 0.5, cloud: { base: 650 } };
  w.onPreUpdate(0.01);
  assert.equal(cloud.position[1], 1350);
  assert.ok(
    Math.abs(cloud.intensity * luminance(cloud.color) - 0.5 * LIGHTNING_PEAK_CANDELA * 0.39505) <
      0.5e-4 * LIGHTNING_PEAK_CANDELA,
  );
  w.options.lightning = { hold: 1, cloud: { peak: 2e6, radius: 300 } };
  w.onPreUpdate(0.01);
  assert.ok(Math.abs(cloud.intensity * luminance(cloud.color) - 2e6) < 1e-3);
  assert.equal(cloud.radius, 300);
  w.options.lightning = { hold: 0 };
  w.onPreUpdate(0.01);
  assert.equal(cloud.intensity, 0, 'none between flashes');
  for (const bad of [{ cloud: { base: -1 } }, { cloud: { peak: -1 } }, { cloud: { radius: 0 } }]) {
    w.options.lightning = bad;
    assert.throws(() => w.onPreUpdate(0.01), RangeError);
  }
  w.options.lightning = { cloud: 3 };
  assert.throws(() => w.onPreUpdate(0.01), TypeError);
});

test('rain falls at the speed of its drops: Gunn and Kinzer 1949 by drop size, Marshall and Palmer 1948 size by rate', () => {
  // Gunn and Kinzer's measured terminal speeds: 2 mm 6.49 m/s, 3 mm 8.06, 4 mm 8.83, 5 mm 9.09 (within 0.15 m/s of the fit).
  for (const [D, V] of [
    [2, 6.49],
    [3, 8.06],
    [4, 8.83],
    [5, 9.09],
  ])
    assert.ok(Math.abs(rainFallSpeed(D) - V) < 0.15, `${D} mm falls ${rainFallSpeed(D)} m/s, measured ${V}`);
  // The size from the rate: D0 = 0.895 R^0.21 mm: 0.34 mm at 0.01 mm/h, 1.6 at 17, 2.4 at 80.
  assert.ok(Math.abs(rainDropDiameter(17) - 1.62) < 0.02 && Math.abs(rainDropDiameter(80) - 2.24) < 0.02);
  assert.ok(Math.abs(rainDropDiameter(1) - 0.895) < 1e-3);
  // A drizzle falls at 1 to 2 m/s, a downpour at 7.
  assert.ok(rainFall(0.01) > 1 && rainFall(0.01) < 2.5, `drizzle ${rainFall(0.01)}`);
  assert.ok(rainFall(80) > 6.5 && rainFall(80) < 7.5, `downpour ${rainFall(80)}`);
  assert.ok(rainFall(1) < rainFall(17) && rainFall(17) < rainFall(80), 'harder rain falls faster');
  assert.equal(rainFall(undefined), RAIN_FALL_DEFAULT);
  // Drops per cubic metre: N0 / L, 1,950 at 1 mm/h; it grows with the rate.
  assert.ok(Math.abs(rainDropCount(1) - 1951.2) < 0.1 && rainDropCount(80) > rainDropCount(17));
  for (const bad of [-1, NaN, Infinity]) assert.throws(() => rainDropDiameter(bad), RangeError);
  assert.throws(() => rainFallSpeed(0), RangeError);
  assert.equal(rainIntensity(0), 0);
  assert.equal(rainIntensity(80), 1);
});

test('the rain streak slants by atan(wind / fall) within 2 degrees, the fall speed from the rate', () => {
  for (const [R, wind] of [
    [0.5, [3, 0]],
    [17, [5, -4]],
    [69, [12, 3]],
  ]) {
    const { h, weather } = rig({ precipitation: 'rain', intensity: 1, fadeSeconds: 0, rainRate: R, wind });
    h.frame();
    const u = uniform(h),
      drawn = (Math.atan2(Math.hypot(u[40], u[42]), u[41]) * 180) / Math.PI,
      want = (Math.atan2(Math.hypot(...wind), rainFallSpeed((3.67 / 4.1) * R ** 0.21)) * 180) / Math.PI;
    assert.ok(Math.abs(u[41] - rainFall(R)) < 1e-5, `R ${R}: fall ${u[41]}`);
    assert.ok(Math.abs(drawn - want) < 2, `R ${R}: slant ${drawn} against ${want}`);
    assert.ok(Math.abs(rainSlant(wind, rainFall(R)) - want) < 1e-9);
    weather.dispose();
  }
  assert.throws(() => new Weather({ rainRate: -1 }), RangeError);
});

// Lightning that lights, with no wiring (lightning.link): the cloud deck from inside, the fog under it and the ground and
// scene through the lights, found by plugin name in the scene.
function stormScene(
  options,
  { slots = 4, groups = true, fog = true, deck = { weather: { cloud: 1, rain: 1, lightning: 1 } } } = {},
) {
  const r = rig({ intensity: 0.9, lightning: { seed: 3, ...options } }),
    scene = { deck: { name: 'sky:volumetric-clouds', options: deck, setup() {} } };
  r.h.engine.use(scene.deck);
  if (fog) r.h.engine.use((scene.fog = { name: 'volumetric-fog', options: {}, setup() {} }));
  if (groups) {
    const sets = (scene.sets = []),
      made = new Map();
    scene.groups = {
      name: 'clustered-groups',
      setup() {},
      isDisposed: false,
      clustered: { isDisposed: false, shadowSlots: slots },
      get list() {
        return [...made.values()].flatMap((g) => g.lights);
      },
      group(name) {
        if (!made.has(name))
          made.set(name, {
            lights: [],
            isDisposed: false,
            setLights(lights) {
              this.lights = [...lights];
              sets.push([name, lights.map((l) => ({ ...l, shadow: l.shadow && { ...l.shadow } }))]);
            },
            dispose() {
              this.isDisposed = true;
              made.delete(name);
            },
          });
        return made.get(name);
      },
    };
    r.h.engine.use(scene.groups);
  }
  return { ...r, scene };
}
const flashFor = (weather, strength = 1) => {
  weather.strike({ distance: 1000, azimuth: 0, strength });
  weather.onPreUpdate(0.008);
};

test('a storm lights its own cloud deck, fog and light list with no wiring', () => {
  const { weather, scene } = stormScene({});
  weather.onPreUpdate(0.01);
  assert.equal(scene.deck.options.flash, weather.cloudFlash, 'the deck takes the flash from inside');
  assert.equal(scene.fog.options.lightning.light, weather.lightningLight, 'the fog takes the light');
  assert.equal(scene.sets.length, 0, 'nothing is listed between flashes');
  flashFor(weather);
  assert.ok(weather.lightningLight.intensity > 0);
  const [name, lights] = scene.sets.at(-1);
  assert.equal(name, 'lightning');
  assert.equal(lights.length, 1);
  assert.equal(lights[0].intensity, weather.lightningLight.intensity);
  // The light is dropped once the flash is gone: one empty list, then no more calls.
  weather.options.lightning.rate = 0;
  weather.options.lightning.threshold = 1;
  for (let i = 0; i < 100; i++) weather.onPreUpdate(0.05);
  assert.equal(weather.lightningLight.intensity, 0);
  assert.equal(scene.sets.at(-1)[1].length, 0);
  const before = scene.sets.length;
  for (let i = 0; i < 10; i++) weather.onPreUpdate(0.05);
  assert.equal(scene.sets.length, before, 'no list change while it is dark');
});

test('a flash the scene gave its own flash, lightning or group is left as the scene had it, and link switches each part off', () => {
  const mine = { position: [0, 0, 0], intensity: 1 },
    own = stormScene({}, { deck: { flash: mine } });
  own.weather.onPreUpdate(0.01);
  assert.equal(own.scene.deck.options.flash, mine);
  const off = stormScene({ link: false });
  flashFor(off.weather);
  assert.equal('flash' in off.scene.deck.options, false);
  assert.equal('lightning' in off.scene.fog.options, false);
  assert.equal(off.scene.sets.length, 0);
  const some = stormScene({ link: { clouds: false, fog: true, lights: false } });
  flashFor(some.weather);
  assert.equal('flash' in some.scene.deck.options, false);
  assert.ok(some.scene.fog.options.lightning);
  assert.equal(some.scene.sets.length, 0);
  // Switched off later, the deck and fog get the flash back.
  const late = stormScene({});
  flashFor(late.weather);
  late.weather.options.lightning.link = { clouds: false, fog: false, lights: false };
  late.weather.onPreUpdate(0.01);
  assert.equal('flash' in late.scene.deck.options, false);
  assert.equal('lightning' in late.scene.fog.options, false);
  assert.equal(late.scene.groups.list.length, 0, 'the light group is taken out');
  assert.throws(() => new Weather({ lightning: { link: 1 } }), TypeError);
  assert.throws(() => new Weather({ lightning: { link: { fog: 'yes' } } }), TypeError);
  assert.throws(() => new Weather({ lightning: { link: { group: '' } } }), TypeError);
  assert.doesNotThrow(() => new Weather({ lightning: { link: { group: 'storm' } } }));
});

test('the light group has a name of its own, and dispose takes the flash out of the scene', () => {
  const { weather, scene } = stormScene({ link: { group: 'storm' } });
  flashFor(weather);
  assert.equal(scene.sets.at(-1)[0], 'storm');
  assert.equal(scene.groups.list.length, 1);
  weather.dispose();
  assert.equal('flash' in scene.deck.options, false);
  assert.equal('lightning' in scene.fog.options, false);
  assert.equal(scene.groups.list.length, 0, 'the group is gone with the weather');
});

test("the stroke's light asks for a shadow map where the lights have a free one", () => {
  const shadowOf = (options, scene) => {
    const r = stormScene(options, scene);
    flashFor(r.weather);
    return r.scene.sets.at(-1)[1][0].shadow;
  };
  assert.deepEqual(shadowOf({}, { slots: 4 }), { near: 1, far: 3000 }, 'a free slot');
  assert.equal(shadowOf({}, { slots: 0 }), undefined, 'no shadow maps in the lights');
  assert.equal(shadowOf({ light: { shadow: false } }, { slots: 4 }), undefined, 'switched off');
  assert.deepEqual(shadowOf({ light: { shadow: { near: 5, far: 800 } } }, { slots: 2 }), { near: 5, far: 800 });
  assert.equal(shadowOf({ light: { range: 500 } }, { slots: 4 }).far, 500, "the far stops at the light's range");
  // Every slot taken by other lights: none left for the lightning.
  const full = stormScene({}, { slots: 1 });
  full.scene.groups.group('lamps').setLights([{ position: [0, 5, 0], range: 20, shadow: true }]);
  flashFor(full.weather);
  assert.equal(full.scene.sets.at(-1)[1][0].shadow, undefined);
  assert.throws(() => new Weather({ lightning: { light: { shadow: { near: 10, far: 5 } } } }), RangeError);
  assert.throws(() => new Weather({ lightning: { light: { shadow: 'yes' } } }), TypeError);
});

test("the deck's flash sits in the linked deck: its base from the weather's cloud type, never above its tops", () => {
  const at = (deck, options = {}) => {
    const { weather } = stormScene(options, { deck });
    flashFor(weather);
    return weather.cloudFlash.position[1];
  };
  assert.equal(
    at({ weather: { cloud: 1, rain: 1, lightning: 1 } }),
    600 + LIGHTNING_LIGHT_HEIGHT,
    'a storm deck: base 600 m',
  );
  assert.equal(at({ weather: { cloud: 1 } }), 900, 'stratus 300 to 900 m: the flash stays under the tops');
  assert.equal(at({ bottom: 2000, top: 6000 }), 2000 + LIGHTNING_LIGHT_HEIGHT, "the deck's own bottom");
  assert.equal(at({}), LIGHTNING_CLOUD_BASE + LIGHTNING_LIGHT_HEIGHT, 'the default deck');
  assert.equal(
    at({ bottom: 2000 }, { cloud: { base: 500 } }),
    500 + LIGHTNING_LIGHT_HEIGHT,
    'lightning.cloud.base wins',
  );
});

test("the scales multiply the stroke's light and the deck's flash", () => {
  const read = (options) => {
    const { weather } = stormScene(options);
    flashFor(weather);
    return [weather.lightningLight.intensity, weather.cloudFlash.intensity];
  };
  const [light, deck] = read({});
  const [light3, deck3] = read({ light: { scale: 3 } });
  assert.ok(
    Math.abs(light3 / light - 3) < 1e-9 && Math.abs(deck3 / deck - 3) < 1e-9,
    'the light scale carries into the deck',
  );
  const [light4, deck4] = read({ cloud: { scale: 4 } });
  assert.equal(light4, light);
  assert.ok(Math.abs(deck4 / deck - 4) < 1e-9);
  assert.equal(read({ light: { scale: 0 } })[0], 0);
  assert.throws(() => new Weather({ lightning: { light: { scale: -1 } } }), RangeError);
  assert.throws(() => new Weather({ lightning: { cloud: { scale: 1001 } } }), RangeError);
});

test('at a kilometre the light lights the ground to the inverse square of its measured peak', () => {
  const { weather } = stormScene({ light: { shadow: false } });
  weather.strike({ distance: 1000, azimuth: 0, strength: 1 });
  weather.onPreUpdate(0.008); // the stroke's peak
  const light = weather.lightningLight,
    d = Math.hypot(1000, LIGHTNING_LIGHT_HEIGHT),
    luminance = 0.2126 * light.color[0] + 0.7152 * light.color[1] + 0.0722 * light.color[2],
    lux = ((light.intensity * luminance) / (d * d)) * (LIGHTNING_LIGHT_HEIGHT / d);
  // The ground 1 km from the strike, on the up face: E = I cos(theta) / d^2, with I the measured peak.
  const expected = (LIGHTNING_PEAK_CANDELA * (LIGHTNING_LIGHT_HEIGHT / d)) / (d * d);
  assert.ok(Math.abs(lux / expected - 1) < 1e-9, `${lux} lux against ${expected}`);
  assert.ok(lux > 1 && lux < 50, `a kilometre from a stroke the ground gets ${lux.toFixed(2)} lux`);
});
