// The parity scenes: one benchmark per row of docs/threejs-parity.md that three.js also has, each the same job in every
// engine (same data, settings, resolution and output). `npm run bench -- parity --engines=margo,three-webgpu,three-webgl`
// runs them; `node bench/parity-report.mjs` turns the run into docs/whitepaper/perf-vs-threejs.md. Each scene names
// the parity rows it measures (`rows`, section.row as numbered in the matrix) and is either a frame scene (the shared
// frame harness) or a task scene (`kind: 'task'`: one job timed per call, harness.js runTask). Scenes are plain data
// like the rest of the catalog, so an engine builds them without importing anything from Margo. ROWS maps every matrix
// row to its scenes, or says why it has none.
// catalog.js passes its helpers in (parityScenes), so the two modules have no import cycle.
import { benchFont } from './parity-font.js';

/**
 * The parity scenes, built from the catalog helpers (boxes, yard, orbit, random, PALETTE). Frame scenes keep the frame
 * harness's camera path, canvas and MSAA; every value an engine needs is in `data`. Settings are written once here and
 * both engines map them to their own names (the adapter notes how).
 */
export function parityScenes({ PALETTE, boxes, orbit, random, yard }) {
  const fixture = (pkg, name) => `/packages/${pkg}/tests/fixtures/${name}`;

  /** n boxes on the yard floor (catalog `yard`): the base of the material, light, effect and helper scenes. */
  const base = (n = 1000) => yard(n);

  /** A side x side grid on y = sin(x)/20 as indexed triangles: the shared mesh of the format and geometry tasks. */
  function grid(side) {
    const positions = [],
      indices = [];
    for (let y = 0; y <= side; y++)
      for (let x = 0; x <= side; x++) positions.push(x / side, Math.sin(x * 0.1) * 0.05, y / side);
    for (let y = 0; y < side; y++)
      for (let x = 0; x < side; x++) {
        const a = y * (side + 1) + x,
          c = a + side + 1;
        indices.push(a, c, a + 1, a + 1, c, c + 1);
      }
    return { positions, indices };
  }
  const objText = (g) =>
    [
      ...Array.from({ length: g.positions.length / 3 }, (_, i) => `v ${g.positions.slice(i * 3, i * 3 + 3).join(' ')}`),
      ...Array.from(
        { length: g.indices.length / 3 },
        (_, i) =>
          `f ${g.indices
            .slice(i * 3, i * 3 + 3)
            .map((k) => k + 1)
            .join(' ')}`,
      ),
    ].join('\n');
  /** Binary STL of a grid (little-endian, zero normals as most writers leave them for the reader to compute). */
  function stlBytes(g) {
    const t = g.indices.length / 3,
      out = new DataView(new ArrayBuffer(84 + t * 50));
    out.setUint32(80, t, true);
    for (let i = 0; i < t; i++)
      for (let k = 0; k < 3; k++)
        for (let c = 0; c < 3; c++)
          out.setFloat32(84 + i * 50 + 12 + k * 12 + c * 4, g.positions[g.indices[i * 3 + k] * 3 + c], true);
    return new Uint8Array(out.buffer);
  }
  /** Binary little-endian PLY (float xyz, uint8 vertex_indices count + int32 indices). */
  function plyBytes(g) {
    const v = g.positions.length / 3,
      f = g.indices.length / 3,
      head = new TextEncoder().encode(
        `ply\nformat binary_little_endian 1.0\nelement vertex ${v}\nproperty float x\nproperty float y\nproperty float z\n` +
          `element face ${f}\nproperty list uchar int vertex_indices\nend_header\n`,
      ),
      out = new DataView(new ArrayBuffer(head.length + v * 12 + f * 13));
    new Uint8Array(out.buffer).set(head);
    let o = head.length;
    for (const x of g.positions) out.setFloat32(o, x, true), (o += 4);
    for (let i = 0; i < f; i++) {
      out.setUint8(o++, 3);
      for (let k = 0; k < 3; k++) out.setInt32(o, g.indices[i * 3 + k], true), (o += 4);
    }
    return new Uint8Array(out.buffer);
  }
  /** An SVG of n filled paths: rounded stars with quadratic and cubic curves, n distinct colours. */
  function svgText(n) {
    const pick = random(13),
      paths = [];
    for (let i = 0; i < n; i++) {
      const cx = pick() * 1000,
        cy = pick() * 1000,
        r = 10 + pick() * 40;
      let d = `M${cx + r} ${cy}`;
      for (let k = 1; k <= 10; k++) {
        const a = (k / 10) * Math.PI * 2,
          rr = k % 2 ? r * 0.5 : r;
        d += ` Q${cx + rr * 1.2 * Math.cos(a - 0.3)} ${cy + rr * 1.2 * Math.sin(a - 0.3)} ${cx + rr * Math.cos(a)} ${cy + rr * Math.sin(a)}`;
      }
      d += ` C${cx + r} ${cy + r} ${cx - r} ${cy + r} ${cx + r} ${cy}Z`;
      paths.push(`<path fill="${PALETTE[i % 16]}" d="${d}"/>`);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">${paths.join('')}</svg>`;
  }
  /** A 33^3 .cube LUT: a mild warm grade (r up, b down). */
  function cubeLUT(size = 33) {
    const lines = ['TITLE "warm"', `LUT_3D_SIZE ${size}`];
    for (let b = 0; b < size; b++)
      for (let g = 0; g < size; g++)
        for (let r = 0; r < size; r++) {
          const x = [r, g, b].map((v) => v / (size - 1));
          lines.push([Math.min(1, x[0] * 1.05), x[1], x[2] * 0.95].map((v) => v.toFixed(6)).join(' '));
        }
    return lines.join('\n');
  }
  /** An IESNA LM-63-2002 photometric file: a 0-90 degree cosine-squared beam, 37 vertical x 1 horizontal angles. */
  function iesText() {
    const vertical = Array.from({ length: 37 }, (_, i) => i * 2.5),
      candela = vertical.map((a) => (1000 * Math.cos((a * Math.PI) / 180) ** 2).toFixed(2));
    return [
      'IESNA:LM-63-2002',
      '[TEST] margo bench beam',
      'TILT=NONE',
      `1 1000 1 ${vertical.length} 1 1 2 0 0 0`,
      '1 1 100',
      vertical.join(' '),
      '0',
      candela.join(' '),
    ].join('\n');
  }

  const yardEffect = (effect) => ({ ...base(1000), effect });
  const loader = (url, extra = {}) => ({ url, ...extra });

  return {
    // 1. Core objects and scene graph
    'p-hierarchy': {
      area: 'core',
      rows: ['1.1', '1.2'],
      title: 'Hierarchy',
      draws:
        '50 groups of 100 boxes (5,000 boxes, each a child of its group, groups children of one root); every frame each group turns about y by t * 0.5 rad and the root by t * 0.1, so every world matrix changes.',
      params: {},
      data: () => {
        const d = boxes(5000);
        d.groups = Array.from({ length: 50 }, (_, g) => ({
          position: [((g % 10) - 4.5) * 4, 0, (Math.floor(g / 10) - 2) * 4],
        }));
        d.items.forEach((item, i) => {
          item.group = i % 50;
          item.position = [((i / 50) % 10) * 0.35 - 1.6, Math.floor(i / 500) * 0.35, 0];
        });
        d.camera = orbit(30, 14, 400);
        return d;
      },
    },
    'p-scenes': {
      area: 'core',
      rows: ['1.3'],
      title: 'Two scenes',
      draws:
        'Two scenes of 2,000 boxes each (catalog boxes, the second shifted 30 m in x); each frame draws scene A to the left half of the canvas and scene B to the right half, each through its own camera.',
      params: {},
      data: () => ({ a: boxes(2000), b: boxes(2000), offset: [30, 0, 0] }),
    },
    'p-background': {
      area: 'core',
      rows: ['1.4', '6.2'],
      title: 'Cube-map background',
      draws:
        '1,000 yard boxes in front of a cube-map background built from six 512 x 512 RGBA8 faces (data.faces, generated, order +x -x +y -y +z -z).',
      params: {},
      data: () => {
        const faces = Array.from({ length: 6 }, (_, f) => {
          const size = 512,
            px = new Uint8Array(size * size * 4);
          for (let y = 0; y < size; y++)
            for (let x = 0; x < size; x++) {
              const o = (y * size + x) * 4,
                c = ((x >> 6) + (y >> 6)) % 2;
              px.set([40 + f * 30, 80 + c * 60, 160 - f * 15, 255], o);
            }
          return { width: size, height: size, data: px };
        });
        return { ...base(1000), faces };
      },
    },
    'p-alpha': {
      area: 'core',
      rows: ['1.5'],
      title: 'Transparent canvas',
      draws:
        '1,000 yard boxes on a transparent canvas (alpha: premultiplied, clear alpha 0) over a CSS gradient page background.',
      params: {},
      data: () => base(1000),
    },
    'p-culling': {
      area: 'core',
      rows: ['1.6'],
      title: 'Frustum culling',
      draws:
        '50,000 boxes on a 224 x 224 floor grid; the camera (fov 45) looks along +x from the corner so about 8% of the boxes are in the frustum. Per-object culling is the job.',
      params: {},
      data: () => {
        const side = 224,
          items = [];
        for (let i = 0; i < 50_000; i++)
          items.push({
            position: [(i % side) * 1.5, 0.25, Math.floor(i / side) * 1.5],
            rotation: [0, 0, 0],
            color: i % 16,
          });
        return {
          items,
          size: 0.5,
          material: { roughness: 0.5, metalness: 0.1 },
          camera: { fov: 45, near: 0.1, far: 500, target: [60, 0, 20], at: (t) => [-5, 6 + Math.sin(t) * 0.5, 15] },
        };
      },
    },
    'p-layers': {
      area: 'core',
      rows: ['1.8'],
      title: 'Layers',
      draws:
        '10,000 catalog boxes, the even ones on layer 1 and the odd ones on layer 2; the camera sees layer 1 only, so half are drawn.',
      params: {},
      data: () => {
        const d = boxes(10_000);
        d.items.forEach((item, i) => (item.layer = i % 2 ? 2 : 1));
        d.cameraLayer = 1;
        return d;
      },
    },
    'p-math': {
      area: 'core',
      kind: 'task',
      rows: ['1.9'],
      title: 'Math library',
      draws:
        'One call: 100,000 Matrix4 compose(position, quaternion from Euler XYZ, scale) then multiply with a parent; 100,000 Vector3 applyMatrix4 + normalize; 100,000 Box3 tests against one camera Frustum (from a 45 degree projection times view); 100,000 Ray-Sphere intersections. Inputs in data (Float32Array streams).',
      params: {},
      data: () => {
        const pick = random(17),
          n = 100_000,
          f = (k) => Float32Array.from({ length: n * k }, () => pick() * 20 - 10);
        return { n, positions: f(3), eulers: f(3), points: f(3), rays: f(6) };
      },
    },

    // 2. Renderer and platform
    'p-webgl2': {
      area: 'renderer',
      rows: ['2.2'],
      title: 'WebGL2 fallback',
      draws: '10,000 catalog boxes through the WebGL2 path (Margo: @margoengine/webgl; three: WebGLRenderer).',
      params: {},
      data: () => boxes(10_000),
    },
    'p-msaa': {
      area: 'renderer',
      rows: ['2.3'],
      title: 'MSAA',
      draws: '10,000 catalog boxes at samples=1 or samples=4 (one case each).',
      params: { samples: 4 },
      data: () => boxes(10_000),
    },
    'p-depth-range': {
      area: 'renderer',
      rows: ['2.4'],
      title: 'Huge depth range',
      draws:
        '2,000 boxes with sizes and distances from 0.1 m to 100 km on a log spiral, near 0.01, far 1,000,000, through the engine large-depth mode (Margo: reversed-Z, its default; three: reversedDepthBuffer where the backend has it, else logarithmicDepthBuffer).',
      params: {},
      data: () => {
        const items = Array.from({ length: 2000 }, (_, i) => {
          const d = 0.5 * 1.006 ** i,
            a = i * 0.37;
          return {
            position: [Math.cos(a) * d, Math.sin(a * 0.5) * d * 0.2, -d],
            rotation: [0, a, 0],
            color: i % 16,
            size: d * 0.05,
          };
        });
        return {
          items,
          material: { roughness: 0.5, metalness: 0.1 },
          camera: { fov: 45, near: 0.01, far: 1e6, target: [0, 0, -100], at: () => [0, 0.2, 1] },
        };
      },
    },
    'p-custom-shader': {
      area: 'renderer',
      rows: ['2.5'],
      title: 'Custom shader material',
      draws:
        '10,000 catalog boxes with one custom shader material: world-space stripes (fract(dot(worldPos, (3,2,1)) * 2) > 0.5 picks colour A #e0b050 or B #3050a0) times the default light lambert term. Margo: WGSL material; three: ShaderMaterial (GLSL on WebGL2) or a NodeMaterial with the same expression on WebGPU.',
      params: {},
      data: () => ({ ...boxes(10_000), stripes: { a: '#e0b050', b: '#3050a0', axis: [3, 2, 1], scale: 2 } }),
    },
    'p-node-material': {
      area: 'renderer',
      rows: ['2.6'],
      title: 'Node material',
      draws:
        '4,096 catalog boxes with one node-graph material: base colour = mix(#2060c0, #f0a030, smoothstep(0.2, 0.8, sin(worldPos.x * 2 + time) * 0.5 + 0.5)), roughness 0.5, metalness 0; time = t.',
      params: {},
      data: () => ({ ...boxes(4096), mix: { a: '#2060c0', b: '#f0a030', edge0: 0.2, edge1: 0.8, frequency: 2 } }),
    },
    'p-compute': {
      area: 'renderer',
      rows: ['2.7'],
      title: 'Compute particles',
      draws:
        '262,144 particles in a GPU storage buffer, integrated in a compute pass every frame (v += (-p * 0.5) * dt; p += v * dt, dt 1/60), then drawn as 1-pixel points (Margo: @margoengine/compute + points; three: compute node + Points/instanced sprites).',
      params: { n: 262_144 },
      data: (p) => {
        const pick = random(19);
        return {
          n: p.n,
          positions: Float32Array.from({ length: p.n * 3 }, () => pick() * 20 - 10),
          camera: orbit(30, 10, 200),
        };
      },
    },
    'p-render-target': {
      area: 'renderer',
      rows: ['2.8'],
      title: 'Render to texture',
      draws:
        'Every frame: 1,000 yard boxes into a 1024 x 1024 RGBA8 render target (depth, no MSAA), then that texture on a full-screen quad.',
      params: {},
      data: () => ({ ...base(1000), target: 1024 }),
    },
    'p-mrt': {
      area: 'renderer',
      rows: ['2.9'],
      title: 'Multiple render targets',
      draws:
        'Every frame: 1,000 yard boxes into three 1280 x 720 targets at once (colour RGBA8, normal RGBA16F, linear depth R32F), then a quad showing the colour target.',
      params: {},
      data: () => base(1000),
    },
    'p-clipping': {
      area: 'renderer',
      rows: ['2.10'],
      title: 'Clipping planes',
      draws:
        '10,000 catalog boxes clipped by three world planes (x < 2, y < 1, z > -3; normal, constant as in Plane(n, d)): pixels outside are discarded, union mode.',
      params: {},
      data: () => ({
        ...boxes(10_000),
        planes: [
          [-1, 0, 0, 2],
          [0, -1, 0, 1],
          [0, 0, 1, 3],
        ],
      }),
    },

    // 3. Cameras
    'p-ortho': {
      area: 'cameras',
      rows: ['3.2'],
      title: 'Orthographic camera',
      draws:
        '10,000 catalog boxes through an orthographic camera (half height 14 m, aspect of the canvas) on the catalog orbit.',
      params: {},
      data: () => ({ ...boxes(10_000), ortho: { halfHeight: 14 } }),
    },
    'p-cube-camera': {
      area: 'cameras',
      rows: ['3.4'],
      title: 'Dynamic cube map',
      draws:
        'A mirror sphere (r 1.5, metalness 1, roughness 0.05) among 500 yard boxes; every frame a cube camera at its centre renders the boxes into a 256 x 256 cube map that the sphere reflects.',
      params: {},
      data: () => ({ ...base(500), sphere: { radius: 1.5, position: [0, 1.5, 0] }, cubeSize: 256 }),
    },

    // 4. Geometry (tasks)
    'p-primitives': {
      area: 'geometry',
      kind: 'task',
      rows: ['4.1'],
      title: 'Primitive geometry',
      draws:
        'One call builds: 20 spheres 64 x 32, 20 cylinders 64 x 8 segments, 20 tori 64 x 32, 20 capsules (cap 16, radial 32), 20 icosahedra detail 4, 20 boxes 8 x 8 x 8 segments. Output: total vertex and triangle counts.',
      params: {},
      data: () => ({ count: 20 }),
    },
    'p-extrude': {
      area: 'geometry',
      kind: 'task',
      rows: ['4.2'],
      title: 'Shapes, extrude, lathe, tube',
      draws:
        'One call: extrude a 5-point star (outer 1, inner 0.5) with a 1 m depth, bevel 0.1 x 3 segments, 24 curve segments; lathe a 64-point profile 128 segments; a tube along a 3D Catmull-Rom curve through 16 points, 512 x 16 segments, radius 0.1.',
      params: {},
      data: () => {
        const pick = random(23);
        return {
          profile: Array.from({ length: 64 }, (_, i) => [0.3 + 0.2 * Math.sin(i * 0.3), i / 32]),
          path: Array.from({ length: 16 }, () => [pick() * 4 - 2, pick() * 4 - 2, pick() * 4 - 2]),
        };
      },
    },
    'p-edges': {
      area: 'geometry',
      kind: 'task',
      rows: ['4.3'],
      title: 'Edges and wireframe geometry',
      draws:
        'One call on a torus knot (p 2, q 3, 512 tubular x 64 radial segments): the edges geometry at a 30 degree threshold, then the wireframe geometry. Output: segment counts.',
      params: {},
      data: () => ({ knot: { radius: 1, tube: 0.3, tubular: 512, radial: 64, p: 2, q: 3 }, threshold: 30 }),
    },
    'p-attributes': {
      area: 'geometry',
      rows: ['4.4', '5.14'],
      title: 'Custom attributes and vertex colours',
      draws:
        '10,000 catalog boxes from one custom indexed geometry with position, normal, uv, uv1, tangent and per-vertex colour (white to the box colour by height), lit with vertex colours on.',
      params: {},
      data: () => boxes(10_000),
    },
    'p-geometry-utils': {
      area: 'geometry',
      kind: 'task',
      rows: ['4.5'],
      title: 'Geometry utilities',
      draws:
        'One call: merge 1,000 box geometries (each moved to its catalog position) into one, weld the 320 x 320 grid (non-indexed copy) back to indexed vertices, then compute its vertex normals and tangents (with uvs). Output: vertex counts.',
      params: {},
      data: () => ({ boxes: boxes(1000).items.map((b) => b.position), grid: grid(320) }),
    },
    'p-geometry-misc': {
      area: 'geometry',
      kind: 'task',
      rows: ['4.7'],
      title: 'Convex hull, rounded box, parametric',
      draws:
        'One call: the convex hull of 100,000 random points in a ball, a rounded box (1 x 1 x 1, radius 0.1, 8 segments), a parametric surface (Klein bottle, 128 x 128). Output: triangle counts.',
      params: {},
      data: () => {
        const pick = random(29),
          points = [];
        while (points.length < 300_000) {
          const p = [pick() * 2 - 1, pick() * 2 - 1, pick() * 2 - 1];
          if (p[0] ** 2 + p[1] ** 2 + p[2] ** 2 <= 1) points.push(...p);
        }
        return { points: Float32Array.from(points) };
      },
    },

    'p-text': {
      area: 'geometry',
      kind: 'task',
      rows: ['4.6'],
      title: 'TTF font and text geometry',
      draws:
        'One call: parse the generated TrueType font (data.font, bench/scenes/parity-font.js: A-Z and space, quadratic outlines with holes) and build extruded text geometry for data.text (size 1, depth 0.2, 8 curve segments, no bevel). Output: vertex and triangle counts.',
      params: {},
      data: () => ({
        font: benchFont(),
        text: 'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG',
        size: 1,
        depth: 0.2,
        curveSegments: 8,
      }),
    },

    // 5. Materials (frame scenes on the yard, 1,000 boxes unless noted)
    'p-maps': {
      area: 'materials',
      rows: ['5.2', '6.1'],
      title: 'Standard material with maps',
      draws:
        '1,000 yard boxes sharing one standard material with base colour, normal, roughness-metalness, occlusion and emissive maps (1024 x 1024 RGBA8 each, generated in data.maps, mipmapped, linear filtering).',
      params: {},
      data: () => {
        const size = 1024,
          map = (fn) => {
            const px = new Uint8Array(size * size * 4);
            for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) px.set(fn(x, y), (y * size + x) * 4);
            return { width: size, height: size, data: px };
          };
        return {
          ...base(1000),
          maps: {
            color: map((x, y) => (((x >> 5) + (y >> 5)) % 2 ? [200, 180, 150, 255] : [90, 80, 70, 255])),
            normal: map((x, y) => [128 + 60 * Math.sin(x * 0.05), 128 + 60 * Math.sin(y * 0.05), 230, 255]),
            roughnessMetalness: map((x) => [255, 60 + (x >> 3), (x >> 2) & 255, 255]),
            occlusion: map((x, y) => [200 + ((x ^ y) & 55), 0, 0, 255]),
            emissive: map((x, y) => ((x & 127) < 4 || (y & 127) < 4 ? [255, 120, 40, 255] : [0, 0, 0, 255])),
          },
        };
      },
    },
    'p-physical': {
      area: 'materials',
      rows: ['5.3'],
      title: 'Physical material layers',
      draws:
        '400 spheres (r 0.4, 64 x 32) on the yard grid with clearcoat 1 (roughness 0.1), sheen 1 (#ffccaa, roughness 0.5), iridescence 1 (IOR 1.3, thickness 100-400 nm), anisotropy 0.5, specular 1, IOR 1.5.',
      params: {},
      data: () => ({ ...base(400), sphere: { radius: 0.4, widthSegments: 64, heightSegments: 32 } }),
    },
    'p-transmission': {
      area: 'materials',
      rows: ['5.3'],
      title: 'Transmission',
      draws:
        '64 transmissive spheres (transmission 1, roughness 0.1, IOR 1.5, thickness 0.5, attenuation #aaddff at 1 m) in front of 1,000 yard boxes.',
      params: {},
      data: () => ({
        ...base(1000),
        spheres: Array.from({ length: 64 }, (_, i) => [((i % 8) - 3.5) * 2, 1, (Math.floor(i / 8) - 3.5) * 2]),
      }),
    },
    'p-unlit': {
      area: 'materials',
      rows: ['5.4'],
      title: 'Unlit material',
      draws: '10,000 catalog boxes, unlit (basic) material in the box colour.',
      params: {},
      data: () => boxes(10_000),
    },
    'p-lambert': {
      area: 'materials',
      rows: ['5.5'],
      title: 'Lambert material',
      draws: '10,000 catalog boxes, Lambert material in the box colour.',
      params: {},
      data: () => boxes(10_000),
    },
    'p-phong': {
      area: 'materials',
      rows: ['5.5'],
      title: 'Phong material',
      draws: '10,000 catalog boxes, Phong material (specular #111111, shininess 30).',
      params: {},
      data: () => boxes(10_000),
    },
    'p-toon': {
      area: 'materials',
      rows: ['5.6'],
      title: 'Toon material',
      draws: '10,000 catalog boxes, toon material with a 3-step gradient (0.2, 0.6, 1).',
      params: {},
      data: () => ({ ...boxes(10_000), steps: [0.2, 0.6, 1] }),
    },
    'p-matcap': {
      area: 'materials',
      rows: ['5.7'],
      title: 'Matcap material',
      draws: '10,000 catalog boxes, matcap material with a 256 x 256 generated sphere-shading matcap (data.matcap).',
      params: {},
      data: () => {
        const size = 256,
          px = new Uint8Array(size * size * 4);
        for (let y = 0; y < size; y++)
          for (let x = 0; x < size; x++) {
            const u = (x / size) * 2 - 1,
              v = (y / size) * 2 - 1,
              l = Math.max(0, 1 - u * u - v * v) ** 0.5;
            px.set([40 + 200 * l, 60 + 160 * l, 90 + 120 * l, 255], (y * size + x) * 4);
          }
        return { ...boxes(10_000), matcap: { width: size, height: size, data: px } };
      },
    },
    'p-normal-material': {
      area: 'materials',
      rows: ['5.8'],
      title: 'Normal material',
      draws: '10,000 catalog boxes, view-space normal material.',
      params: {},
      data: () => boxes(10_000),
    },
    'p-depth-material': {
      area: 'materials',
      rows: ['5.8'],
      title: 'Depth material',
      draws: '10,000 catalog boxes, depth material (near white, far black between camera near and far).',
      params: {},
      data: () => boxes(10_000),
    },
    'p-shadow-catcher': {
      area: 'materials',
      rows: ['5.9'],
      title: 'Shadow catcher',
      draws: '1,000 yard boxes casting a 2048 shadow onto a shadow-only floor (opacity 0.5) over the clear colour.',
      params: {},
      data: () => ({ ...base(1000), resolution: 2048, opacity: 0.5 }),
    },
    'p-transparency': {
      area: 'materials',
      rows: ['5.12'],
      title: 'Alpha blending',
      draws:
        '2,000 catalog boxes with opacity 0.5, alpha blended, depth write off, sorted back to front by the engine every frame.',
      params: {},
      data: () => ({ ...boxes(2000), opacity: 0.5 }),
    },
    'p-alpha-test': {
      area: 'materials',
      rows: ['5.12'],
      title: 'Alpha test',
      draws:
        '4,096 catalog boxes with a 256 x 256 checker alpha map (alpha 0 or 1 in 32-pixel squares) and alpha test 0.5.',
      params: {},
      data: () => boxes(4096),
    },
    'p-double-sided': {
      area: 'materials',
      rows: ['5.15'],
      title: 'Double-sided',
      draws: '10,000 catalog boxes, double-sided standard material.',
      params: {},
      data: () => boxes(10_000),
    },
    'p-wireframe': {
      area: 'materials',
      rows: ['5.16'],
      title: 'Wireframe',
      draws: '1,000 yard spheres (r 0.3, 32 x 16) with the wireframe material flag (line topology), box colour.',
      params: {},
      data: () => ({ ...base(1000), sphere: { radius: 0.3, widthSegments: 32, heightSegments: 16 } }),
    },
    'p-blending': {
      area: 'materials',
      rows: ['5.17'],
      title: 'Additive blending',
      draws:
        '2,000 camera-facing 1 m quads in the box colours, additive blending, depth test on, depth write off, polygon offset (1, 1).',
      params: {},
      data: () => boxes(2000),
    },

    // 6. Textures
    'p-texture-decode': {
      area: 'textures',
      kind: 'task',
      rows: ['6.1'],
      title: 'Texture load',
      draws:
        'One call: decode the first image of the SciFiHelmet GLB (data.url; a 1024 x 1024 JPEG) and upload it as a mipmapped texture; resolves when the GPU has the mips.',
      params: {},
      data: (p, { assets }) => ({ url: `${assets}scifi-helmet.glb`, image: 0 }),
    },
    'p-data-texture': {
      area: 'textures',
      rows: ['6.3'],
      title: 'Data textures',
      draws:
        'Every frame: rewrite a 512 x 512 RGBA8 data texture (a moving plasma) and upload it, shown on a full-screen quad, plus a 64^3 R8 3D texture sampled along the quad diagonal.',
      params: {},
      data: () => ({ size: 512, volume: 64 }),
    },
    'p-ktx2': {
      area: 'textures',
      kind: 'task',
      rows: ['6.4', '10.7'],
      title: 'KTX2 transcode',
      draws:
        'One call: transcode the Basis UASTC/ETC1S KTX2 file (data.url) to the best GPU format the device has and upload it.',
      params: {},
      data: () => ({ url: fixture('decoders', 'Rib_N.ktx2') }),
    },
    'p-video': {
      area: 'textures',
      rows: ['6.5'],
      title: 'Video texture',
      draws:
        '1,000 yard boxes showing a playing video (data.url: examples/assets/parity-clip.webm, 1280 x 720 VP8, 3 s, looped, muted; generated by bench/scenes/make-clip.mjs) as their base colour map, the texture updated with every new video frame.',
      params: {},
      data: (p, { assets }) => ({ ...base(1000), url: `${assets}parity-clip.webm` }),
    },
    'p-canvas-texture': {
      area: 'textures',
      rows: ['6.6'],
      title: 'Canvas texture',
      draws:
        'Every frame: redraw a 1024 x 1024 2D canvas (32 moving circles over a gradient) and upload it, shown on 1,000 yard boxes.',
      params: {},
      data: () => ({ ...base(1000), size: 1024, circles: 32 }),
    },
    'p-uv-transform': {
      area: 'textures',
      rows: ['6.7'],
      title: 'Texture transforms',
      draws:
        '4,096 catalog boxes, each with its own material whose base colour map is one 1024 x 1024 atlas (4 x 4 tiles) with offset/repeat/rotation choosing tile i % 16 rotated by i * 0.1 rad.',
      params: {},
      data: () => boxes(4096),
    },
    'p-depth-texture': {
      area: 'textures',
      rows: ['6.8'],
      title: 'Depth texture',
      draws:
        'Every frame: 1,000 yard boxes into a target with a depth texture, then a quad shows the linearised depth.',
      params: {},
      data: () => base(1000),
    },
    'p-mipmaps': {
      area: 'textures',
      kind: 'task',
      rows: ['6.9'],
      title: 'Mipmap generation',
      draws:
        'One call: upload a 4096 x 4096 RGBA8 image (generated) and generate its full mip chain on the GPU; resolves when done.',
      params: {},
      data: () => ({ size: 4096 }),
    },

    // 7. Lights
    'p-ambient': {
      area: 'lights',
      rows: ['7.1'],
      title: 'Ambient only',
      draws: '10,000 catalog boxes lit by an ambient light (intensity 1) only.',
      params: {},
      data: () => boxes(10_000),
    },
    'p-hemisphere': {
      area: 'lights',
      rows: ['7.2'],
      title: 'Hemisphere light',
      draws:
        '10,000 catalog boxes lit by a hemisphere light (sky #bbddff, ground #443322, intensity 1) and the default directional light.',
      params: {},
      data: () => boxes(10_000),
    },
    'p-spot': {
      area: 'lights',
      rows: ['7.5'],
      title: 'Spot lights',
      draws:
        '1,000 yard boxes lit by 16 spot lights (angle 0.5 rad, penumbra 0.3, range 20, intensity 30) circling at 4 m height and pointing at the floor centre.',
      params: { count: 16 },
      data: (p) => ({
        ...base(1000),
        spots: Array.from({ length: p.count }, (_, i) => ({
          phase: (i / p.count) * Math.PI * 2,
          radius: 8 + (i % 4),
          color: PALETTE[i],
        })),
      }),
    },
    'p-rect-area': {
      area: 'lights',
      rows: ['7.6'],
      title: 'Rect area lights',
      draws: '1,000 yard boxes lit by 4 rect area lights (4 x 1 m, intensity 10, the 4 sides of the yard, facing in).',
      params: {},
      data: () => base(1000),
    },
    'p-light-probe': {
      area: 'lights',
      rows: ['7.7'],
      title: 'Light probe',
      draws:
        '10,000 catalog boxes lit by one L2 spherical-harmonics light probe (data.sh, 9 RGB coefficients of the catalog sky) and no direct light.',
      params: {},
      data: () => ({
        ...boxes(10_000),
        sh: [
          [0.6, 0.65, 0.8],
          [0.1, 0.15, 0.3],
          [0.2, 0.2, 0.18],
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
          [0.05, 0.05, 0.08],
          [0, 0, 0],
          [0, 0, 0],
        ],
      }),
    },
    'p-ies': {
      area: 'lights',
      rows: ['7.8', '10.20'],
      title: 'IES spot lights',
      draws:
        '1,000 yard boxes lit by 4 spot lights shaped by one IES profile (data.ies, LM-63-2002 text, generated), at the yard corners 5 m high aiming at the centre.',
      params: {},
      data: () => ({ ...base(1000), ies: iesText() }),
    },

    // 8. Shadows
    'p-csm': {
      area: 'shadows',
      rows: ['8.1'],
      title: 'Cascaded shadows',
      draws:
        '1,000 yard boxes, the directional light casting 4 cascades of 2048 x 2048 (practical split 0.5, far 100), PCF soft filtering.',
      params: {},
      data: () => ({ ...base(1000), cascades: 4, resolution: 2048, far: 100 }),
    },
    'p-point-shadows': {
      area: 'shadows',
      rows: ['8.2'],
      title: 'Point-light shadows',
      draws:
        '1,000 yard boxes lit by 4 point lights (range 15, intensity 40) at 3 m height circling, each casting a 512 x 512 cube shadow.',
      params: {},
      data: () => base(1000),
    },
    'p-spot-shadows': {
      area: 'shadows',
      rows: ['8.3'],
      title: 'Spot-light shadows',
      draws:
        '1,000 yard boxes lit by 4 spot lights (angle 0.6, penumbra 0.2, range 30) each casting a 1024 x 1024 shadow.',
      params: {},
      data: () => base(1000),
    },

    // 9. Environment, fog and colour
    'p-hdr-load': {
      area: 'environment',
      kind: 'task',
      rows: ['9.1'],
      title: 'HDR load',
      draws: 'One call: parse the Radiance .hdr (data.url) to a float RGB(A) texture and upload it.',
      params: {},
      data: (p, { assets }) => ({ url: `${assets}skinning-ik-workshop.hdr` }),
    },
    'p-exr-load': {
      area: 'environment',
      kind: 'task',
      rows: ['9.2'],
      title: 'EXR load',
      draws:
        'One call: parse the OpenEXR file (data.url, BrightRings, ZIP compression) to a float texture and upload it.',
      params: {},
      data: () => ({ url: fixture('environment', 'BrightRings.exr') }),
    },
    'p-pmrem': {
      area: 'environment',
      kind: 'task',
      rows: ['9.3'],
      title: 'Environment prefilter',
      draws:
        'One call: from the decoded workshop HDR, build the image-based-lighting maps (specular prefiltered levels and diffuse irradiance) the engine uses for scene.environment; resolves when the GPU has them.',
      params: {},
      data: (p, { assets }) => ({ url: `${assets}skinning-ik-workshop.hdr` }),
    },
    'p-fog': {
      area: 'environment',
      rows: ['9.4'],
      title: 'Exponential fog',
      draws: '10,000 catalog boxes with exponential-squared fog (#9fb4c8, density 0.04).',
      params: {},
      data: () => ({ ...boxes(10_000), fog: { color: '#9fb4c8', density: 0.04 } }),
    },
    'p-volumetric': {
      area: 'environment',
      rows: ['9.5'],
      title: 'Volumetric light',
      draws:
        '1,000 yard boxes in a uniform participating medium (density 0.02, scattering 0.8) lit by the shadowed directional light, raymarched at half resolution with 32 steps.',
      params: {},
      data: () => ({ ...base(1000), medium: { density: 0.02, scattering: 0.8, steps: 32, scale: 0.5 } }),
    },
    'p-sky': {
      area: 'environment',
      rows: ['9.6'],
      title: 'Sky',
      draws:
        '1,000 yard boxes under a physical sky (turbidity 2, Rayleigh 1, Mie 0.005, sun elevation 10 + 30 * sin(t * 0.2) degrees), recomputed every frame.',
      params: {},
      data: () => ({ ...base(1000), sky: { turbidity: 2, rayleigh: 1, mie: 0.005 } }),
    },
    'p-tonemap': {
      area: 'environment',
      rows: ['9.7', '13.15'],
      title: 'Tone mapping',
      draws:
        '1,000 yard boxes lit by the directional light at intensity 12 (HDR), ACES filmic tone mapping, exposure 1, sRGB output.',
      params: {},
      data: () => ({ ...base(1000), intensity: 12, curve: 'aces' }),
    },

    // 10. Loaders (tasks: bytes fetched before timing; one call parses them into the engine's scene objects)
    'p-gltf-parse': {
      area: 'loaders',
      kind: 'task',
      rows: ['10.1'],
      title: 'glTF parse (static PBR)',
      draws: 'One call: parse the FlightHelmet GLB bytes into scene objects with decoded textures (no draw).',
      params: {},
      data: (p, { assets }) => loader(`${assets}flight-helmet.glb`),
    },
    'p-gltf-animated': {
      area: 'loaders',
      kind: 'task',
      rows: ['10.2'],
      title: 'glTF parse (skins, animation, morphs)',
      draws: 'One call: parse RobotExpressive (skins, 14 clips, morph targets) into scene objects and clips.',
      params: {},
      data: (p, { assets }) => loader(`${assets}robot-expressive.glb`),
    },
    'p-gltf-extensions': {
      area: 'loaders',
      kind: 'task',
      rows: ['10.4'],
      title: 'glTF extensions',
      draws:
        'One call: parse the Khronos IridescenceLamp sample (KHR_materials_iridescence, transmission, volume, texture transform).',
      params: {},
      data: (p, { assets }) => loader(`${assets}khronos/IridescenceLamp/IridescenceLamp.glb`),
    },
    'p-draco': {
      area: 'loaders',
      kind: 'task',
      rows: ['10.5'],
      title: 'Draco glTF',
      draws:
        'One call: parse the Draco-compressed Avocado glTF (data.url, KHR_draco_mesh_compression) with the engine Draco decoder into scene objects. Its PNG textures are not in the repository, so create() fetches the JSON and Avocado.bin and removes images, textures, samplers and material texture references from the JSON (the same edit in both engines); the task parses that JSON plus the bin. A small file (one small mesh), so decoder start-up weighs heavily.',
      params: {},
      data: () => loader(fixture('decoders', 'Avocado.gltf')),
    },
    'p-meshopt': {
      area: 'loaders',
      kind: 'task',
      rows: ['10.6'],
      title: 'Meshopt glTF',
      draws:
        'One call: parse the Khronos MeshoptCubeTest sample (KHR_meshopt_compression, external buffers and PNGs packed into one in-memory GLB in create, the same in both engines) with the engine meshopt decoder.',
      params: {},
      data: (p, { assets }) => loader(`${assets}khronos/MeshoptCubeTest/MeshoptCubeTest.gltf`),
    },
    'p-fbx': {
      area: 'loaders',
      kind: 'task',
      rows: ['10.8'],
      title: 'FBX parse',
      draws: 'One call: parse the binary FBX rig (data.url) with its skeleton and animation.',
      params: {},
      data: () => loader(fixture('fbx', 'blender-rig.fbx').replace('/tests/', '/test/')),
    },
    'p-obj': {
      area: 'loaders',
      kind: 'task',
      rows: ['10.9'],
      title: 'OBJ parse',
      draws: 'One call: parse a 320 x 320 grid OBJ (data.text, 204,800 triangles, positions only).',
      params: {},
      data: () => ({ text: objText(grid(320)) }),
    },
    'p-mtl': {
      area: 'loaders',
      kind: 'task',
      rows: ['10.10'],
      title: 'MTL parse',
      draws:
        'One call: parse an MTL with 500 materials (Kd, Ks, Ns, d, map_Kd names) into materials (textures not fetched).',
      params: {},
      data: () => ({
        text: Array.from(
          { length: 500 },
          (_, i) => `newmtl m${i}\nKd ${(i % 10) / 10} 0.5 0.5\nKs 0.1 0.1 0.1\nNs 30\nd 1\nmap_Kd t${i % 8}.png`,
        ).join('\n'),
      }),
    },
    'p-stl': {
      area: 'loaders',
      kind: 'task',
      rows: ['10.11'],
      title: 'STL parse',
      draws: 'One call: parse a binary STL of the 320 x 320 grid (204,800 triangles).',
      params: {},
      data: () => ({ bytes: stlBytes(grid(320)) }),
    },
    'p-stl-normals': {
      area: 'loaders',
      kind: 'task',
      rows: ['10.11'],
      title: 'STL parse with normals',
      draws:
        'One call: parse a binary STL of the 320 x 320 grid (204,800 triangles) into a mesh that lights correctly: the file stores zero normals, so three.js calls computeVertexNormals() after STLLoader.parse; parseSTL computes its flat normals itself.',
      params: {},
      data: () => ({ bytes: stlBytes(grid(320)) }),
    },
    'p-ply': {
      area: 'loaders',
      kind: 'task',
      rows: ['10.12'],
      title: 'PLY parse',
      draws: 'One call: parse a binary little-endian PLY of the 320 x 320 grid.',
      params: {},
      data: () => ({ bytes: plyBytes(grid(320)) }),
    },
    'p-3mf': {
      area: 'loaders',
      kind: 'task',
      rows: ['10.13'],
      title: '3MF parse',
      draws: 'One call: parse gears.3mf (zip + XML).',
      params: {},
      data: () => loader(fixture('loaders', 'gears.3mf')),
    },
    'p-usdz': {
      area: 'loaders',
      kind: 'task',
      rows: ['10.14'],
      title: 'USD parse',
      draws: 'One call: parse the USDC crate triangle (data.url).',
      params: {},
      data: () => loader(fixture('usdz', 'triangle.usdc')),
    },
    'p-pcd': {
      area: 'loaders',
      kind: 'task',
      rows: ['10.15'],
      title: 'PCD, XYZ, VTK parse',
      draws: 'One call: parse bunny.pcd, helix.xyz and fran_cut.vtk.',
      params: {},
      data: () => ({ urls: ['bunny.pcd', 'helix.xyz', 'fran_cut.vtk'].map((f) => fixture('loaders', f)) }),
    },
    'p-collada': {
      area: 'loaders',
      kind: 'task',
      rows: ['10.16'],
      title: 'Collada parse',
      draws: 'One call: parse CesiumMan.dae (skinned, animated; its texture not fetched).',
      params: {},
      data: (p, { assets }) => loader(`${assets}khronos-samples/CesiumMan.dae`),
    },
    'p-svg': {
      area: 'loaders',
      kind: 'task',
      rows: ['10.17'],
      title: 'SVG parse and triangulate',
      draws: 'One call: parse an SVG of 500 filled curved stars (data.text) into paths and triangulate their fills.',
      params: {},
      data: () => ({ text: svgText(500) }),
    },
    'p-vox': {
      area: 'loaders',
      kind: 'task',
      rows: ['10.19'],
      title: 'VOX parse',
      draws: 'One call: parse tree.vox and build its meshed voxel geometry.',
      params: {},
      data: () => loader(fixture('voxel', 'tree.vox')),
    },
    'p-texture-formats': {
      area: 'loaders',
      kind: 'task',
      rows: ['10.20'],
      title: 'TGA, DDS, KTX, TIFF parse',
      draws:
        'One call: parse checker.tga, checker-rgba.dds, checker-bc1.dds, checker.ktx and checker-lzw.tif to texture data (no upload).',
      params: {},
      data: (p, { assets }) => ({
        urls: ['checker.tga', 'checker-rgba.dds', 'checker-bc1.dds', 'checker.ktx', 'checker-lzw.tif'].map(
          (f) => `${assets}texture-formats/${f}`,
        ),
      }),
    },
    'p-cube-lut': {
      area: 'loaders',
      kind: 'task',
      rows: ['10.21'],
      title: 'Cube LUT parse',
      draws: 'One call: parse a 33^3 .cube LUT (data.text) into a 3D texture.',
      params: {},
      data: () => ({ text: cubeLUT(33) }),
    },

    // 11. Exporters (tasks)
    'p-export-gltf': {
      area: 'exporters',
      kind: 'task',
      rows: ['11.1'],
      title: 'glTF export',
      draws: 'One call: export 1,000 catalog boxes (shared geometry, 16 materials) as GLB bytes.',
      params: {},
      data: () => boxes(1000),
    },
    'p-export-mesh': {
      area: 'exporters',
      kind: 'task',
      rows: ['11.2'],
      title: 'OBJ, STL, PLY export',
      draws: 'One call: export the 320 x 320 grid mesh as OBJ text, binary STL and binary PLY.',
      params: {},
      data: () => ({ grid: grid(320) }),
    },
    'p-export-usdz': {
      area: 'exporters',
      kind: 'task',
      rows: ['11.3'],
      title: 'USDZ export',
      draws: 'One call: export 1,000 catalog boxes as USDZ bytes.',
      params: {},
      data: () => boxes(1000),
    },
    'p-export-exr': {
      area: 'exporters',
      kind: 'task',
      rows: ['11.4'],
      title: 'EXR export',
      draws:
        'One call: encode a 2048 x 1024 RGBA half-float image (a generated gradient) as EXR bytes (ZIP compression where the encoder has it, else none).',
      params: {},
      data: () => ({ width: 2048, height: 1024 }),
    },

    // 12. Animation
    'p-mixer': {
      area: 'animation',
      rows: ['12.1', '12.3'],
      title: 'Skinned clips',
      draws:
        '100 RobotExpressive instances on a 10 x 10 grid (2.5 m apart), each playing its Walk clip at a different start time, GPU skinning.',
      params: { n: 100 },
      data: (p, { assets }) => ({
        url: `${assets}robot-expressive.glb`,
        n: p.n,
        clip: 'Walk',
        spacing: 2.5,
        camera: orbit(30, 12, 300),
      }),
    },
    'p-crossfade': {
      area: 'animation',
      rows: ['12.2'],
      title: 'Cross-fade',
      draws:
        'The p-mixer crowd, each instance cross-fading Walk -> Running over 0.5 s and back every 2 s, and an additive Wave layer at weight 0.5.',
      params: { n: 100 },
      data: (p, { assets }) => ({
        url: `${assets}robot-expressive.glb`,
        n: p.n,
        spacing: 2.5,
        camera: orbit(30, 12, 300),
      }),
    },
    'p-morph': {
      area: 'animation',
      rows: ['12.5'],
      title: 'Morph targets',
      draws: '100 Khronos MorphStressTest instances, all 8 weights animated as sin(t + i + k) * 0.5 + 0.5.',
      params: {},
      data: (p, { assets }) => ({
        url: `${assets}khronos/MorphStressTest/MorphStressTest.glb`,
        n: 100,
        camera: orbit(20, 8, 200),
      }),
    },
    'p-keyframes': {
      area: 'animation',
      kind: 'task',
      rows: ['12.6'],
      title: 'Authored keyframe tracks',
      draws:
        'One call: evaluate 1,000 code-authored tracks (position vec3 linear, rotation quaternion slerp, scale step; 120 keys each) at 600 times on 1,000 nodes.',
      params: {},
      data: () => ({ tracks: 1000, keys: 120, times: 600 }),
    },
    'p-skeleton-clone': {
      area: 'animation',
      kind: 'task',
      rows: ['12.7'],
      title: 'Skinned clone',
      draws: 'One call: clone the loaded RobotExpressive skinned model 50 times (independent skeletons).',
      params: {},
      data: (p, { assets }) => loader(`${assets}robot-expressive.glb`, { copies: 50 }),
    },
    'p-ik': {
      area: 'animation',
      kind: 'task',
      rows: ['12.8'],
      title: 'CCD IK',
      draws:
        'One call: 1,000 CCD solves of a 10-bone chain (bones 0.3 m) toward a target moving on a circle, 10 iterations each.',
      params: {},
      data: () => ({ bones: 10, length: 0.3, solves: 1000, iterations: 10 }),
    },

    // 13. Post-processing (frame scenes: 1,000 yard boxes through one effect)
    'p-composer': {
      area: 'post',
      rows: ['13.1'],
      title: 'Effect chain (copy)',
      draws:
        '1,000 yard boxes rendered to an HDR target and copied to the canvas through the engine effect chain with no effect.',
      params: {},
      data: () => yardEffect({ name: 'copy' }),
    },
    'p-bloom': {
      area: 'post',
      rows: ['13.2'],
      title: 'Bloom',
      draws: 'Bloom (strength 0.6, radius 0.4, threshold 0.8, 5 mip levels).',
      params: {},
      data: () => yardEffect({ name: 'bloom', strength: 0.6, radius: 0.4, threshold: 0.8 }),
    },
    'p-ssao': {
      area: 'post',
      rows: ['13.3'],
      title: 'SSAO',
      draws: 'Screen-space ambient occlusion (radius 0.5, 16 samples, intensity 1, blurred).',
      params: {},
      data: () => yardEffect({ name: 'ssao', radius: 0.5, samples: 16 }),
    },
    'p-gtao': {
      area: 'post',
      rows: ['13.4'],
      title: 'GTAO',
      draws: 'Ground-truth ambient occlusion (radius 0.5, 16 samples, denoised).',
      params: {},
      data: () => yardEffect({ name: 'gtao', radius: 0.5, samples: 16 }),
    },
    'p-ssr': {
      area: 'post',
      rows: ['13.5'],
      title: 'SSR',
      draws: 'Screen-space reflections on the floor (metalness 1, roughness 0.1), max distance 20, 1 m thickness.',
      params: {},
      data: () => yardEffect({ name: 'ssr', distance: 20, thickness: 1 }),
    },
    'p-ssgi': {
      area: 'post',
      rows: ['13.6'],
      title: 'SSGI',
      draws: 'Screen-space global illumination (radius 2, 8 slices x 8 steps, denoised).',
      params: {},
      data: () => yardEffect({ name: 'ssgi', radius: 2 }),
    },
    'p-taa': {
      area: 'post',
      rows: ['13.7'],
      title: 'TAA',
      draws: 'Temporal anti-aliasing (jittered projection, history blend 0.9) with MSAA off.',
      params: {},
      data: () => yardEffect({ name: 'taa' }),
    },
    'p-fxaa': {
      area: 'post',
      rows: ['13.8'],
      title: 'FXAA',
      draws: 'FXAA on the 1x-sampled image.',
      params: {},
      data: () => yardEffect({ name: 'fxaa' }),
    },
    'p-smaa': {
      area: 'post',
      rows: ['13.8'],
      title: 'SMAA',
      draws: 'SMAA (high preset) on the 1x-sampled image.',
      params: {},
      data: () => yardEffect({ name: 'smaa' }),
    },
    'p-dof': {
      area: 'post',
      rows: ['13.9'],
      title: 'Depth of field',
      draws: 'Bokeh depth of field (focus 12 m, aperture f/2.8 equivalent, max blur 8 px).',
      params: {},
      data: () => yardEffect({ name: 'dof', focus: 12, maxBlur: 8 }),
    },
    'p-outline': {
      area: 'post',
      rows: ['13.10'],
      title: 'Outline',
      draws: 'Outline (edge 3 px, #ffaa00) around 100 selected boxes (every tenth).',
      params: {},
      data: () => yardEffect({ name: 'outline', every: 10, color: '#ffaa00', thickness: 3 }),
    },
    'p-film': {
      area: 'post',
      rows: ['13.11'],
      title: 'Film grain',
      draws: 'Film grain (intensity 0.35, animated).',
      params: {},
      data: () => yardEffect({ name: 'film', intensity: 0.35 }),
    },
    'p-glitch': {
      area: 'post',
      rows: ['13.12'],
      title: 'Glitch',
      draws: 'Digital glitch, always on.',
      params: {},
      data: () => yardEffect({ name: 'glitch' }),
    },
    'p-afterimage': {
      area: 'post',
      rows: ['13.13'],
      title: 'Afterimage',
      draws: 'Afterimage (damp 0.96).',
      params: {},
      data: () => yardEffect({ name: 'afterimage', damp: 0.96 }),
    },
    'p-lut': {
      area: 'post',
      rows: ['13.14'],
      title: 'LUT',
      draws: 'A 33^3 colour LUT (data.effect.lut, the warm .cube grade) applied after tone mapping.',
      params: {},
      data: () => yardEffect({ name: 'lut', lut: cubeLUT(33) }),
    },
    'p-god-rays': {
      area: 'post',
      rows: ['13.16'],
      title: 'God rays',
      draws: 'Screen-space light shafts from the sun direction (64 samples, density 0.9, decay 0.95).',
      params: {},
      data: () => yardEffect({ name: 'godrays', samples: 64 }),
    },
    'p-motion-blur': {
      area: 'post',
      rows: ['13.17'],
      title: 'Motion blur',
      draws: 'Camera and object motion blur (16 samples) while every box spins.',
      params: {},
      data: () => yardEffect({ name: 'motionblur', samples: 16 }),
    },
    'p-color-grading': {
      area: 'post',
      rows: ['13.18'],
      title: 'Colour grading',
      draws: 'Brightness 0.05, contrast 1.1, saturation 1.2, hue 0.1 rad.',
      params: {},
      data: () => yardEffect({ name: 'grading', brightness: 0.05, contrast: 1.1, saturation: 1.2, hue: 0.1 }),
    },
    'p-screen-effects': {
      area: 'post',
      rows: ['13.19'],
      title: 'Screen effects',
      draws: 'Vignette (offset 1, darkness 1), RGB shift (0.005) and pixelation (4 px), chained.',
      params: {},
      data: () => yardEffect({ name: 'screen', vignette: 1, shift: 0.005, pixel: 4 }),
    },
    'p-lensflare': {
      area: 'post',
      rows: ['13.20'],
      title: 'Lens flare',
      draws: 'A lens flare from a point light at (0, 6, 0): 4 elements (512 px glow, 3 rings of 60-120 px).',
      params: {},
      data: () => yardEffect({ name: 'lensflare', light: [0, 6, 0] }),
    },

    // 14. Controls (tasks: the per-frame update an app calls)
    'p-orbit-controls': {
      area: 'controls',
      kind: 'task',
      rows: ['14.1'],
      title: 'Orbit controls update',
      draws:
        'One call: 10,000 orbit-control updates with damping 0.05 after a synthetic drag of 200 px and a wheel step.',
      params: {},
      data: () => ({ updates: 10_000 }),
    },
    'p-transform-controls': {
      area: 'controls',
      rows: ['14.2'],
      title: 'Transform gizmo',
      draws: '1,000 yard boxes with a translate gizmo attached to box 0, gizmo drawn every frame.',
      params: {},
      data: () => base(1000),
    },
    'p-drag-controls': {
      area: 'controls',
      kind: 'task',
      rows: ['14.3'],
      title: 'Drag controls',
      draws: 'One call: 200 pointer moves dragging box 0 across 1,000 yard boxes (pick on down, plane drag on move).',
      params: {},
      data: () => base(1000),
    },
    'p-arcball': {
      area: 'controls',
      kind: 'task',
      rows: ['14.4'],
      title: 'Arcball update',
      draws: 'One call: 10,000 arcball rotate updates along a 200-point pointer path.',
      params: {},
      data: () => ({ updates: 10_000 }),
    },

    // 15. Helpers
    'p-helpers': {
      area: 'helpers',
      rows: ['15.1'],
      title: 'Grid, axes and box helpers',
      draws: '1,000 yard boxes, a 100 x 100 grid helper, an axes helper and a box helper (bounding box) on each box.',
      params: {},
      data: () => base(1000),
    },
    'p-light-helpers': {
      area: 'helpers',
      rows: ['15.2'],
      title: 'Light helpers',
      draws: 'The lights scene (1,000 boxes, 64 moving point lights) with a point-light helper on every light.',
      params: {},
      data: (p, ctx) => ({ ...base(1000), lights: 64 }),
    },
    'p-skeleton-helper': {
      area: 'helpers',
      rows: ['15.3'],
      title: 'Skeleton helper',
      draws: '25 RobotExpressive instances playing Walk, each with a skeleton helper.',
      params: {},
      data: (p, { assets }) => ({
        url: `${assets}robot-expressive.glb`,
        n: 25,
        clip: 'Walk',
        spacing: 2.5,
        camera: orbit(15, 6, 200),
      }),
    },
    'p-view-helper': {
      area: 'helpers',
      rows: ['15.4'],
      title: 'View helper',
      draws: '10,000 catalog boxes plus the orientation view helper (128 px, top right) every frame.',
      params: {},
      data: () => boxes(10_000),
    },

    // 16. Interaction and spatial queries
    'p-raycast': {
      area: 'queries',
      kind: 'task',
      rows: ['16.1'],
      title: 'Raycast',
      draws:
        'One call: 1,000 rays from the camera through a 40 x 25 pixel grid against 10,000 catalog boxes (nearest hit each).',
      params: {},
      data: () => boxes(10_000),
    },
    'p-raycast-mesh': {
      area: 'queries',
      kind: 'task',
      rows: ['16.1'],
      title: 'Raycast against a big mesh',
      draws:
        'One call: 1,000 rays against the 320 x 320 grid mesh (204,800 triangles), with the engine default acceleration.',
      params: {},
      data: () => ({ grid: grid(320) }),
    },
    'p-gpu-pick': {
      area: 'queries',
      kind: 'task',
      rows: ['16.2'],
      title: 'GPU picking',
      draws:
        'One call: pick the object under 100 pixels of the 10,000-box frame through an ID render target and read back the ids.',
      params: {},
      data: () => boxes(10_000),
    },

    // 17. Special objects
    'p-lod': {
      area: 'objects',
      rows: ['17.3'],
      title: 'LOD',
      draws:
        '2,000 spheres on a 45 x 45 grid, each with 3 levels (64 x 32 under 10 m, 16 x 8 under 30 m, a box beyond).',
      params: {},
      data: () => ({
        ...base(2000),
        levels: [
          [64, 32, 0],
          [16, 8, 10],
          [0, 0, 30],
        ],
      }),
    },
    'p-points': {
      area: 'objects',
      rows: ['17.4', '5.10'],
      title: 'Points',
      draws: '1,000,000 points (2 px, per-point colour) in a 20 m cube.',
      params: { n: 1_000_000 },
      data: (p) => {
        const pick = random(31);
        return {
          n: p.n,
          positions: Float32Array.from({ length: p.n * 3 }, () => pick() * 20 - 10),
          camera: orbit(30, 10, 200),
        };
      },
    },
    'p-sprites': {
      area: 'objects',
      rows: ['17.5', '5.10'],
      title: 'Sprites',
      draws:
        '10,000 camera-facing 0.4 m sprites (one 64 x 64 RGBA texture, alpha blended) in the catalog box positions.',
      params: {},
      data: () => boxes(10_000),
    },
    'p-lines': {
      area: 'objects',
      rows: ['17.6', '5.11'],
      title: 'Lines',
      draws:
        '10,000 line segments (one per box edge diagonal), 1,000 dashed segments, and 100 fat polylines (64 points, 4 px wide).',
      params: {},
      data: () => boxes(10_000),
    },
    'p-css-labels': {
      area: 'objects',
      rows: ['17.7'],
      title: 'HTML labels',
      draws: '500 HTML labels following 500 yard boxes (2D overlay), positions updated every frame.',
      params: {},
      data: () => base(500),
    },
    'p-reflector': {
      area: 'objects',
      rows: ['17.8'],
      title: 'Planar mirror',
      draws: '1,000 yard boxes over a planar mirror floor rendered every frame at half resolution.',
      params: {},
      data: () => ({ ...base(1000), scale: 0.5 }),
    },
    'p-water': {
      area: 'objects',
      rows: ['17.9'],
      title: 'Water',
      draws: '1,000 yard boxes beside a 100 x 100 m animated water plane with reflection (half resolution).',
      params: {},
      data: () => base(1000),
    },
    'p-decals': {
      area: 'objects',
      rows: ['17.10'],
      title: 'Decals',
      draws: '200 projected decals (0.5 m, one 256 x 256 texture) on the floor and boxes, drawn every frame.',
      params: {},
      data: () => base(1000),
    },
    'p-marching-cubes': {
      area: 'objects',
      rows: ['17.11'],
      title: 'Marching cubes',
      // Two workloads, both published (row 17.11): `dense` is the original scene, every ball summed at every grid point
      // (identical maths, the field as a function); `localized` writes each ball only into the samples within its
      // reach, as three's MarchingCubes add-on does. three.js runs its add-on (localized) for both.
      draws:
        '16 moving metaballs polygonised every frame on a 64^3 grid; mode dense sums every ball at every grid point (Margo only; three always runs its localized add-on), mode localized writes each ball only near it like three.',
      params: { mode: 'localized' },
      data: (p) => ({ balls: 16, resolution: 64, camera: orbit(3, 1.5, 100), mode: p.mode }),
    },

    // 18. Audio
    'p-audio': {
      area: 'audio',
      kind: 'task',
      rows: ['18.1'],
      title: 'Positional audio update',
      draws:
        'One call: move 64 positional sources and the listener 1,000 times (panner position and orientation each time).',
      params: {},
      data: () => ({ sources: 64, steps: 1000 }),
    },
  };
}

/**
 * Every row of docs/threejs-parity.md: the scenes that measure it, or `none` (why it has no benchmark). Scenes from the
 * main catalog (boxes, materials, lights, shadows, shapes, gltf, helmet) count too. A row may name a case with params.
 */
export const ROWS = {
  '1.1': { scenes: ['p-hierarchy'] },
  '1.2': { scenes: ['p-hierarchy'] },
  '1.3': { scenes: ['p-scenes'] },
  '1.4': { scenes: ['p-background'] },
  '1.5': { scenes: ['p-alpha'] },
  '1.6': { scenes: ['p-culling'] },
  '1.7': {
    none: 'covered: the render loop is every frame scene (rAF-driven, harness.js); Clock/Timer has no workload',
  },
  '1.8': { scenes: ['p-layers'] },
  '1.9': { scenes: ['p-math'] },
  '2.1': { scenes: [{ scene: 'boxes', params: { n: 10_000 } }] },
  '2.2': { scenes: ['p-webgl2'] },
  '2.3': {
    scenes: [
      { scene: 'p-msaa', params: { samples: 1 } },
      { scene: 'p-msaa', params: { samples: 4 } },
    ],
  },
  '2.4': { scenes: ['p-depth-range'] },
  '2.5': { scenes: ['p-custom-shader'] },
  '2.6': { scenes: ['p-node-material'] },
  '2.7': { scenes: ['p-compute'] },
  '2.8': { scenes: ['p-render-target'] },
  '2.9': { scenes: ['p-mrt'] },
  '2.10': { scenes: ['p-clipping'] },
  '2.11': { none: 'no workload: stats and GPU timing report on other work (the harness times every pass itself)' },
  '2.12': { scenes: [{ scene: 'boxes', params: { n: 10_000, views: 4 } }] },
  '3.1': { scenes: [{ scene: 'boxes', params: { n: 10_000 } }] },
  '3.2': { scenes: ['p-ortho'] },
  '3.3': { scenes: [{ scene: 'boxes', params: { n: 10_000, views: 4 } }] },
  '3.4': { scenes: ['p-cube-camera'] },
  '3.5': { none: 'Margo missing (stereo and anaglyph cameras are a documented limit)', margoMissing: true },
  '4.1': { scenes: ['p-primitives'] },
  '4.2': { scenes: ['p-extrude'] },
  '4.3': { scenes: ['p-edges'] },
  '4.4': { scenes: ['p-attributes'] },
  '4.5': { scenes: ['p-geometry-utils'] },
  '4.6': { scenes: ['p-text'] },
  '4.7': { scenes: ['p-geometry-misc'] },
  '5.1': { scenes: ['materials'] },
  '5.2': { scenes: ['p-maps'] },
  '5.3': { scenes: ['p-physical', 'p-transmission'] },
  '5.4': { scenes: ['p-unlit'] },
  '5.5': { scenes: ['p-lambert', 'p-phong'] },
  '5.6': { scenes: ['p-toon'] },
  '5.7': { scenes: ['p-matcap'] },
  '5.8': { scenes: ['p-normal-material', 'p-depth-material'] },
  '5.9': { scenes: ['p-shadow-catcher'] },
  '5.10': { scenes: ['p-points', 'p-sprites'] },
  '5.11': { scenes: ['p-lines'] },
  '5.12': { scenes: ['p-transparency', 'p-alpha-test'] },
  '5.13': {
    none: 'no three.js equivalent (three.js has no built-in order-independent transparency)',
    noEquivalent: true,
  },
  '5.14': { scenes: ['p-attributes'] },
  '5.15': { scenes: ['p-double-sided'] },
  '5.16': { scenes: ['p-wireframe'] },
  '5.17': { scenes: ['p-blending'] },
  '6.1': { scenes: ['p-texture-decode', 'p-maps'] },
  '6.2': { scenes: ['p-background'] },
  '6.3': { scenes: ['p-data-texture'] },
  '6.4': { scenes: ['p-ktx2'] },
  '6.5': { scenes: ['p-video'] },
  '6.6': { scenes: ['p-canvas-texture'] },
  '6.7': { scenes: ['p-uv-transform'] },
  '6.8': { scenes: ['p-depth-texture'] },
  '6.9': { scenes: ['p-mipmaps'] },
  '7.1': { scenes: ['p-ambient'] },
  '7.2': { scenes: ['p-hemisphere'] },
  '7.3': { scenes: [{ scene: 'boxes', params: { n: 10_000 } }] },
  '7.4': { scenes: ['lights'] },
  '7.5': { scenes: ['p-spot'] },
  '7.6': { scenes: ['p-rect-area'] },
  '7.7': { scenes: ['p-light-probe'] },
  '7.8': { scenes: ['p-ies'] },
  '7.9': { none: 'no workload: light units are a scale on intensity' },
  '8.1': { scenes: ['p-csm', 'shadows'] },
  '8.2': { scenes: ['p-point-shadows'] },
  '8.3': { scenes: ['p-spot-shadows'] },
  '9.1': { scenes: ['p-hdr-load'] },
  '9.2': { scenes: ['p-exr-load'] },
  // helmet with Margo's default shadows (4 PCSS cascades), and with the setup closest to three's one PCFSoftShadowMap.
  '9.3': { scenes: ['p-pmrem', 'helmet', { scene: 'helmet', params: { filter: 'pcf', cascades: 1 } }] },
  '9.4': { scenes: ['p-fog'] },
  '9.5': { scenes: ['p-volumetric'] },
  '9.6': { scenes: ['p-sky'] },
  '9.7': { scenes: ['p-tonemap'] },
  '9.8': { none: 'no workload of its own: colour conversion is part of every frame scene' },
  '9.9': { none: 'no workload: exposure is one uniform' },
  '10.1': { scenes: ['p-gltf-parse', { scene: 'gltf', params: { model: 'flight-helmet' } }] },
  '10.2': { scenes: ['p-gltf-animated'] },
  '10.3': { none: 'no three.js equivalent (GLTFLoader resolves once the whole file is parsed)', noEquivalent: true },
  '10.4': { scenes: ['p-gltf-extensions'] },
  '10.5': { scenes: ['p-draco'] },
  '10.6': { scenes: ['p-meshopt'] },
  '10.7': { scenes: ['p-ktx2'] },
  '10.8': { scenes: ['p-fbx'] },
  '10.9': { scenes: ['p-obj'] },
  '10.10': { scenes: ['p-mtl'] },
  '10.11': { scenes: ['p-stl', 'p-stl-normals'] },
  '10.12': { scenes: ['p-ply'] },
  '10.13': { scenes: ['p-3mf'] },
  '10.14': { scenes: ['p-usdz'] },
  '10.15': { scenes: ['p-pcd'] },
  '10.16': { scenes: ['p-collada'] },
  '10.17': { scenes: ['p-svg'] },
  '10.18': { none: 'Margo missing (long-tail loaders are a documented limit)', margoMissing: true },
  '10.19': { scenes: ['p-vox'] },
  '10.20': { scenes: ['p-texture-formats', 'p-ies'] },
  '10.21': { scenes: ['p-cube-lut'] },
  '10.22': { none: 'no workload: loading manager and cache bookkeeping' },
  '11.1': { scenes: ['p-export-gltf'] },
  '11.2': { scenes: ['p-export-mesh'] },
  '11.3': { scenes: ['p-export-usdz'] },
  '11.4': { scenes: ['p-export-exr'] },
  '11.5': { none: 'Margo missing (Draco and KTX2 encoders are a documented limit)', margoMissing: true },
  '12.1': { scenes: ['p-mixer'] },
  '12.2': { scenes: ['p-crossfade'] },
  '12.3': { scenes: ['p-mixer'] },
  '12.4': { none: 'no three.js equivalent (three.js has no built-in vertex animation textures)', noEquivalent: true },
  '12.5': { scenes: ['p-morph'] },
  '12.6': { scenes: ['p-keyframes'] },
  '12.7': { scenes: ['p-skeleton-clone'] },
  '12.8': { scenes: ['p-ik'] },
  '13.1': { scenes: ['p-composer'] },
  '13.2': { scenes: ['p-bloom'] },
  '13.3': { scenes: ['p-ssao'] },
  '13.4': { scenes: ['p-gtao'] },
  '13.5': { scenes: ['p-ssr'] },
  '13.6': { scenes: ['p-ssgi'] },
  '13.7': { scenes: ['p-taa'] },
  '13.8': { scenes: ['p-fxaa', 'p-smaa'] },
  '13.9': { scenes: ['p-dof'] },
  '13.10': { scenes: ['p-outline'] },
  '13.11': { scenes: ['p-film'] },
  '13.12': { scenes: ['p-glitch'] },
  '13.13': { scenes: ['p-afterimage'] },
  '13.14': { scenes: ['p-lut'] },
  '13.15': { scenes: ['p-tonemap'] },
  '13.16': { scenes: ['p-god-rays'] },
  '13.17': { scenes: ['p-motion-blur'] },
  '13.18': { scenes: ['p-color-grading'] },
  '13.19': { scenes: ['p-screen-effects'] },
  '13.20': { scenes: ['p-lensflare'] },
  '14.1': { scenes: ['p-orbit-controls'] },
  '14.2': { scenes: ['p-transform-controls'] },
  '14.3': { scenes: ['p-drag-controls'] },
  '14.4': { scenes: ['p-arcball'] },
  '15.1': { scenes: ['p-helpers'] },
  '15.2': { scenes: ['p-light-helpers'] },
  '15.3': { scenes: ['p-skeleton-helper'] },
  '15.4': { scenes: ['p-view-helper'] },
  '16.1': { scenes: ['p-raycast', 'p-raycast-mesh'] },
  '16.2': { scenes: ['p-gpu-pick'] },
  '17.1': {
    owner: 'margo-bench (docs/whitepaper/boxes-vs-threejs.md)',
    scenes: [{ scene: 'boxes', params: { n: 10_000, mode: 'instanced' } }],
  },
  '17.2': { scenes: [{ scene: 'shapes', params: { n: 10_000, mode: 'batched' } }] },
  '17.3': { scenes: ['p-lod'] },
  '17.4': { scenes: ['p-points'] },
  '17.5': { scenes: ['p-sprites'] },
  '17.6': { scenes: ['p-lines'] },
  '17.7': { scenes: ['p-css-labels'] },
  '17.8': { scenes: ['p-reflector'] },
  '17.9': { scenes: ['p-water'] },
  '17.10': { scenes: ['p-decals'] },
  // The original full-grid workload beside the localized one that matches three's add-on (both labelled in the matrix).
  '17.11': {
    scenes: [
      { scene: 'p-marching-cubes', params: { mode: 'dense' } },
      { scene: 'p-marching-cubes', params: { mode: 'localized' } },
    ],
  },
  '18.1': { scenes: ['p-audio'] },
  '19.1': { none: 'not measurable headless: WebXR sessions need an XR device' },
  '19.2': { none: 'not measurable headless: WebXR sessions need an XR device' },
  '19.3': { none: 'not measurable headless: WebXR sessions need an XR device' },
  '19.4': { none: 'Margo missing (controller and hand models)', margoMissing: true },
};

/** The parity cases: every scene a row names, once (the catalog STANDARD format); `scenes` is the catalog SCENES. */
export function parityCases(scenes) {
  const seen = new Map();
  for (const row of Object.values(ROWS))
    for (const s of row.scenes ?? []) {
      const c = typeof s === 'string' ? { scene: s } : s,
        key = `${c.scene}:${JSON.stringify(c.params ?? {})}`;
      if (!seen.has(key)) seen.set(key, c);
    }
  return [...seen.values()].map((c) => ({
    ...c,
    primary: scenes[c.scene]?.kind === 'task' ? ['taskMs'] : ['cpuMs', 'gpuMs'],
  }));
}

/**
 * What a case measures, where a row names more than one way to do its job: shown beside the case id in the matrix
 * (docs/whitepaper/perf-vs-threejs.md) so a reader sees which row is Margo's default, which is the setup closest to
 * three's, and which does more or less work than three.js.
 */
export const LABELS = {
  helmet:
    "Margo's default shadows: PCSS soft filter, 4 cascades (an accepted GPU-time loss against three's one PCF map)",
  'helmet-filterpcf-cascades1':
    "the shadow setup closest to three's: filter 'pcf', 1 cascade (three: one PCFSoftShadowMap)",
  'p-stl':
    "parseSTL: STL raw triangles + flat normals (typed arrays, no weld) against three's STLLoader, which copies the file's zero normals (an accepted difference in work); its first runs timed a weld-and-parts path that has since been removed",
  'p-stl-normals': "like-for-like with usable normals: parseSTL against three's STLLoader + computeVertexNormals()",
  'p-marching-cubes-dense':
    'dense: the original workload, every ball summed at every grid point (more work than three, whose add-on writes each ball only near it)',
  'p-marching-cubes-localized':
    "localized: each ball written only within its reach, the same work as three's MarchingCubes add-on",
  'p-marching-cubes':
    'history only: first run dense, later runs localized; superseded by p-marching-cubes-dense and -localized',
};
