// Real-GPU fixture for @margoengine/materials' toon shading, per-material envMap, data/3D/array textures, standalone
// KTX2 textures, Display P3 textures and the shadow catcher's directional and area light shadows. Built imports, so it
// exercises the published package boundary. scripts/mat-more-gpu-check.js drives it and checks the numbers.
import { Engine } from '../packages/core/dist/extension.js';
import {
  CubeTexture,
  LambertMaterial,
  Material,
  PbrMaterial,
  ShadowCatcherMaterial,
  Texture,
  ToonMaterial,
  UnlitMaterial,
  WgslMaterial,
  createMesh,
  loadKTX2Texture,
  toonModel,
} from '../packages/materials/dist/index.js';
import type { MeshGeometry } from '../packages/materials/dist/index.js';
import { parseGLTF } from '../packages/gltf-pro/dist/index.js';
import type { PBRModel } from '../packages/gltf-pro/dist/index.js';
import { PostStack } from '../packages/post/dist/index.js';
import { Tonemap } from '../packages/tonemap/dist/index.js';
import { Clustered } from '../packages/clustered/dist/index.js';
import { LocalShadows } from '../packages/clustered/dist/shadows.js';
import { DirectionalLights } from '../packages/clustered/dist/directional.js';
import { AreaLights } from '../packages/clustered/dist/area.js';
import { Animation, Skeleton, Skin } from '../packages/animation/dist/index.js';
import { Environment } from '../packages/environment/dist/index.js';
import { KTX2Decoder } from '../packages/decoders/dist/index.js';

declare const GPUBufferUsage: { COPY_DST: number; MAP_READ: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
declare const GPUMapMode: { READ: number };

const W = 320,
  H = 240,
  canvas = document.querySelector('canvas')!,
  engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 0, 3], target: [0, 0, 0] },
    features: ['texture-compression-bc'],
  }),
  errors: string[] = [],
  disposers: (() => void)[] = [];
engine.stop();
// x in [-2, 2] and y in [-1.5, 1.5] fill the canvas (80 pixels per unit), reverse-Z orthographic.
engine.camera.project = (out) => {
  out.fill(0);
  out[0] = 0.5;
  out[5] = 2 / 3;
  out[10] = 1 / 99.9;
  out[14] = 100 / 99.9;
  out[15] = 1;
};
engine.onError = (error) => errors.push(String(error));
const device = engine.gpu!;
device.addEventListener('uncapturederror', (event) => errors.push((event as GPUUncapturedErrorEvent).error.message));
const stack = PostStack.attach(engine, [new Tonemap({ curve: 'neutral' })]);
/** Sun along `l` (unit, toward the light) with intensity `w`, white radiance, ambient strength `ambient`. */
function light(l: number[], w: number, ambient = 0) {
  const n = Math.hypot(l[0], l[1], l[2]) || 1;
  engine.lighting.direction.set([l[0] / n, l[1] / n, l[2] / n, w]);
  engine.lighting.radiance.set([1, 1, 1, ambient]);
}
async function frame(): Promise<void> {
  device.pushErrorScope('validation');
  try {
    engine.render();
    await device.queue.onSubmittedWorkDone();
  } finally {
    const error = await device.popErrorScope();
    if (error) errors.push(error.message);
  }
}
const half = (word: number) => {
  const exponent = (word >> 10) & 31,
    mantissa = word & 1023,
    value = exponent ? 2 ** (exponent - 15) * (1 + mantissa / 1024) : (2 ** -14 * mantissa) / 1024;
  return word & 32768 ? -value : value;
};
/** The HDR scene (linear, before the tone map) as RGBA floats. */
async function read(): Promise<Float32Array> {
  await frame();
  await frame();
  const source = stack.sceneTexture!,
    buffer = device.createBuffer({ size: W * H * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: source }, { buffer, bytesPerRow: W * 8 }, [W, H]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    return Float32Array.from(new Uint16Array(buffer.getMappedRange()), half);
  } finally {
    buffer.unmap();
    buffer.destroy();
  }
}
/** Mean RGB over the world box [x0, x1] x [y0, y1] (z = 0 plane) of image `img`, and its largest deviation. */
function box(img: Float32Array, x0: number, x1: number, y0 = -0.25, y1 = 0.25) {
  const px = (x: number) => Math.round((x + 2) * 80),
    py = (y: number) => Math.round((1.5 - y) * 80),
    sum = [0, 0, 0],
    values: number[][] = [];
  for (let y = py(y1); y < py(y0); y++)
    for (let x = px(x0); x < px(x1); x++) {
      const i = (y * W + x) * 4;
      values.push([img[i], img[i + 1], img[i + 2]]);
      for (let c = 0; c < 3; c++) sum[c] += img[i + c];
    }
  const mean = sum.map((v) => v / values.length),
    spread = Math.max(...values.map((v) => Math.max(...v.map((c, k) => Math.abs(c - mean[k])))));
  return { mean, spread };
}
function clear() {
  for (const dispose of disposers.splice(0).reverse()) dispose();
}
function quad(normal = [0, 0, 1], left = -1.5, right = 1.5, bottom = -1, top = 1, z = 0): MeshGeometry {
  const n = Math.hypot(normal[0], normal[1], normal[2]),
    m = normal.map((v) => v / n);
  return {
    positions: [left, bottom, z, right, bottom, z, right, top, z, left, top, z],
    normals: [...m, ...m, ...m, ...m],
    uvs: [0, 1, 1, 1, 1, 0, 0, 0],
    indices: [0, 1, 2, 0, 2, 3],
  };
}
function mesh(material: Material, geometry: MeshGeometry = quad()) {
  const m = createMesh(engine, geometry, material);
  disposers.push(() => m.destroy());
  return m;
}
/** A glTF quad (normal +Z, base colour `color`), optionally with one morph target moving its normals by `delta`. */
function gltfQuad(color: number[], delta?: number[]): PBRModel {
  const g = quad(),
    buffers: ArrayBufferView[] = [],
    accessors: object[] = [],
    bufferViews: object[] = [];
  const accessor = (data: Float32Array | Uint16Array, type: string, extra: object = {}) => {
    buffers.push(data);
    bufferViews.push({ buffer: buffers.length - 1, byteLength: data.byteLength });
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: data instanceof Uint16Array ? 5123 : 5126,
      count: data.length / ({ SCALAR: 1, VEC2: 2, VEC3: 3 } as Record<string, number>)[type],
      type,
      ...extra,
    });
    return accessors.length - 1;
  };
  const position = accessor(new Float32Array(g.positions), 'VEC3', { min: [-1.5, -1, 0], max: [1.5, 1, 0] }),
    normal = accessor(new Float32Array(g.normals), 'VEC3'),
    indices = accessor(new Uint16Array(g.indices!), 'SCALAR'),
    target = delta
      ? accessor(new Float32Array([...delta, ...delta, ...delta, ...delta]), 'VEC3', {
          min: delta,
          max: delta,
        })
      : undefined;
  const doc = {
    asset: { version: '2.0' },
    buffers: buffers.map((b) => ({ byteLength: b.byteLength })),
    bufferViews,
    accessors,
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0, roughnessFactor: 1 } }],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: position, NORMAL: normal },
            indices,
            material: 0,
            ...(target !== undefined ? { targets: [{ NORMAL: target }] } : {}),
          },
        ],
        ...(target !== undefined ? { weights: [0] } : {}),
      },
    ],
    nodes: [{ mesh: 0 }],
  };
  const model = parseGLTF(engine, doc, buffers);
  disposers.push(() => model.dispose());
  return model;
}
const raw = (bytes: number[], width = 1, height = 1) => ({ data: new Uint8Array(bytes), width, height });
const solid = (r: number, g: number, b: number) => raw([r, g, b, 255, r, g, b, 255, r, g, b, 255, r, g, b, 255], 2, 2);
const c = [0.8, 0.4, 0.2];

const scenarios: Record<string, () => Promise<unknown>> = {
  // Toon on a constructed mesh: the sun through steps bands and a gradient map (light.w = pi: expected colour x ramp).
  async toon() {
    const out: Record<string, unknown> = {},
      material = new ToonMaterial({ color: c });
    mesh(material);
    for (const [label, l] of [
      ['facing', [0, 0, 1]],
      ['side', [0.9798, 0, 0.2]],
      ['behind', [0, 0, -1]],
    ] as const) {
      light([...l], Math.PI);
      out[label] = box(await read(), -1, 1);
    }
    material.gradientMap = new Texture(
      raw([26, 26, 26, 255, 77, 77, 77, 255, 153, 153, 153, 255, 255, 255, 255, 255], 4, 1),
      {
        colorSpace: 'linear',
        magFilter: 'nearest',
        minFilter: 'nearest',
        mipmaps: false,
      },
    );
    for (const [label, l] of [
      ['gradientFacing', [0, 0, 1]],
      ['gradientSide', [0.9798, 0, 0.2]],
    ] as const) {
      light([...l], Math.PI);
      out[label] = box(await read(), -1, 1);
    }
    // Hemisphere ambient only: toon lights it as Lambert does.
    material.gradientMap = null;
    light([0, 0, 1], 0, 1);
    out.ambientToon = box(await read(), -1, 1);
    clear();
    mesh(new LambertMaterial({ color: c }));
    out.ambientLambert = box(await read(), -1, 1);
    clear();
    return out;
  },
  // A clustered point light: steps-3 toon over the same toon with an all-white gradient (no banding) is the band value.
  async toonClustered() {
    light([0, 0, 1], 0, 0);
    const lights = Clustered.attach(engine);
    disposers.push(() => lights.dispose());
    lights.setLights([{ position: [3, 0, 0.3], range: 20, intensity: 30 }]);
    const material = new ToonMaterial({ color: c }),
      m = mesh(material);
    disposers.push(lights.add(m));
    const banded = box(await read(), -1, 1);
    material.gradientMap = new Texture(raw([255, 255, 255, 255]), { mipmaps: false, colorSpace: 'linear' });
    const open = box(await read(), -1, 1);
    clear();
    return { banded, open };
  },
  // Toon on a loaded glTF model (toonModel): unposed, then skinned by a bone turned -75 degrees about +Y, then morphed.
  async toonLoaded() {
    const out: Record<string, unknown> = {};
    light([0, 0, 1], Math.PI);
    const model = gltfQuad(c);
    out.standard = box(await read(), -1, 1);
    const toon = toonModel(model);
    out.toon = box(await read(), -1, 1);
    clear();
    mesh(new ToonMaterial({ color: c }));
    out.constructed = box(await read(), -1, 1);
    clear();
    const skinned = gltfQuad(c),
      skeleton = new Skeleton([{ name: 'root', parent: -1 }]),
      skin = Skin.attach(
        skinned,
        skeleton,
        new Uint16Array(16),
        Float32Array.from({ length: 16 }, (_, i) => +(i % 4 === 0)),
      );
    disposers.push(() => skin.dispose());
    const toonSkinned = toonModel(skinned),
      angle = (-75 * Math.PI) / 180;
    skeleton.setPose(0, { rotation: [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)] });
    out.skinned = box(await read(), -0.3, 0.3);
    toonSkinned.dispose();
    out.skinnedStandard = box(await read(), -0.3, 0.3);
    clear();
    const morphed = gltfQuad(c, [-0.9659, 0, -0.7412]),
      animation = Animation.attach(morphed);
    disposers.push(() => animation.dispose());
    toonModel(morphed);
    animation.setMorph(0, 0, 1);
    out.morphed = box(await read(), -1, 1);
    clear();
    // Restored: the loaded model draws exactly as before toonModel.
    const again = gltfQuad(c),
      before = await read(),
      handle = toonModel(again);
    await read();
    handle.dispose();
    const after = await read();
    let max = 0;
    for (let i = 0; i < before.length; i++) max = Math.max(max, Math.abs(before[i] - after[i]));
    out.restoredMaxDifference = max;
    clear();
    void toon;
    return out;
  },
  // envMap: six solid faces reflected by unlit (mix) and standard materials, a raw cube target, mip sampling by
  // roughness, uniform-white environments (CubeTexture and an Environment) and envMap off.
  async envMap() {
    const out: Record<string, unknown> = {};
    light([0, 0, 1], 0, 0);
    const faces = [
        [255, 0, 0],
        [0, 255, 255],
        [0, 255, 0],
        [255, 0, 255],
        [0, 0, 255],
        [255, 255, 0],
      ],
      cube = new CubeTexture(
        faces.map(([r, g, b]) => solid(r, g, b)),
        { mipmaps: false },
      );
    const unlit = new UnlitMaterial({ envMap: cube, combine: 'mix' });
    mesh(unlit);
    out.front = box(await read(), -1, 1);
    clear();
    mesh(unlit, quad([1, 0, 1]));
    out.tilted = box(await read(), -0.5, 0.5);
    clear();
    // A cube render target's shape ({texture, view}, environment CubeCamera's): 2x2 solid faces, so filtering across a
    // face edge stays within one colour.
    const texture = device.createTexture({
      size: [2, 2, 6],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    disposers.push(() => texture.destroy());
    device.queue.writeTexture(
      { texture },
      new Uint8Array(faces.flatMap((f) => [...f, 255, ...f, 255, ...f, 255, ...f, 255])),
      { bytesPerRow: 8, rowsPerImage: 2 },
      [2, 2, 6],
    );
    mesh(new UnlitMaterial({ envMap: { texture, view: texture.createView({ dimension: 'cube' }) }, combine: 'mix' }));
    out.target = box(await read(), -1, 1);
    clear();
    // +Z face: left half red, right half green (4x4), mips per face; metal mirror at roughness 0 and 1.
    const split = new Uint8Array(64);
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) split.set(x < 2 ? [255, 0, 0, 255] : [0, 255, 0, 255], (y * 4 + x) * 4);
    const black = () => ({ data: new Uint8Array(64).fill(0), width: 4, height: 4 }),
      halves = new CubeTexture([black(), black(), black(), black(), { data: split, width: 4, height: 4 }, black()]),
      metal = new PbrMaterial({ metalness: 1, roughness: 0, envMap: halves });
    mesh(metal);
    let img = await read();
    out.sharpLeft = box(img, -1.4, -1);
    out.sharpRight = box(img, 1, 1.4);
    metal.roughness = 1;
    img = await read();
    out.roughLeft = box(img, -1.4, -1);
    out.roughRight = box(img, 1, 1.4);
    clear();
    // Uniform white light: the split-sum specular and the diffuse add to the light's own value.
    const white = new CubeTexture(
      Array.from({ length: 6 }, () => solid(255, 255, 255)),
      { colorSpace: 'linear' },
    );
    const dielectric = new PbrMaterial({ roughness: 0.5, envMap: white });
    mesh(dielectric);
    out.uniformCube = box(await read(), -1, 1);
    const environment = await Environment.create(engine, {
      size: 16,
      faces: Array.from({ length: 6 }, () => new Float32Array(16 * 16 * 4).fill(1)),
    });
    disposers.push(() => environment.dispose());
    dielectric.envMap = environment;
    out.uniformEnvironment = box(await read(), -1, 1);
    dielectric.envMap = null;
    const cleared = await read();
    clear();
    mesh(new PbrMaterial({ roughness: 0.5 }));
    const never = await read();
    let max = 0;
    for (let i = 0; i < never.length; i++) max = Math.max(max, Math.abs(never[i] - cleared[i]));
    out.offMaxDifference = max;
    clear();
    return out;
  },
  // Data textures read by a WgslMaterial: rgba16float (sampled), r32float 3D (textureLoad) and a 2D array, with a
  // live region update of the 3D one.
  async dataTextures() {
    light([0, 0, 1], 0, 0);
    const hdr = new Texture({
        data: new Float32Array([2.5, -0.5, 0.25, 1]),
        width: 1,
        height: 1,
        format: 'rgba16float',
      }),
      volumeData = Float32Array.from({ length: 8 }, (_, i) => 0.1 + i * 0.125),
      volume = new Texture(
        { data: volumeData, width: 2, height: 2, depth: 2, format: 'r32float' },
        { dimension: '3d' },
      ),
      stack2 = new Texture(
        {
          data: new Uint8Array([10, 20, 30, 255, 51, 102, 204, 255]),
          width: 1,
          height: 1,
          depth: 2,
          format: 'rgba8unorm',
        },
        { dimension: '2d-array', colorSpace: 'linear' },
      ),
      material = new WgslMaterial({
        shading: 'basic',
        wgsl: `fn shade(i: Out, s: Surface) -> Surface {
  var o = s;
  let a = textureSampleLevel(hdr, hdrSampler, vec2f(0.5), 0.0);
  let b = textureLoad(volume, vec3i(1, 0, 1), 0).r;
  let d = textureSampleLevel(layers2, layers2Sampler, vec2f(0.5), 1, 0.0);
  o.base = select(vec4f(a.rgb, 1.0), vec4f(b, d.r, d.b, 1.0), uniforms.which > 0.5);
  return o;
}`,
        uniforms: { which: 0 },
        textures: { hdr, volume, layers2: stack2 },
      });
    mesh(material);
    const out: Record<string, unknown> = { float16: box(await read(), -1, 1) };
    material.uniforms.which = 1;
    out.volumeAndArray = box(await read(), -1, 1);
    volumeData[5] = 0.3;
    volume.update({ x: 1, y: 0, z: 1, width: 1, height: 1, depth: 1 });
    out.volumeUpdated = box(await read(), -1, 1);
    out.expected = { volume: volumeData[5], before: 0.1 + 5 * 0.125 };
    clear();
    return out;
  },
  // A standalone KTX2 file (Dot_C.ktx2, ETC1S sRGB 128x128) on an unlit map, transcoded for this device and to RGBA8.
  async ktx2() {
    light([0, 0, 1], 0, 0);
    const url = '/packages/decoders/tests/fixtures/Dot_C.ktx2',
      gpuDecoder = new KTX2Decoder({ device }),
      cpuDecoder = new KTX2Decoder({ target: 'rgba8' });
    disposers.push(
      () => gpuDecoder.dispose(),
      () => cpuDecoder.dispose(),
    );
    const compressed = await loadKTX2Texture(url, { decoder: gpuDecoder }),
      bytes = await (await fetch(url)).arrayBuffer(),
      result = await cpuDecoder.transcode(bytes),
      rgba8 = new Texture(result),
      reference = new Texture(
        { data: result.mipmaps[0].data, width: result.width, height: result.height },
        { mipmaps: false },
      );
    const images: Float32Array[] = [];
    for (const map of [compressed, rgba8, reference]) {
      mesh(new UnlitMaterial({ map }));
      images.push(await read());
      clear();
    }
    const diff = (a: Float32Array, b: Float32Array) => {
      let max = 0,
        sum = 0,
        n = 0;
      for (let y = 50; y < 190; y++)
        for (let x = 60; x < 260; x++)
          for (let k = 0; k < 3; k++) {
            const d = Math.abs(a[(y * W + x) * 4 + k] - b[(y * W + x) * 4 + k]);
            max = Math.max(max, d);
            sum += d;
            n++;
          }
      return { max, mean: sum / n };
    };
    const contrast = box(images[2], -1.4, 1.4, -0.9, 0.9).spread;
    return {
      target: gpuDecoder.target,
      format: result.format,
      size: [result.width, result.height, result.mipmaps.length],
      compressedVsReference: diff(images[0], images[2]),
      rgba8VsReference: diff(images[1], images[2]),
      contrast,
    };
  },
  // Display P3 pixels: pure P3 red and a neutral grey on unlit maps, against sRGB-tagged copies.
  async p3() {
    light([0, 0, 1], 0, 0);
    const out: Record<string, unknown> = {};
    for (const [label, bytes, space] of [
      ['p3Red', [255, 0, 0, 255], 'display-p3'],
      ['srgbRed', [255, 0, 0, 255], 'srgb'],
      ['p3Grey', [188, 188, 188, 255], 'display-p3'],
      ['srgbGrey', [188, 188, 188, 255], 'srgb'],
    ] as const) {
      mesh(new UnlitMaterial({ map: new Texture(raw([...bytes]), { colorSpace: space, mipmaps: false }) }));
      out[label] = box(await read(), -1, 1);
      clear();
    }
    return out;
  },
  // ShadowCatcherMaterial under castShadow directional and area lights: a caster's shadow darkens a white background
  // through the black catcher (pixel = 1 - alpha); without castShadow it stays white.
  async catcher() {
    light([0, 0, 1], 0, 0);
    const out: Record<string, unknown> = {};
    for (const kind of ['directional', 'area'] as const)
      for (const castShadow of [true, false]) {
        const lights = Clustered.attach(engine),
          local = LocalShadows.attach(engine, { lights, resolution: 512 }),
          suns = DirectionalLights.attach(engine, { lights }),
          panels = AreaLights.attach(engine, { lights });
        disposers.push(() => {
          panels.dispose();
          suns.dispose();
          local.dispose();
          lights.dispose();
        });
        if (kind === 'directional')
          suns.setLights([
            {
              direction: [1, 0, -1],
              intensity: 3,
              castShadow,
              shadow: { bounds: { min: [-2, -1.5, -0.5], max: [2, 1.5, 1.5] } },
            },
          ]);
        else
          panels.setLights([
            { position: [-2, 0, 2], direction: [1, 0, -1], width: 0.1, height: 0.1, intensity: 40, castShadow },
          ]);
        mesh(new UnlitMaterial({ color: [1, 1, 1] }), quad([0, 0, 1], -2, 2, -1.5, 1.5, -0.5));
        const caster = mesh(new UnlitMaterial({ color: [0.2, 0.2, 0.2] }), quad([0, 0, 1], -1.6, -1, -0.5, 0.5, 1));
        disposers.push(local.add(caster));
        const catcher = mesh(new ShadowCatcherMaterial(), quad([0, 0, 1], -2, 2, -1.5, 1.5, 0));
        disposers.push(lights.add(catcher));
        const img = await read();
        out[kind + (castShadow ? 'Shadow' : 'Open')] = {
          shadow: box(img, kind === 'directional' ? -0.45 : -0.35, kind === 'directional' ? -0.15 : -0.05, -0.2, 0.2),
          lit: box(img, 0.8, 1.4, -0.2, 0.2),
        };
        clear();
      }
    return out;
  },
};
const matMoreFixture = {
  errors,
  async run(name: string) {
    const result = await scenarios[name]();
    return { result, errors: errors.splice(0) };
  },
  dispose() {
    clear();
    engine.dispose();
  },
};
Object.assign(window, { matMoreFixture });
