// CPU checks (mock GPU) for HemisphereLight and AmbientLight: the core-shader patch beside IBL and light probes in either
// order, gltf-pro's sky hook in every gltf-pro-family shader, and the live uniform. Values on a real adapter:
// examples/package-benchmarks/light-features-gpu.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { lightPBR } from '../../shared/pbr-hooks.js';
import { pbrShader, extendedPBRShader, physicalShader, transmissiveShader } from '../../gltf-pro/src/shader.ts';
import { materialShader } from '../../materials/dist/index.js';
import { EnvironmentLighting, HemisphereLight, AmbientLight, HEMISPHERE_BINDING } from '../dist/index.js';
import { LightProbes } from '../dist/probes.js';

const coreShader = readFileSync(new URL('../../core/src/shaders.ts', import.meta.url), 'utf8').split('`')[1];
const fragment = (shader) => shader.slice(shader.lastIndexOf('@fragment fn fragment'));
const linearLine = (shader) => /let linear=[^;]+;/.exec(fragment(shader))[0];
const fakeEngine = (device) => ({
  backend: 'webgpu',
  gpu: device,
  onError() {},
  sceneOf() {
    return this;
  },
  removePlugin() {},
});
const fakeEnvironment = (device) => ({
  device,
  disposed: false,
  version: 0,
  specularView: {},
  sampler: {},
  brdfLut: {},
  shBuffer: {},
  paramsBuffer: {},
  restore: () => Promise.resolve(),
});
const room = { min: [-2, 0, -2], max: [2, 3, 2] };
const gradient = 'mix(vec3f(0.35,0.3,0.25),vec3f(1)';
const hexFloats = (hex) => {
  const b = Buffer.from(hex, 'hex');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
};

function effects() {
  const gpu = mockGPU(),
    engine = fakeEngine(gpu.device),
    sky = new HemisphereLight({ sky: [0.5, 0.6, 1], ground: [0.2, 0.1, 0], intensity: 2 }),
    ibl = new EnvironmentLighting(fakeEnvironment(gpu.device)),
    probes = new LightProbes({ volume: { ...room, counts: [2, 2, 2] } }),
    envProbes = new LightProbes({ environment: fakeEnvironment(gpu.device), volume: { ...room, counts: [2, 2, 2] } });
  for (const effect of [sky, ibl, probes, envProbes]) effect.setup(engine);
  return { gpu, engine, sky, ibl, probes, envProbes };
}

test('HemisphereLight replaces core and terrain ambient, and adds to IBL in either order', () => {
  const { sky, ibl } = effects(),
    alone = sky.shader(coreShader, 0);
  assert.match(alone, new RegExp(`@group\\(0\\) @binding\\(${HEMISPHERE_BINDING}\\) var<uniform> margoSkyLightData`));
  assert.equal(
    linearLine(alone),
    'let linear=direct*frame.radiance.xyz*frame.light.w+i.color*(1.0-i.material.y)*margoSkyLight(n);',
  );
  assert.doesNotMatch(fragment(alone), /frame\.radiance\.w/);
  // IBL then hemisphere, and hemisphere then IBL: both terms, once each.
  for (const code of [sky.shader(ibl.shader(coreShader, 0), 0), ibl.shader(sky.shader(coreShader, 0), 0)]) {
    const line = linearLine(code);
    assert.ok(line.includes('i.color*(1.0-i.material.y)*margoSkyLight(n)') && line.endsWith('+margoAmbient;'), line);
    assert.equal(fragment(code).split('let margoAmbient=iblShade(').length, 2);
  }
  const terrain =
    'let base=terrainColor(i.position,n);\n' +
    coreShader.replace('+i.color*(1.0-i.material.y)*frame.radiance.w*frame.ambient.rgb', '+base*frame.radiance.w');
  assert.ok(linearLine(sky.shader(terrain, 0)).endsWith('+base*margoSkyLight(n);'), 'terrain');
  const skyAmbient = coreShader.replace('frame.radiance.w*frame.ambient.rgb', 'skyAmbient.rgb');
  assert.ok(linearLine(sky.shader(skyAmbient, 0)).endsWith('*margoSkyLight(n);'), "sky's absolute colour replaced");
  assert.throws(() => sky.shader('@fragment fn custom() {}', 0), /standard core PBR shader/);
  assert.throws(() => sky.shader(alone, 0), /one per engine/);
});

test('LightProbes without an environment fall back to the hemisphere in either order; with one the hemisphere adds', () => {
  const { sky, probes, envProbes } = effects();
  for (const code of [sky.shader(probes.shader(coreShader, 0), 0), probes.shader(sky.shader(coreShader, 0), 0)]) {
    const f = fragment(code);
    assert.match(
      f,
      /probeShade\(i\.position,n,v,i\.color,i\.material\.y,i\.material\.x,i\.color\*\(1\.0-i\.material\.y\)\*margoSkyLight\(n\),vec3f\(0\.04\),1\.0\)/,
    );
    assert.ok(!linearLine(code).includes('margoSkyLight'), 'not twice');
    assert.doesNotMatch(f, /frame\.radiance\.w/);
  }
  for (const code of [sky.shader(envProbes.shader(coreShader, 0), 0), envProbes.shader(sky.shader(coreShader, 0), 0)])
    assert.ok(
      linearLine(code).includes('*margoSkyLight(n)') && fragment(code).includes(',vec3f(0),vec3f(0.04),1.0);'),
      'adds to IBL',
    );
});

test("gltf-pro's sky hook replaces the fixed gradient in every gltf-pro-family shader, beside IBL, inside probes' fallback", () => {
  const { sky, ibl, probes } = effects(),
    hooks = { sky: sky.pbr(2), ibl: ibl.pbr(2), probes: probes.pbr(2) },
    shaders = {
      standard: pbrShader,
      extended: extendedPBRShader,
      physical: physicalShader(),
      transmissive: transmissiveShader(),
      lambert: materialShader(pbrShader, 2, 'lambert'),
      phong: materialShader(extendedPBRShader, 2, 'phong'),
    };
  for (const [name, code] of Object.entries(shaders)) {
    assert.ok(code.includes(gradient), `${name} has the built-in gradient`);
    const lit = lightPBR(code, hooks.sky);
    assert.ok(!lit.includes(gradient) && !lit.includes('f.radiance.w'), `${name}: gradient and strength gone`);
    assert.ok(lit.includes('fn margoSkyHook(n:vec3f)->vec3f {return margoSkyLight(n);}'), name);
    assert.ok(!lit.includes('fn ambient(s:Surface)->vec3f {return vec3f(0);}'), `${name}: sky ambient on`);
    // IBL before or after: the sky ambient stays beside margoAmbient.
    for (const both of [
      lightPBR(lightPBR(code, hooks.ibl), hooks.sky),
      lightPBR(lightPBR(code, hooks.sky), hooks.ibl),
    ]) {
      assert.ok(!both.includes('fn ambient(s:Surface)->vec3f {return vec3f(0);}'), `${name}: IBL keeps the sky`);
      assert.ok(both.includes('+margoAmbient;') && !both.includes(gradient), name);
    }
    // Probes before or after: their fallback is the hook's sky, the sky ambient is theirs (no double count).
    for (const both of [
      lightPBR(lightPBR(code, hooks.probes), hooks.sky),
      lightPBR(lightPBR(code, hooks.sky), hooks.probes),
    ]) {
      assert.ok(both.includes('fn ambient(s:Surface)->vec3f {return vec3f(0);}'), `${name}: probes own the ambient`);
      assert.ok(both.includes('margoSkyHook(s.n),') && !both.includes(gradient), name);
    }
  }
  assert.throws(() => lightPBR(lightPBR(pbrShader, hooks.sky), { declarations: '', sky: 'vec3f(1)' }), /Two sky/);
});

test('HemisphereLight and AmbientLight upload sky and ground x intensity, live, once per change', () => {
  assert.throws(() => new HemisphereLight({ intensity: -1 }), RangeError);
  assert.throws(() => new HemisphereLight({ sky: '#12' }), TypeError);
  const gpu = mockGPU(),
    light = new HemisphereLight({ sky: '#ffffff', ground: [0.25, 0.5, 0], intensity: 2 });
  light.setup(fakeEngine(gpu.device));
  const run = passes(light),
    frame = context(gpu, { shader: coreShader, format: 'bgra8unorm' });
  const upload = (n) =>
    gpu
      .record(() => {
        for (let i = 0; i < n; i++) {
          frame.begin(i);
          run(frame.c);
        }
      })
      .filter((e) => e[0] === 'writeBuffer')
      .map((e) => [...hexFloats(e[3])]);
  assert.deepEqual(upload(3), [[2, 2, 2, 0, 0.5, 1, 0, 0]], 'one upload for three frames');
  light.intensity = 1;
  light.ground = undefined;
  assert.deepEqual(upload(1), [[1, 1, 1, 0, 1, 1, 1, 0]], 'ground defaults to the sky');
  const ambient = new AmbientLight({ color: [0.5, 0.25, 1], intensity: 4 });
  ambient.setup(fakeEngine(gpu.device));
  assert.deepEqual(Array.from(ambient['values']), [2, 1, 4, 0, 2, 1, 4, 0]);
  assert.equal(ambient.name, 'environment:ambient');
  ambient.color = '#000';
  assert.deepEqual(Array.from(ambient['values']), [0, 0, 0, 0, 0, 0, 0, 0]);
  light.dispose();
  ambient.dispose();
});

test('environment colours take CSS color(display-p3 ...): outside sRGB their linear channels stay negative', () => {
  const light = new HemisphereLight({ sky: 'color(display-p3 0 1 0)', ground: '#000000' });
  const values = Array.from(light['values']);
  assert.ok(values[0] < -0.2 && values[1] > 1.04 && values[2] < -0.07, `P3 green: ${values.slice(0, 3)}`);
  assert.throws(() => new HemisphereLight({ sky: 'color(rec2020 1 0 0)' }), TypeError);
});

test('the hemisphere binds one uniform, no texture or sampler', () => {
  const { sky } = effects(),
    code = sky.pbr(2).declarations;
  assert.doesNotMatch(code, /texture_|sampler/);
  assert.match(code, /@group\(2\) @binding\(144\) var<uniform> margoSkyLightData/);
});
