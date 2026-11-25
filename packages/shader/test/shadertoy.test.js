import test from 'node:test';
import assert from 'node:assert/strict';
import { Shadertoy } from '../dist/shadertoy.js';
import { ShaderPass } from '../dist/glsl-pass.js';
import { toyFixtures } from './shadertoy-fixtures.js';
import { checkWGSL } from '../../webgl2-compat/dist/wgsl.js';

const plain =
  'void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(fragCoord / iResolution.xy, 0.5, 1.0); }';
const fake3d = { width: 4, height: 4, depthOrArrayLayers: 4, dimension: '3d', createView() {} };

test('the Image source is wrapped with every documented input and a main that calls mainImage', () => {
  const toy = new Shadertoy(plain);
  for (const name of [
    'iResolution',
    'iTime',
    'iTimeDelta',
    'iFrameRate',
    'iFrame',
    'iChannelTime[4]',
    'iChannelResolution[4]',
    'iMouse',
    'iDate',
    'iSampleRate',
  ])
    assert.match(toy.fragmentShader, new RegExp(`uniform \\w+ ${name.replace(/[[\]]/g, '\\$&')};`), name);
  for (let i = 0; i < 4; i++) assert.match(toy.fragmentShader, new RegExp(`uniform sampler2D iChannel${i};`));
  assert.match(toy.fragmentShader, /^#version 300 es\n/);
  assert.match(toy.fragmentShader, /#define iGlobalTime iTime\n/);
  assert.match(toy.fragmentShader, /mainImage\(shadertoyOut,gl_FragCoord\.xy\)/);
  assert.match(toy.meshShaders.fragmentShader, /mainImage\(shadertoyOut,shadertoyUv\*iResolution\.xy\)/);
  const typed = new Shadertoy({
    image: { source: plain, iChannel1: { texture: null, type: 'cube' }, iChannel2: fake3d },
  });
  assert.match(typed.fragmentShader, /uniform samplerCube iChannel1;uniform sampler3D iChannel2;/);
  assert.equal(toy.resolution.join(), '512,512');
});

test('Shadertoy.attach makes the toy and attaches it to the engine, as engine.use does', () => {
  const used = [],
    engine = { use: (plugin) => (used.push(plugin), engine) };
  const toy = Shadertoy.attach(engine, { image: { source: plain }, resolution: [16, 8] });
  assert.ok(toy instanceof Shadertoy);
  assert.deepEqual(used, [toy]);
  assert.equal(toy.resolution.join(), '16,8');
  assert.throws(() => Shadertoy.attach(engine, 'void main() {}'), TypeError);
  assert.equal(used.length, 1, 'a source without mainImage attaches nothing');
});

test('each fixture translates to WGSL the layer accepts, as a pass, a texture and a material', () => {
  const textures = { '2d': null, cube: null, '3d': fake3d, input: 'input' };
  for (const f of toyFixtures) {
    const channels = Object.fromEntries(
      Object.entries(f.channels).map(([k, c]) => [
        k,
        c.kind === 'input' ? 'input' : { texture: textures[c.kind], type: c.kind, filter: c.filter, wrap: c.wrap },
      ]),
    );
    const toy = new Shadertoy({ image: { source: f.source, ...channels }, resolution: [32, 32] });
    const pass = toy.pass();
    for (const stage of ['vertex', 'fragment'])
      assert.doesNotThrow(() => checkWGSL(pass.material.code(stage, pass['mesh'])), `${f.name} pass ${stage}`);
    if (f.pass) {
      assert.equal(pass.input, 'iChannel0');
      assert.throws(() => toy.material(), { code: 'failed' });
      assert.throws(() => toy.texture, { code: 'failed' });
    } else {
      const material = toy.material();
      assert.doesNotThrow(() => checkWGSL(material.code('fragment')), `${f.name} material`);
      assert.equal(typeof toy.texture.bind, 'function');
    }
    toy.dispose();
  }
});

test('a syntax error names the line and column of the Image source', () => {
  const source =
    'void mainImage(out vec4 fragColor, in vec2 fragCoord) {\n  vec3 c = vec3(1.0);\n  fragColor = vec4(c, 1.0) +;\n}';
  for (const make of [(t) => t.pass(), (t) => t.material()]) {
    let error;
    try {
      make(new Shadertoy(source));
    } catch (e) {
      error = e;
    }
    assert.equal(error?.code, 'failed');
    assert.equal(error.stage, 'fragment');
    assert.equal(error.line, 3);
  }
});

test('the clock: the first frame is frame 0 at time 0, then each frame adds its delta; one owner per frame; pause holds it', () => {
  const toy = new Shadertoy(plain),
    pass = toy.pass();
  const uniform = (n) => pass.uniforms[n].value;
  pass.onPreUpdate(0.02);
  toy.onPreUpdate(0.5); // a second consumer in the same frame does not advance the clock
  assert.deepEqual([uniform('iTime'), uniform('iFrame'), uniform('iTimeDelta')], [0, 0, 0.02]);
  assert.equal(uniform('iFrameRate'), 50);
  pass.onPreUpdate(0.02);
  assert.deepEqual([uniform('iTime'), uniform('iFrame')], [0.02, 1]);
  toy.pause();
  pass.onPreUpdate(0.02);
  assert.deepEqual([uniform('iTime'), uniform('iFrame')], [0.02, 1]);
  toy.time = 1.25;
  toy.frame = 7;
  toy.mouse = [1, 2, 3, 4];
  toy.date = [2026, 10, 15, 43200.5];
  assert.deepEqual(
    [uniform('iTime'), uniform('iFrame'), [...uniform('iMouse')], [...uniform('iDate')]],
    [1.25, 7, [1, 2, 3, 4], [2026, 10, 15, 43200.5]],
  );
  toy.reset();
  assert.deepEqual([uniform('iTime'), uniform('iFrame')], [0, 0]);
  toy.date = undefined;
  assert.equal(uniform('iDate')[0], new Date().getFullYear());
  assert.equal(uniform('iSampleRate'), 44100);
  assert.throws(() => (pass.uniforms.iTime.value = 2), TypeError);
  toy.dispose();
});

test('iChannelResolution: a GPUTexture size, a given resolution, zero for none', () => {
  const toy = new Shadertoy({
    image: { source: plain, iChannel0: fake3d, iChannel2: { texture: null, resolution: [7, 9] } },
    resolution: [16, 8],
  });
  const material = toy.material();
  assert.deepEqual([...material.uniforms.iChannelResolution.value], [4, 4, 4, 0, 0, 0, 7, 9, 1, 0, 0, 0]);
  assert.deepEqual([...material.uniforms.iResolution.value], [16, 8, 1]);
  toy.dispose();
});

test('options are checked', () => {
  assert.throws(() => new Shadertoy('void main() {}'), TypeError);
  assert.throws(() => new Shadertoy({ image: { source: plain }, resolution: [0, 4] }), RangeError);
  assert.throws(
    () => new Shadertoy({ image: { source: plain, iChannel0: { texture: null, filter: 'cubic' } } }),
    TypeError,
  );
  assert.throws(
    () => new Shadertoy({ image: { source: plain, iChannel0: { texture: null, wrap: 'mirror' } } }),
    TypeError,
  );
  assert.throws(
    () => new Shadertoy({ image: { source: plain, iChannel0: { texture: 'input', type: 'cube' } } }),
    TypeError,
  );
  assert.throws(() => (new Shadertoy(plain).date = [1, 2]), TypeError);
});

const feedback =
  'void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = texture(iChannel0, fragCoord / iResolution.xy) * 0.5 + vec4(1.0, 0.0, 0.0, -3.0); }';
const multi = (extra = {}) =>
  new Shadertoy({
    common: 'float half_(float x) { return x * 0.5; }',
    bufferA: { source: feedback, iChannel0: 'A' },
    bufferB: { source: feedback, iChannel0: { texture: 'A', filter: 'mipmap', wrap: 'repeat' } },
    image: {
      source:
        'void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(half_(texture(iChannel1, fragCoord / iResolution.xy).r)); }',
      iChannel1: { texture: 'B', filter: 'nearest' },
    },
    resolution: [32, 16],
    ...extra,
  });

test('Common goes before every tab; a buffer keeps all four components, the image writes opaque colour', () => {
  const toy = multi();
  assert.deepEqual(Object.keys(toy.buffers), ['A', 'B']);
  for (const code of [toy.fragmentShader, toy.buffers.A, toy.buffers.B])
    assert.match(code, /#define iGlobalTime iTime\nfloat half_\(float x\) \{ return x \* 0\.5; \}\n/);
  assert.match(toy.buffers.A, /shadertoyColor=shadertoyOut;/);
  assert.match(toy.fragmentShader, /shadertoyColor=vec4\(shadertoyOut\.rgb,1\.0\);/);
  toy.dispose();
});

test('channels that read buffers bind unfilterable and filter by texel loads, so no device feature is needed', () => {
  const toy = multi(),
    pass = toy.pass(),
    chain = pass['chain'];
  assert.deepEqual(
    chain.passes.map((p) => [p.letter, p.mips]),
    [
      ['A', true],
      ['B', false],
    ],
  );
  const a = chain.passes[0].pass.material,
    b = chain.passes[1].pass.material;
  assert.equal(a.program.textures.find((t) => t.name === 'iChannel0').sampleType, 'unfilterable-float');
  assert.match(a.code('fragment'), /margoTapsAuto\(user_iChannel0,[^;]*,2u\)/);
  assert.match(b.code('fragment'), /margoTapsAuto\(user_iChannel0,[^;]*,5u\)/);
  // A nearest buffer channel is the device's own non-filtering sampler, with no taps.
  assert.equal(pass.material.program.textures.find((t) => t.name === 'iChannel1').sampleType, 'unfilterable-float');
  assert.doesNotMatch(pass.material.code('fragment'), /margoTaps\(|margoTapsAuto\(/);
  for (const m of [a, b, pass.material])
    for (const stage of ['vertex', 'fragment']) assert.doesNotThrow(() => checkWGSL(m.code(stage)), stage);
  const material = toy.material();
  assert.doesNotThrow(() => checkWGSL(material.code('fragment')));
  assert.deepEqual(
    [...material.uniforms.iChannelResolution.value].slice(3, 6),
    [0, 0, 1],
    'the attached chain sizes buffers once it runs',
  );
  toy.dispose();
});

test('a sampler argument carries its lookup mode, so a function filters a buffer as its channel says', () => {
  const toy = new Shadertoy({
    bufferA: { source: feedback },
    image: {
      source:
        'vec4 f(sampler2D s, vec2 p) { return texture(s, p); }\nvoid mainImage(out vec4 o, in vec2 c) { o = f(iChannel0, c / iResolution.xy) + f(iChannel1, c / iResolution.xy); }',
      iChannel0: 'A',
      iChannel1: { texture: null },
    },
  });
  const code = toy.pass().material.code('fragment');
  assert.match(code, /argument_0m:u32/);
  assert.match(
    code,
    /select\(textureSample\(argument_0,argument_0s,[^;]*margoTapsAuto\(argument_0,[^;]*argument_0m\),argument_0m>1u\)/,
  );
  assert.match(code, /\(user_iChannel0,user_iChannel0Sampler,2u,/);
  assert.match(code, /\(user_iChannel1,user_iChannel1Sampler,0u,/);
  assert.doesNotThrow(() => checkWGSL(code));
  toy.dispose();
});

test('an error in Common or a buffer names its tab and line', () => {
  const broken = 'void mainImage(out vec4 fragColor, in vec2 fragCoord) {\n  fragColor = vec4(1.0) +;\n}';
  for (const [options, tab, line] of [
    [{ common: 'float a = 1.0;\nfloat b = ;', image: { source: plain } }, 'common', 2],
    [{ common: 'float a = 1.0;', bufferB: { source: broken }, image: { source: plain } }, 'bufferB', 2],
    [{ common: 'float a = 1.0;\n', image: { source: broken } }, 'image', 2],
  ]) {
    let error;
    try {
      new Shadertoy(options).pass();
    } catch (e) {
      error = e;
    }
    assert.equal(error?.code, 'failed', tab);
    assert.deepEqual([error.tab, error.line], [tab, line]);
  }
});

test('keyboard, audio and video channels: sizes, times and key state', () => {
  const keys = new EventTarget(),
    video = { videoWidth: 64, videoHeight: 36, readyState: 4, currentTime: 3.25 },
    sound = { getByteFrequencyData() {}, getByteTimeDomainData() {}, context: { currentTime: 9.5 } };
  const toy = new Shadertoy({
    image: { source: plain, iChannel0: 'keyboard', iChannel1: sound, iChannel2: video },
    keyboard: keys,
  });
  const material = toy.material();
  assert.deepEqual([...material.uniforms.iChannelResolution.value].slice(0, 9), [256, 3, 1, 512, 2, 1, 64, 36, 1]);
  assert.deepEqual([...material.uniforms.iChannelTime.value], [0, 9.5, 3.25, 0]);
  keys.dispatchEvent(Object.assign(new Event('keydown'), { keyCode: 65 }));
  keys.dispatchEvent(Object.assign(new Event('keydown'), { keyCode: 65 }));
  keys.dispatchEvent(Object.assign(new Event('keyup'), { keyCode: 66 }));
  const k = toy['keys'];
  assert.deepEqual(
    [k.down[65], k.pressed[65], k.toggled[65], k.down[66]],
    [255, 255, 255, 0],
    'a held key toggles once',
  );
  toy.dispose();
  keys.dispatchEvent(Object.assign(new Event('keydown'), { keyCode: 67 }));
  assert.equal(k.down[67], 0, 'a disposed toy stops listening');
});

test('paused, the buffers hold until the frame is set', () => {
  const toy = multi();
  toy.pause();
  const a = toy.step();
  assert.equal(toy.step(), a);
  toy.frame = 3;
  assert.notEqual(toy.step(), a);
  toy.play();
  toy.dispose();
});

test('buffer channels are checked', () => {
  assert.throws(
    () => new Shadertoy({ image: { source: plain, iChannel0: 'C' } }),
    /Buffer C, which this toy does not have/,
  );
  assert.throws(
    () =>
      new Shadertoy({
        bufferA: { source: plain },
        image: { source: plain, iChannel0: { texture: 'A', type: 'cube' } },
      }),
    TypeError,
  );
  assert.throws(
    () => new Shadertoy({ bufferA: { source: 'void main() {}' }, image: { source: plain } }),
    /bufferA needs a source/,
  );
  assert.throws(() => new Shadertoy({ common: 3, image: { source: plain } }), TypeError);
  assert.throws(
    () => new Shadertoy({ image: { source: plain, iChannel0: { texture: 'keyboard', type: '3d' } } }),
    TypeError,
  );
});

// Push 7: Cube A, mainVR and mainSound.
const fakeEngine = { gpu: {}, sceneOf: () => undefined };
// The flag values the readback names (WebGPU, W3C), for a fake device under Node.
globalThis.GPUTextureUsage ??= {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16,
};
globalThis.GPUBufferUsage ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8 };
globalThis.GPUMapMode ??= { READ: 1, WRITE: 2 };
const cubeSource =
  'void mainCubemap(out vec4 fragColor, in vec2 fragCoord, in vec3 rayOri, in vec3 rayDir) { fragColor = vec4(rayDir, 1.0); }';
const soundSource =
  'vec2 mainSound(int samp, float time) { return vec2(sin(6.2831853 * fract(440.0 * time)), float(samp % 7) / 7.0); }';
const vrSource = `${plain}\nvoid mainVR(out vec4 fragColor, in vec2 fragCoord, in vec3 fragRayOri, in vec3 fragRayDir) { fragColor = vec4(fragRayDir + fragRayOri, 1.0); }`;

test('Cube A, mainVR and mainSound programs translate to WGSL the layer accepts', () => {
  const toy = new Shadertoy({
    image: { source: vrSource, iChannel0: 'cubeA' },
    cubeA: { source: cubeSource, size: 16, iChannel0: { texture: 'cubeA', filter: 'mipmap' } },
    sound: { source: soundSource },
    vr: true,
  });
  assert.match(toy.fragmentShader, /mainImage\(shadertoyOut,gl_FragCoord\.xy\)/);
  assert.match(toy.vrShader, /uniform mat4 shadertoyEye;uniform vec3 shadertoyEyePosition;/);
  assert.match(toy.vrShader, /mainVR\(shadertoyOut,gl_FragCoord\.xy,shadertoyEyePosition,normalize\(/);
  assert.match(
    toy.meshShaders.vertexShader,
    /shadertoyRay=\(modelMatrix\*vec4\(position,1\.0\)\)\.xyz-cameraPosition;/,
  );
  assert.match(
    toy.meshShaders.fragmentShader,
    /mainVR\(shadertoyOut,shadertoyUv\*iResolution\.xy,shadertoyRayOri,normalize\(shadertoyRay\)\)/,
  );
  assert.match(toy.cubeShader, /uniform samplerCube iChannel0;/);
  assert.match(toy.cubeShader, /mainCubemap\(shadertoyOut,shadertoyP,vec3\(0\.0\),normalize\(shadertoyD\)\)/);
  assert.match(toy.soundShader, /uniform int shadertoySoundBase;/);
  assert.match(toy.soundShader, /mainSound\(shadertoyN,float\(shadertoyN\)\/iSampleRate\)/);
  const pass = toy.pass(),
    cube = pass['chain'].cube;
  assert.equal(cube.size, 16);
  assert.equal(cube.mips, true, 'a mipmap channel of Cube A gives the cube mip levels');
  for (const [label, code] of [
    ['vr pass', pass.material.code('fragment', pass['mesh'])],
    ['vr material', toy.material().code('fragment')],
    ['vr material vertex', toy.material().code('vertex')],
    ['cube', cube.pass.material.code('fragment', cube.pass['mesh'])],
    [
      'sound',
      new ShaderPass(
        { fragmentShader: toy.soundShader },
        { input: null, builtins: false, clipSpace: 'webgpu' },
      ).material.code('fragment'),
    ],
  ])
    assert.doesNotThrow(() => checkWGSL(code), label);
  // The older form takes the time alone.
  const old = new Shadertoy({
    image: { source: plain },
    sound: { source: 'vec2 mainSound(float time) { return vec2(sin(time)); }' },
  });
  assert.match(old.soundShader, /clamp\(mainSound\(float\(shadertoyN\)\/iSampleRate\),-1\.0,1\.0\)/);
  toy.dispose();
});

test('Cube A, sound and vr options are checked', () => {
  assert.throws(() => new Shadertoy({ image: { source: plain }, cubeA: { source: 'void main() {}' } }), {
    name: 'TypeError',
    message: /mainCubemap/,
  });
  for (const size of [0, 1000, 4096, 1.5])
    assert.throws(
      () => new Shadertoy({ image: { source: plain }, cubeA: { source: cubeSource, size } }),
      RangeError,
      `size ${size}`,
    );
  assert.throws(() => new Shadertoy({ image: { source: plain, iChannel0: 'cubeA' } }), {
    name: 'TypeError',
    message: /add cubeA/,
  });
  assert.throws(
    () =>
      new Shadertoy({
        image: { source: plain, iChannel0: { texture: 'cubeA', type: '2d' } },
        cubeA: { source: cubeSource },
      }),
    { message: /Cube A is a cube channel/ },
  );
  assert.throws(() => new Shadertoy({ image: { source: plain }, sound: { source: plain } }), {
    name: 'TypeError',
    message: /mainSound/,
  });
  for (const input of ['A', 'keyboard', 'cubeA'])
    assert.throws(
      () =>
        new Shadertoy({
          image: { source: plain },
          bufferA: { source: plain },
          cubeA: { source: cubeSource },
          sound: { source: soundSource, iChannel1: input },
        }),
      { name: 'TypeError', message: /sound iChannel1 reads textures only/ },
      input,
    );
  assert.throws(() => new Shadertoy({ image: { source: plain }, vr: true }), { name: 'TypeError', message: /mainVR/ });
  assert.equal(new Shadertoy({ image: { source: plain }, cubeA: { source: cubeSource } })['cubeSize'], 1024);
});

test('an error in Cube A or Sound names its tab and line', async () => {
  const broken =
    'void mainCubemap(out vec4 fragColor, in vec2 fragCoord, in vec3 rayOri, in vec3 rayDir) {\n  fragColor = vec4(1.0) +;\n}';
  let error;
  try {
    new Shadertoy({ image: { source: plain, iChannel0: 'cubeA' }, cubeA: { source: broken } }).pass();
  } catch (e) {
    error = e;
  }
  assert.deepEqual([error?.code, error?.tab, error?.line], ['failed', 'cubeA', 2]);
  const toy = new Shadertoy({
    image: { source: plain },
    sound: { source: 'vec2 mainSound(int samp, float time) {\n  return vec2(1.0) +;\n}' },
  });
  toy.setup(fakeEngine);
  await assert.rejects(toy.sound({ seconds: 1 }), (e) => e.code === 'failed' && e.tab === 'sound' && e.line === 2);
});

test('channels other than mipmap read the base level only, as GL does without a mipmap min filter', () => {
  const toy = new Shadertoy({
      image: {
        source: plain,
        iChannel0: { texture: null, filter: 'linear' },
        iChannel1: { texture: null, filter: 'nearest' },
        iChannel2: { texture: null, filter: 'mipmap' },
      },
    }),
    [linear, nearest, mipmap] = toy['tabs'][0].channels.map((c) => c.sampler);
  assert.equal(linear.lodMaxClamp, 0);
  assert.equal(nearest.lodMaxClamp, 0);
  assert.equal(mipmap.lodMaxClamp, undefined);
  assert.equal(mipmap.mipmapFilter, 'linear');
});

test('toy.sound() is checked: a Sound tab, an attached toy, its length and its signal', async () => {
  await assert.rejects(new Shadertoy(plain).sound(), { code: 'failed', message: /no Sound tab/ });
  const toy = new Shadertoy({ image: { source: plain }, sound: { source: soundSource } });
  await assert.rejects(toy.sound(), { code: 'state' });
  toy.setup(fakeEngine);
  for (const seconds of [0, -1, 601, Number.NaN])
    await assert.rejects(toy.sound({ seconds }), RangeError, `seconds ${seconds}`);
  const abort = new AbortController();
  abort.abort(new Error('stopped'));
  await assert.rejects(toy.sound({ signal: abort.signal }), { message: 'stopped' });
});

// A device whose mapped buffers hold, for each block, sample n as (n, -n): what the Sound tab draws there.
function soundDevice(log) {
  let base = 0;
  return {
    draw: (b) => {
      base = b;
      log.push(`draw ${b}`);
    },
    device: {
      createTexture: () => ({ createView: () => ({}), destroy() {} }),
      createBuffer: ({ size }) => {
        const first = base,
          texels = new Float32Array(size / 4);
        for (let i = 0; i < texels.length / 4; i++) texels.set([first + i, -(first + i)], i * 4);
        return {
          mapAsync: () => (log.push(`map ${first}`), Promise.resolve()),
          getMappedRange: () => texels.buffer,
          destroy: () => log.push(`destroy ${first}`),
        };
      },
    },
  };
}
const registered = async (toy) => {
  for (let i = 0; i < 50 && !toy['jobs'].size; i++) await new Promise((resolve) => setImmediate(resolve));
  return [...toy['jobs']][0];
};
test('the Sound tab reads back one block a frame, maps it on the next frame, and starts again on a new device', async () => {
  const toy = new Shadertoy({ image: { source: plain }, sound: { source: soundSource }, sampleRate: 1000 });
  toy.setup(fakeEngine);
  const done = toy.sound({ seconds: 300 }),
    job = await registered(toy);
  assert.ok(job, 'the job is registered once the readback module has loaded');
  const log = [],
    first = soundDevice(log),
    second = soundDevice(log),
    frame = (d) => job.frame({ device: d.device, encoder: { copyTextureToBuffer() {} }, width: 32, height: 32 });
  job['draw'] = (c, b) => (c.device === first.device ? first : second).draw(b);
  frame(first);
  frame(second);
  assert.deepEqual(log, ['draw 0', 'destroy 0', 'draw 0'], 'a new device drops the old block and draws block 0 again');
  frame(second);
  frame(second);
  const sound = await done;
  assert.deepEqual(log.slice(3), ['map 0', 'draw 262144', 'map 262144', 'destroy 0', 'destroy 262144']);
  assert.equal(sound.sampleRate, 1000);
  assert.deepEqual([sound.channels[0].length, sound.channels[1].length], [300000, 300000]);
  for (const n of [0, 1, 262143, 262144, 299999])
    assert.deepEqual([sound.channels[0][n], sound.channels[1][n]], [n, -n], `sample ${n}`);
  const made = [];
  const buffer = sound.audioBuffer({
    createBuffer: (channels, length, rate) => ({
      channels,
      length,
      rate,
      copyToChannel: (data, i) => made.push([i, data]),
    }),
  });
  assert.deepEqual([buffer.channels, buffer.length, buffer.rate], [2, 300000, 1000]);
  assert.deepEqual(
    made.map(([i, data]) => [i, data === sound.channels[i]]),
    [
      [0, true],
      [1, true],
    ],
  );
  toy.dispose();
});

test('disposing a toy stops its sound render', async () => {
  const toy = new Shadertoy({ image: { source: plain }, sound: { source: soundSource } });
  toy.setup(fakeEngine);
  const done = toy.sound({ seconds: 1 });
  assert.ok(await registered(toy));
  toy.dispose();
  await assert.rejects(done, { code: 'disposed' });
});

test("a view with its own texture field (the WebGL2 layer's views) is the channel texture, not a channel object (KB-COMPAT-RAWFIRST1)", () => {
  class LayerTexture {
    texture = { gl: true };
    width = 4;
    height = 4;
    depthOrArrayLayers = 1;
    dimension = '2d';
    createView() {
      return new LayerView(this);
    }
  }
  class LayerView {
    constructor(texture) {
      this.texture = texture;
      this.dimension = '2d';
    }
  }
  const view = new LayerTexture().createView(),
    toy = new Shadertoy({ image: { source: plain, iChannel0: view } }),
    material = toy.material();
  const bound = material.textures.user_iChannel0 ?? Object.values(material.textures)[0];
  assert.equal(bound.texture, view, 'the view itself is bound');
  toy.dispose();
});
