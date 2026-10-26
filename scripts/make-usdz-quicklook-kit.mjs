// Makes the six small textured USDZ files for the Apple Quick Look check in docs/known-bugs.md ("USDZ export with
// textures: never opened in Quick Look"). Each file is a lit sphere (a UV sphere written by this script) with textures
// drawn in code, so nothing is downloaded and the files are tiny:
//   01-alpha-mask.usdz         base colour with an alpha mask (alphaMode MASK, opacityThreshold 0.5)
//   02-alpha-blend.usdz        base colour with blended alpha (alphaMode BLEND)
//   03-metal-rough-normal-1.usdz  metal-rough map (g = roughness, b = metalness) plus a normal map, normalScale 1
//   04-metal-rough-normal-2.usdz  the same textures at normalScale 2
//   05-occlusion-emissive.usdz occlusion map (red channel) plus emissive map
//   06-texture-transform.usdz  base colour with a texture transform (offset, scale), repeat across u and mirror across v
// Usage (after `npm run build:packages`):
//   node scripts/make-usdz-quicklook-kit.mjs [outDir] [--glb]
// `outDir` defaults to ./usdz-quicklook-kit. `--glb` also writes the same six scenes as .glb files, which the engine
// loads (with @margoengine/gltf-pro) to draw reference screenshots to compare with Quick Look. Open the .usdz files on
// an iPhone, iPad or Mac (iOS 17 / macOS 14 or later) and compare them with the references. Optional independent
// check with OpenUSD, which you install yourself: pip install usd-core, then
// python packages/exporters/tests/validate-usdz.py <file>.
// Rotation is not part of the exporter's texture transform data (offset and scale only), so file 06 has none.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportUSDZ } from '../packages/exporters/dist/usdz.js';
import { exportGLB } from '../packages/exporters/dist/index.js';
import { encodePNG } from '../packages/exporters/dist/capture.js';

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const hex = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

/** A PNG drawn by `paint(x, y, u, v)`, which returns [r, g, b, a] in 0..255; u and v run 0..1 from the top left. */
async function texture(name, width, height, paint) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = paint(x, y, (x + 0.5) / width, (y + 0.5) / height);
      data.set([r, g, b, a], (y * width + x) * 4);
    }
  return { image: await encodePNG({ data, width, height }), mimeType: 'image/png', name };
}

/** A UV sphere of radius 0.5 with glTF uvs (v down). u = 0.5 faces the viewer, u grows to the right, v = 0 is the top. */
export function sphere(segments = 64, rings = 32) {
  const count = (segments + 1) * (rings + 1);
  const positions = new Float32Array(count * 3),
    normals = new Float32Array(count * 3),
    uvs = new Float32Array(count * 2),
    indices = new Uint32Array(segments * (rings - 1) * 6);
  for (let j = 0; j <= rings; j++)
    for (let i = 0; i <= segments; i++) {
      const v = j / rings,
        u = i / segments,
        theta = Math.PI * v,
        phi = 2 * Math.PI * u + Math.PI / 2,
        n = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), -Math.sin(theta) * Math.sin(phi)],
        at = j * (segments + 1) + i;
      positions.set(
        n.map((c) => c * 0.5),
        at * 3,
      );
      normals.set(n, at * 3);
      uvs.set([u, v], at * 2);
    }
  let k = 0;
  for (let j = 0; j < rings; j++)
    for (let i = 0; i < segments; i++) {
      const a = j * (segments + 1) + i,
        b = a + segments + 1,
        c = a + 1,
        d = b + 1;
      if (j > 0) indices.set([a, b, c], (k += 3) - 3); // the top row's first triangle is a point
      if (j < rings - 1) indices.set([c, b, d], (k += 3) - 3); // and so is the bottom row's second
    }
  return { positions, normals, uvs, indices };
}

/** A flat quad in the XY plane, `x0..x1` by `y0..y1`, at depth `z`, facing +z. */
const quad = (x0, x1, y0, y1, z) => ({
  positions: new Float32Array([x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
});

/** Two plain panels behind the sphere, so see-through parts of a texture show a known blue and orange. */
const backdrop = () => [
  {
    name: 'Backdrop blue',
    geometry: quad(-0.9, 0, -0.7, 0.7, -0.6),
    material: { color: [0.02, 0.1, 0.5, 1], roughness: 1 },
  },
  {
    name: 'Backdrop orange',
    geometry: quad(0, 0.9, -0.7, 0.7, -0.6),
    material: { color: [0.8, 0.25, 0.01, 1], roughness: 1 },
  },
];

/** A dome-bump normal map (tangent space, +x right, +y up): a grid of round bumps on a flat field. */
const bumps = (name) =>
  texture(name, 512, 256, (x, y) => {
    const cell = 32,
      dx = ((x % cell) + 0.5 - cell / 2) / (cell * 0.4),
      dy = ((y % cell) + 0.5 - cell / 2) / (cell * 0.4),
      d = Math.hypot(dx, dy);
    const [nx, ny] = d < 1 ? [dx * 0.8, -dy * 0.8] : [0, 0],
      nz = Math.sqrt(1 - nx * nx - ny * ny);
    return [(nx * 0.5 + 0.5) * 255, (ny * 0.5 + 0.5) * 255, (nz * 0.5 + 0.5) * 255, 255];
  });

/** Metal-rough map: g = roughness grows left to right in eight steps per half turn, b = metalness in alternate rows. */
const metalRough = () =>
  texture('metal-rough', 512, 256, (x, y, u, v) => {
    const column = Math.floor(u * 16) % 8,
      row = Math.floor(v * 4);
    return [255, (0.08 + 0.92 * (column / 7)) * 255, row % 2 === 0 ? 255 : 0, 255];
  });

/** The six scenes: file name, what to look for, and the `exportUSDZ` / `exportGLB` input. */
export async function scenes() {
  const ball = sphere();
  const sphereNode = (material) => ({ name: 'Sphere', geometry: ball, material });
  const checker = (u, v, cells, a, b) => ((Math.floor(u * cells) + Math.floor(v * cells)) % 2 === 0 ? a : b);
  const alphaMask = await texture('alpha-mask', 512, 256, (x, y, u, v) => {
    const cu = ((u * 8) % 1) - 0.5,
      cv = ((v * 4) % 1) - 0.5,
      dot = Math.hypot(cu, cv); // 64 by 64 pixel cells, so the discs are round
    return [...checker(u, v, 8, hex(0xff8c1a), hex(0x1ab0b0)), (1 - smooth(0.25, 0.5, dot)) * 255];
  });
  const alphaBlend = await texture('alpha-blend', 512, 256, (x, y, u, v) => {
    const row = Math.floor(v * 8) % 2,
      step = Math.floor(u * 16) % 8;
    return [...(row ? hex(0xe0143c) : hex(0xf5d000)), (0.15 + 0.85 * (step / 7)) * 255];
  });
  const occlusion = await texture('occlusion', 512, 256, (x, y) => {
    const line = x % 64 < 6 || y % 64 < 6 ? 30 : 255;
    return [line, line, line, 255];
  });
  const emissive = await texture('emissive', 512, 256, (x, y, u, v) => {
    if (v < 0.4 || v > 0.6) return [0, 0, 0, 255];
    return [...(Math.floor(u * 32) % 2 ? hex(0x00ffe0) : hex(0xff20c0)), 255];
  });
  const orientation = await texture('orientation', 256, 256, (x, y, u, v) => {
    const inside = (x0, y0, x1, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;
    if (inside(0, 0, 56, 56)) return hex(0xe02020);
    if (inside(200, 0, 256, 56)) return hex(0x20b020);
    if (inside(0, 200, 56, 256)) return hex(0x2040e0);
    if (inside(200, 200, 256, 256)) return hex(0xf0d020);
    if (inside(96, 56, 128, 200) || inside(96, 56, 184, 84) || inside(96, 118, 160, 146)) return hex(0xffffff);
    return checker(u, v, 8, hex(0x3a4a6a), hex(0x6a7a9a));
  });
  const mr = await metalRough();
  const normal = await bumps('normal');
  const lit = {
    color: [0.85, 0.85, 0.85, 1],
    roughness: 1,
    metalness: 1,
    metallicRoughnessTexture: mr,
    normalTexture: normal,
  };
  const entry = (file, title, look, nodes) => ({ file, title, look, scene: { nodes } });
  return [
    entry('01-alpha-mask', 'Alpha mask', 'orange and teal checks with round holes, hard edges', [
      sphereNode({
        color: [1, 1, 1, 1],
        roughness: 0.6,
        baseColorTexture: alphaMask,
        alphaMode: 'MASK',
        alphaCutoff: 0.5,
      }),
      ...backdrop(),
    ]),
    entry('02-alpha-blend', 'Alpha blend', 'red and yellow rows fading in steps', [
      sphereNode({ color: [1, 1, 1, 1], roughness: 0.6, baseColorTexture: alphaBlend, alphaMode: 'BLEND' }),
      ...backdrop(),
    ]),
    entry('03-metal-rough-normal-1', 'Metal-rough and normal, scale 1', 'bumps on metal and matt rows', [
      sphereNode({ ...lit, normalScale: 1 }),
    ]),
    entry('04-metal-rough-normal-2', 'Metal-rough and normal, scale 2', 'the same bumps, twice as strong', [
      sphereNode({ ...lit, normalScale: 2 }),
    ]),
    entry('05-occlusion-emissive', 'Occlusion and emissive', 'dark grid lines and a glowing belt', [
      sphereNode({
        color: [0.9, 0.9, 0.9, 1],
        roughness: 0.6,
        metalness: 0,
        occlusionTexture: occlusion,
        occlusionStrength: 1,
        emissive: [1, 1, 1],
        emissiveTexture: emissive,
      }),
    ]),
    entry(
      '06-texture-transform',
      'Texture transform',
      'square tiles, four around the middle, the lower ones flipped upside down',
      [
        sphereNode({
          color: [1, 1, 1, 1],
          roughness: 0.7,
          metalness: 0,
          baseColorTexture: { ...orientation, wrapS: 'repeat', wrapT: 'mirror' },
          baseColorTextureTransform: { offset: [0.5, 0.1], scale: [4, 2] },
        }),
      ],
    ),
  ];
}

/** Writes the six `.usdz` files (and `.glb` twins with `glb: true`) into `outDir`; returns the file paths. */
export async function writeKit(outDir, { glb = false } = {}) {
  await mkdir(outDir, { recursive: true });
  const written = [];
  for (const { file, scene } of await scenes()) {
    const write = async (extension, bytes) => {
      const path = resolve(outDir, `${file}.${extension}`);
      await writeFile(path, bytes);
      written.push(path);
    };
    await write('usdz', exportUSDZ(scene));
    if (glb) await write('glb', exportGLB(scene));
  }
  return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2),
    dir = args.find((a) => !a.startsWith('--')) ?? 'usdz-quicklook-kit';
  for (const path of await writeKit(resolve(dir), { glb: args.includes('--glb') })) console.log(path);
}
