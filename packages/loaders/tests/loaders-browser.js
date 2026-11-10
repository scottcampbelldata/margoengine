import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { createMeshes, load, parse3MF, LoaderError } from '@margoengine/loaders';
import { parseLottie } from '@margoengine/loaders/lottie';
import { parsePLY } from '@margoengine/loaders/ply';
import { parseOFF } from '@margoengine/loaders/off';
import { parseVTKLegacy } from '@margoengine/loaders/vtk-legacy';
import { parseGeoJSON } from '@margoengine/loaders/geo';
import { parse3MFLattice } from '@margoengine/loaders/threemf-lattice';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

function snapshot(engine) {
  engine.render();
  // Read the WebGPU canvas in the same task as the render, before it is presented.
  const canvas = document.createElement('canvas');
  canvas.width = engine.canvas.width;
  canvas.height = engine.canvas.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(engine.canvas, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}

window.runLoaderTests = async () => {
  const checks = [];
  const canvas = document.getElementById('view');
  const engine = await Engine.create(canvas, { backend: 'webgpu' });
  const device = engineRuntime(engine).gpu,
    errors = [];
  assert(device, 'WebGPU device unavailable');
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  device.pushErrorScope('validation');

  const empty = snapshot(engine);
  const faceFiles = [
    [parseOFF, 'OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2 255 0 0\n'],
    [
      parsePLY,
      'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2 255 0 0\n',
    ],
  ];
  for (const [parse, source] of faceFiles) {
    const model = parse(new TextEncoder().encode(source));
    assert(model.groups[0].color[0] === 1 && model.groups[0].count === 3, 'source face group survives');
    const scene = createMeshes(engine, model);
    assert(scene.meshes.length === 1, 'face group creates its own mesh');
    engine.render();
    scene.dispose();
  }
  checks.push('PLY and OFF face color groups create and render engine meshes');
  const vtk = parseVTKLegacy(
    new TextEncoder().encode(
      '# vtk DataFile Version 3.0\nlegacy cells\nASCII\nDATASET POLYDATA\nPOINTS 3 float\n0 0 0 1 0 0 0 1 0\nVERTICES 1 2\n1 2\nLINES 1 3\n2 0 1\nPOLYGONS 1 4\n3 0 1 2\nCELL_DATA 3\nSCALARS pressure double\nLOOKUP_TABLE default\n10 20 30\n',
    ),
  );
  assert(vtk.vertices[0] === 2 && vtk.lines.length === 2 && vtk.triangleCells[0] === 2, 'VTK source cells survive');
  assert(vtk.cellData.pressure.values[2] === 30, 'VTK cell data addresses the rendered surface');
  const vtkScene = createMeshes(engine, vtk);
  engine.render();
  vtkScene.dispose();
  checks.push('Legacy VTK vertex/line topology and cell data survive surface rendering');
  const geo = parseGeoJSON({
    type: 'Feature',
    properties: { name: 'parcel' },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
        [
          [0.25, 0.25],
          [0.25, 0.75],
          [0.75, 0.75],
          [0.75, 0.25],
          [0.25, 0.25],
        ],
      ],
    },
  });
  assert(
    geo.polygons[0].rings.length === 2 && geo.mesh.indices.length === 24,
    'geospatial polygon holes survive tessellation',
  );
  const geoScene = createMeshes(engine, geo.mesh);
  engine.render();
  geoScene.dispose();
  checks.push('Geospatial polygon holes and feature groups render through createMeshes');
  const native = await load('/tests/fixtures/lattice-slices.3mf', parse3MFLattice, { maxBytes: 1 << 20 });
  assert(
    native.objects[0].lattice.activeBeams.length === 1 && native.sliceInstances[0].stack.layers.length === 2,
    'native beam and slice resources survive browser decoding',
  );
  const nativeScene = createMeshes(engine, native);
  engine.render();
  nativeScene.dispose();
  checks.push('Native 3MF beam/slice data and composite/multi material fallback render together');
  const result = await load('/tests/fixtures/face_colors.3mf', parse3MF, { maxBytes: 1 << 20 });
  assert(result.groups.length === 5, `expected 5 color groups, got ${result.groups.length}`);
  checks.push('load() + parse3MF in the browser (DecompressionStream deflate-raw)');

  const loaded = createMeshes(engine, result);
  assert(loaded.meshes.length === 5 && loaded.materials.length === 5, 'one mesh and one material per face color');
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < result.positions.length; i += 3)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], result.positions[i + a]);
      max[a] = Math.max(max[a], result.positions[i + a]);
    }
  const center = min.map((v, a) => (v + max[a]) / 2),
    radius = Math.hypot(...max.map((v, a) => v - min[a])) / 2;
  engine.camera.near = radius / 50;
  engine.camera.far = radius * 50;
  engine.camera.target = center;
  engine.camera.position = [center[0] + radius * 1.6, center[1] + radius * 1.3, center[2] + radius * 2.0];
  const pixels = snapshot(engine);

  // Classify every pixel by the face color it is closest to in direction (lighting scales brightness only).
  const references = result.groups.map((g) => [g.color.slice(0, 3), g.color.slice(0, 3).map(toLinear)]);
  const counts = new Array(result.groups.length).fill(0);
  let changed = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (
      Math.abs(pixels[i] - empty[i]) + Math.abs(pixels[i + 1] - empty[i + 1]) + Math.abs(pixels[i + 2] - empty[i + 2]) >
      30
    )
      changed++;
    const rgb = [pixels[i], pixels[i + 1], pixels[i + 2]],
      length = Math.hypot(...rgb);
    if (length < 60) continue;
    let best = -1,
      bestScore = 0.985;
    references.forEach((pair, g) => {
      for (const ref of pair) {
        const score = (rgb[0] * ref[0] + rgb[1] * ref[1] + rgb[2] * ref[2]) / (length * Math.hypot(...ref));
        if (score > bestScore) {
          bestScore = score;
          best = g;
        }
      }
    });
    if (best >= 0) counts[best]++;
  }
  const visible = counts.filter((n) => n > 40).length;
  assert(changed > 2000, `model covers too few pixels (${changed})`);
  assert(visible >= 3, `expected at least 3 face colors on screen, counts ${counts}`);
  checks.push(`Rendered ${changed} model pixels with ${visible} distinct face colors visible`);

  const picked = await engine.pick(canvas.clientWidth / 2, canvas.clientHeight / 2);
  assert(picked && loaded.meshes.includes(picked), 'GPU pick at the center did not return a created mesh');
  checks.push(`GPU pick returned mesh "${picked.name}"`);

  let rejected = false;
  try {
    await load('/tests/fixtures/face_colors.3mf', parse3MF, { maxBytes: 100 });
  } catch (error) {
    rejected = error instanceof LoaderError && error.code === 'limit';
  }
  assert(rejected, 'load() did not enforce maxBytes');
  checks.push('load() rejects responses over maxBytes');

  loaded.dispose();
  assert(engineRuntime(engine).meshes.size === 0, 'dispose left meshes behind');
  const cleared = snapshot(engine);
  let leftover = 0;
  for (let i = 0; i < cleared.length; i += 4)
    if (
      Math.abs(cleared[i] - empty[i]) +
        Math.abs(cleared[i + 1] - empty[i + 1]) +
        Math.abs(cleared[i + 2] - empty[i + 2]) >
      30
    )
      leftover++;
  assert(leftover === 0, `${leftover} pixels remain after dispose`);
  checks.push('dispose() removes every mesh');

  // A Lottie frame on a real 2D canvas, then uploaded as a texture.
  const paint = (rgb, shape) => ({
    ty: 4,
    ks: {},
    ip: 0,
    op: 10,
    st: 0,
    shapes: [shape, { ty: 'fl', c: { k: rgb }, o: { k: 100 } }],
  });
  const lottie = parseLottie(
    JSON.stringify({
      fr: 30,
      w: 32,
      h: 32,
      ip: 0,
      op: 10,
      layers: [
        paint([1, 0, 0], { ty: 'el', p: { k: [16, 16] }, s: { k: [16, 16] } }),
        paint([0, 0, 1], { ty: 'rc', p: { k: [16, 16] }, s: { k: [32, 32] }, r: { k: 0 } }),
      ],
    }),
  );
  const surface = new OffscreenCanvas(32, 32),
    painted = surface.getContext('2d', { willReadFrequently: true });
  lottie.draw(painted, 0);
  const middle = painted.getImageData(16, 16, 1, 1).data,
    edge = painted.getImageData(1, 1, 1, 1).data;
  assert(middle[0] === 255 && middle[2] === 0 && middle[3] === 255, `Lottie top layer is ${[...middle]}`);
  assert(edge[0] === 0 && edge[2] === 255 && edge[3] === 255, `Lottie bottom layer is ${[...edge]}`);
  const uploaded = device.createTexture({
    size: [32, 32],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture({ source: surface }, { texture: uploaded }, [32, 32]);
  uploaded.destroy();
  checks.push('A Lottie frame draws on a real canvas and uploads as a texture');

  const scope = await device.popErrorScope();
  await device.queue.onSubmittedWorkDone();
  assert(!scope && errors.length === 0, `WebGPU validation errors: ${scope?.message ?? errors.join('; ')}`);
  checks.push('Zero WebGPU validation errors');
  engine.dispose();
  return { checks, counts, adapter: device.adapterInfo?.description || device.adapterInfo?.vendor || 'unknown' };
};
