// Bug (docs/known-bugs.md, "DOF near field: stepped blocks along a bright surface far in front of focus"): the near
// gather read 64 single pixels spread over the whole maxRadius disk, about 7 px apart at maxRadius 32, so a sharp edge
// on a wide near-field surface came out blurred through a sparse kernel: its outline moved in steps from row to row,
// and where the surface met the background the steps showed as blocks. The near gather now reads a premultiplied mip
// chain of the near field at the level whose footprint matches the tap spacing (src/shaders.ts, nearShader).
// Here one frame of DOF's own compute kernels, as it records them on the stand-in device, runs on the WebGL2 layer's
// CPU tier (its texture reads and writes rewritten as storage arrays, sampling as trilinear clamp-to-edge) over a bright
// plane that recedes from the camera with a slanted edge on it, wholly in front of the focus. The blurred edge's
// position per row must change smoothly: its largest second difference over the rows stays within 2 px (the shipped
// gather gave 7; 4,096 taps instead of 64 give 1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DOF } from '../dist/index.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';
import { runComputeOnCPU } from '../../webgl2-compat/dist/compute.js';

const SIZE = 256,
  NEAR = 0.1,
  FAR = 1000,
  FOCUS = 40,
  SCALE = 8,
  MAX = 32;

/** View depth and colour of the scene: a plane from 6 (top) to 30 (bottom) units, the background at 400 above it. */
function scene() {
  const depth = new Float32Array(SIZE * SIZE * 4),
    color = new Float32Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4,
        t = (SIZE - 1 - y) / (SIZE - 1),
        z = y < 20 ? 400 : 6 + 24 * (1 - t) ** 2,
        bright = y >= 20 && x < 100 + y * 0.3 ? 1 : y < 20 ? 0 : 0.02;
      depth[i] = (NEAR * FAR) / z / (FAR - NEAR) - NEAR / (FAR - NEAR); // reversed-Z
      color.fill(bright, i, i + 3);
      color[i + 3] = 1;
    }
  return { depth, color };
}

/** Top-level arguments of the call that opens at `open` (the index of its '('). */
function args(code, open) {
  const out = [];
  let depth = 0,
    start = open + 1;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return { list: [...out, code.slice(start, i)], end: i + 1 };
    else if (c === ',' && depth === 1) {
      out.push(code.slice(start, i));
      start = i + 1;
    }
  }
  throw new Error('unbalanced call');
}
function rewriteCalls(code, name, to) {
  let at;
  while ((at = code.indexOf(`${name}(`)) >= 0) {
    const { list, end } = args(code, at + name.length);
    code = code.slice(0, at) + to(list.map((a) => a.trim())) + code.slice(end);
  }
  return code;
}

/** WGSL that picks one of `list` by the u32 `k` (the last entry for k past the list). */
const pick = (list, k) =>
  list.reduceRight((rest, v, i) => (i === list.length - 1 ? v : `select(${rest},${v},${k}==${i}u)`), '');

/**
 * The level fraction a sampler blends two mip levels by: the WebGL2 layer's full float fraction, or the fraction snapped
 * to 8 bits by rounding (native WebGPU on the Radeon 680M: 1,001 explicit levels from 0 to 1, every blend weight the
 * nearest 1/256) or by truncating (another implementation of the same precision), or snapped to 4 bits, Vulkan's least
 * mipmapPrecisionBits.
 */
const FRACTION = {
  float: 'l-floor(l)',
  round: 'round((l-floor(l))*256.0)/256.0',
  truncate: 'floor((l-floor(l))*256.0)/256.0',
  coarse: 'floor((l-floor(l))*16.0)/16.0',
};

/**
 * The kernel with every texture as a storage array of vec4f and its calls as helpers over that array. A mip chain
 * (`sizes` lists [width, height, offset] per level) holds its levels one after another and samples trilinearly, the
 * two levels blended by `fraction` (a FRACTION key).
 */
function cpuCode(code, sizes, fraction = 'float') {
  const textures = new Map(),
    helpers = [];
  code = code.replace(
    /@group\(0\) @binding\((\d+)\) var (\w+):(texture_2d<f32>|texture_depth_2d|texture_storage_2d<\w+,write>|sampler);/g,
    (_, binding, name, type) => {
      if (type === 'sampler') return '';
      const levels = sizes.get(+binding),
        [w, h] = levels[0],
        last = levels.length - 1;
      textures.set(name, type);
      helpers.push(`const ${name}_size=vec2u(${w}u,${h}u);
fn ${name}_dims(k:u32)->vec2u {return ${pick(
        levels.map(([x, y]) => `vec2u(${x}u,${y}u)`),
        'k',
      )};}
fn ${name}_at(p:vec2i,k:u32)->vec4f {let d=${name}_dims(k);let q=clamp(p,vec2i(0),vec2i(d)-1);
  return ${name}[${pick(
    levels.map(([, , o]) => `${o}u`),
    'k',
  )}+u32(q.y)*d.x+u32(q.x)];}
fn ${name}_ld(p:vec2i)->vec4f {return ${name}_at(p,0u);}
fn ${name}_st(p:vec2i,v:vec4f) {${name}[u32(p.y)*${w}u+u32(p.x)]=v;}
fn ${name}_bil(uv:vec2f,k:u32)->vec4f {let g=uv*vec2f(${name}_dims(k))-0.5;let q=vec2i(floor(g));let f=g-floor(g);
  return mix(mix(${name}_at(q,k),${name}_at(q+vec2i(1,0),k),f.x),mix(${name}_at(q+vec2i(0,1),k),${name}_at(q+vec2i(1,1),k),f.x),f.y);}
fn ${name}_smp(uv:vec2f,lod:f32)->vec4f {let l=clamp(lod,0.0,${last}.0);let a=u32(floor(l));
  return mix(${name}_bil(uv,a),${name}_bil(uv,min(a+1u,${last}u)),${FRACTION[fraction]});}`);
      return `@group(0) @binding(${binding}) var<storage,read_write> ${name}:array<vec4f>;`;
    },
  );
  code = rewriteCalls(code, 'textureLoad', ([t, p]) =>
    textures.get(t) === 'texture_depth_2d' ? `${t}_ld(vec2i(${p})).x` : `${t}_ld(vec2i(${p}))`,
  );
  code = rewriteCalls(code, 'textureStore', ([t, p, v]) => `${t}_st(vec2i(${p}),vec4f(${v}))`);
  code = rewriteCalls(code, 'textureDimensions', ([t]) => `${t}_size`);
  code = rewriteCalls(code, 'textureSampleLevel', ([t, , uv, lod]) => `${t}_smp(${uv},f32(${lod}))`);
  assert.doesNotMatch(code, /texture\w*</);
  return `${helpers.join('\n')}\n${code}`;
}

/** View depth and colour of a 2x2 bright spot at view depth `z` in the middle, the dark background at 400. */
function spot(z) {
  const depth = new Float32Array(SIZE * SIZE * 4),
    color = new Float32Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4,
        on = (x === 127 || x === 128) && (y === 127 || y === 128),
        d = on ? z : 400;
      depth[i] = (NEAR * FAR) / d / (FAR - NEAR) - NEAR / (FAR - NEAR);
      color.fill(on ? 20 : 0, i, i + 3);
      color[i + 3] = 1;
    }
  return { depth, color };
}

/**
 * One frame of DOF's compute passes on the CPU tier over `picture`, its trilinear samples blending levels by `fraction`;
 * returns the gather's output (rgba per pixel).
 */
function frame(options, picture = scene(), fraction = 'float') {
  const h = gpuHarness(),
    { depth, color } = picture,
    stores = new Map(),
    uniform = new Float32Array([FOCUS, 0.05, 2.8, MAX, NEAR, FAR, SCALE, 1, 0, 0, 0, 0]);
  h.context.width = h.context.height = SIZE;
  // One array per texture and mip level; a view of several levels reads them one after another (a copy: the kernels
  // only write single levels).
  const level = (texture, k) => [Math.max(1, texture.width >> k), Math.max(1, texture.height >> k)];
  const store = (texture, name, k) => {
    if (!stores.has(texture)) stores.set(texture, []);
    const levels = stores.get(texture);
    if (!levels[k]) {
      const [w, h] = level(texture, k);
      levels[k] = name === 'depth' ? depth.slice() : name === 'scene' ? color.slice() : new Float32Array(w * h * 4);
    }
    return levels[k];
  };
  let result;
  h.context.encoder.beginComputePass = () => {
    let pipeline, group;
    return {
      setPipeline: (p) => (pipeline = p),
      setBindGroup: (_index, g) => (group = g),
      dispatchWorkgroups(x, y = 1) {
        const code = pipeline.compute.module.code,
          names = new Map([...code.matchAll(/@binding\((\d+)\) var(?:<\w+>)? (\w+):/g)].map((m) => [+m[1], m[2]])),
          sizes = new Map(),
          buffers = new Map();
        for (const { binding, resource } of group.entries) {
          if (resource.buffer) buffers.set(`0:${binding}`, new Uint8Array(uniform.buffer));
          else if (resource.texture) {
            const base = resource.baseMipLevel ?? 0,
              n = resource.mipLevelCount ?? (resource.texture.mipLevelCount ?? 1) - base,
              list = [];
            let offset = 0;
            for (let k = base; k < base + n; k++) {
              const [w, h] = level(resource.texture, k);
              list.push({ level: store(resource.texture, names.get(binding), k), size: [w, h, offset] });
              offset += w * h;
            }
            const data = n === 1 ? list[0].level : new Float32Array(offset * 4);
            if (n > 1) for (const { level: l, size } of list) data.set(l, size[2] * 4);
            sizes.set(
              binding,
              list.map(({ size }) => size),
            );
            buffers.set(`0:${binding}`, new Uint8Array(data.buffer));
            if (names.get(binding) === 'result') result = data;
          }
        }
        runComputeOnCPU({ source: cpuCode(code, sizes, fraction), workgroups: [x, y], buffers });
      },
      end() {},
    };
  };
  DOF.attach(h.engine, { focalDistance: FOCUS, maxRadius: MAX, ...options });
  h.frame();
  assert.ok(result, 'the gather ran');
  return result;
}

/** The blurred edge per row: the first column from the left where red falls below half way; its second differences. */
function steps(image) {
  const edges = [];
  for (let y = 24; y < SIZE - 4; y++) {
    let e = -1;
    for (let x = 20; x < SIZE - 1; x++)
      if (image[(y * SIZE + x) * 4] < 0.51 && image[(y * SIZE + x - 1) * 4] >= 0.51) {
        e = x;
        break;
      }
    edges.push(e);
  }
  let max = 0;
  for (let k = 2; k < edges.length; k++) max = Math.max(max, Math.abs(edges[k] - 2 * edges[k - 1] + edges[k - 2]));
  return { max, found: edges.every((e) => e > 0) };
}

test('a sharp edge on a wide near-field surface blurs into a smooth outline, not steps', () => {
  const s = steps(frame());
  console.log('near edge, largest second difference per row', s.max);
  assert.ok(s.found, 'every row has an edge');
  assert.ok(s.max <= 2, `the blurred edge moves in steps of up to ${s.max} px from row to row`);
});

test('the lens variants of the near gather run on the same kernels and stay smooth', async () => {
  const { DOFLens } = await import('../dist/lens.js');
  for (const lens of [
    new DOFLens({ blades: 6 }),
    new DOFLens({ anamorphic: 2, catEye: 1 }),
    new DOFLens({ blades: 5, anamorphic: 1.5 }),
  ]) {
    const s = steps(frame({ lens }));
    console.log('near edge through a lens, largest second difference per row', s.max);
    assert.ok(s.found && s.max <= 3, `through ${JSON.stringify(lens)} the blurred edge steps by ${s.max} px`);
  }
});

// Bug (same known-bugs entry): a small near disk got only the few of the 64 taps that fell inside it, spread over the
// whole maxRadius disk, so a bright spot blurred 6 px in the near field came out as three dots (the taps' replicas of it) where
// a lens draws a round disk. The taps now spread over the largest near disk that reaches the 8x8 tile. A 2x2 spot whose
// near radius is 6 px, maxRadius 32: every pixel within 4 px of its middle is lit, and the disk is round, as wide as
// tall within 1 px and 13 to 16 px across (the spot and a 6 px blur each way make 14; the shipped gather left 44
// pixels within 4 px of the middle dark).
test('a small near disk keeps its round shape when maxRadius is much larger', () => {
  const image = frame({}, spot(FOCUS / 1.75)),
    lit = (x, y) => image[(y * SIZE + x) * 4] > 0.02;
  let left = SIZE,
    right = -1,
    top = SIZE,
    bottom = -1,
    holes = 0;
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      if (Math.hypot(x - 127.5, y - 127.5) <= 4 && !lit(x, y)) holes++;
      if (!lit(x, y)) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  const width = right - left + 1,
    height = bottom - top + 1;
  console.log('small near disk', JSON.stringify({ width, height, holes }));
  assert.equal(holes, 0, 'the disk is filled around its middle');
  assert.ok(Math.abs(width - height) <= 1 && width >= 13 && width <= 16, `a round disk, got ${width} x ${height}`);
});

// Bug (compat-check.mjs, 'a one-sample capture blurs the same'): the near gather sampled its mip chain at the level
// log2(spacing / sqrt(3)) as computed, a fraction between two levels. A sampler blends the two levels by that fraction
// snapped to its own mipmap precision, which WebGPU leaves to the implementation: native WebGPU on the Radeon 680M
// rounds it to 8 bits, the WebGL2 layer blends by the full float fraction, so 7 pixels of the one-sample 'focus' case
// differed by one 8-bit level between the two. Rounding the level to 1/256 matched the Radeon 680M, but the RTX A6000's
// sampler still blended such a level apart from the layer (the same case, mean 0.00053), and a sampler with fewer bits
// would too: the blend's precision and arithmetic are the sampler's own. The gather now reads the two whole levels and
// blends them itself. Over the receding floor (every near radius from 0 to maxRadius) its output must be the same
// floats whichever way the sampler treats the fraction, 4 bits included (the 1/256 rounding: 92,088 values differed).
test('the near gather draws the same however a sampler blends two mip levels', () => {
  const picture = scene(),
    exact = frame({}, picture, 'float');
  for (const fraction of ['round', 'truncate', 'coarse']) {
    const snapped = frame({}, picture, fraction);
    let differ = 0,
      worst = 0;
    for (let i = 0; i < exact.length; i++)
      if (exact[i] !== snapped[i]) {
        differ++;
        worst = Math.max(worst, Math.abs(exact[i] - snapped[i]));
      }
    console.log(`near gather, float against ${fraction} level fraction`, JSON.stringify({ differ, worst }));
    assert.equal(differ, 0, `${differ} values differ when the sampler ${fraction}s the level fraction (worst ${worst})`);
  }
});
