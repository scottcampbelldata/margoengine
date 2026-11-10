// Real-GPU fixture for @margoengine/tiles: a generated city-scale tileset (6-level quadtree over 8 km, 1365 b3dm
// tiles, anchored in ECEF at 40 N 75.6 W) streamed by TilesRenderer through gltf-pro and drawn by the engine.
// tests/tiles-browser.mjs drives it and checks the numbers. Built imports, so it uses the published package boundary.
import { Engine } from '../../core/dist/extension.js';
import { TilesFade, ditherRank } from '../dist/fade.js';
import { TileFeatures } from '../dist/features.js';
import { parseGLTFAsync, GLTFAsset } from '../../gltf-pro/dist/index.js';
import { gaussianSplats, readGaussianSplats } from '../../gltf-pro/dist/splats.js';
import { glbChunks } from '../../shared/glb.js';
import { i3dm } from '../dist/i3dm.js';
import { splats, tileSplats } from '../dist/splats.js';
import { terrain } from '../dist/terrain.js';
import { TilesStyle } from '../dist/style.js';
import { readPropertyMetadata, loadPropertyMetadata } from '../dist/properties.js';
import { terrainImagery, wms, wmts, compositeImagery } from '../dist/imagery.js';
import { PointCloud, PointsPlugin } from '../../points/dist/index.js';
import { Splats, transformSplats } from '../../splats/dist/index.js';
import { TilesRenderer } from '../dist/index.js';
import { cityTileset, groveTileset, memoryFetch } from './generator.js';

const W = 480,
  H = 270,
  canvas = document.querySelector('canvas')!,
  engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 120, 1800], target: [0, 0, 0], far: 20_000, near: 1 },
  }),
  errors: string[] = [];
engine.stop();
engine.onError = (error) => errors.push(String(error));
const device = engine.gpu!;
device.addEventListener('uncapturederror', (event) => errors.push((event as GPUUncapturedErrorEvent).error.message));
(engine as unknown as { scene: { background: string } }).scene.background = '#000000';

const city = cityTileset({ levels: 6, size: 8192, format: 'b3dm', height: 30 }),
  memory = memoryFetch(city.files);

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
function pixels(): Uint8ClampedArray {
  engine.render();
  const copy = document.createElement('canvas');
  copy.width = W;
  copy.height = H;
  const context = copy.getContext('2d')!;
  context.drawImage(canvas, 0, 0);
  return context.getImageData(0, 0, W, H).data;
}
const lit = (data: Uint8ClampedArray, x: number, y: number) => {
  const i = (Math.round(y) * W + Math.round(x)) * 4;
  return data[i] + data[i + 1] + data[i + 2] > 30;
};
function project(world: readonly number[]): [number, number, number] {
  const m = engine.camera.matrix,
    [x, y, z] = world;
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12],
    cy = m[1] * x + m[5] * y + m[9] * z + m[13],
    cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [((cx / cw + 1) / 2) * W, ((1 - cy / cw) / 2) * H, cw];
}

let tiles: TilesRenderer;
async function converge(limit = 600): Promise<{ frames: number; ms: number }> {
  const started = performance.now();
  for (let i = 0; i < limit; i++) {
    await frame();
    await new Promise((r) => setTimeout(r, 0));
    const p = tiles.tileset.progress;
    if (i > 2 && tiles.last.pending === 0 && p.loading === 0 && p.queued === 0)
      return { frames: i, ms: performance.now() - started };
  }
  throw new Error(`tileset did not settle in ${limit} frames: ${JSON.stringify(tiles.tileset.progress)}`);
}
function snapshot() {
  const depths: Record<number, number> = {};
  for (const t of tiles.last.selected) depths[t.depth] = (depths[t.depth] ?? 0) + 1;
  return {
    selected: tiles.last.selected.length,
    depths,
    progress: tiles.tileset.progress,
    requests: memory.requests.length,
  };
}

async function run(name: string): Promise<unknown> {
  if (name === 'fade') {
    const from = errors.length;
    const url =
      '/examples/assets/3d-tiles/EXT_structural_metadata/FeatureIdAttributeAndPropertyTable/FeatureIdAttributeAndPropertyTable.gltf';
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const root = {
      boundingVolume: { sphere: [0.5, 0.5, 0, 2] },
      geometricError: 1000,
      content: { uri: 'a.gltf' },
      children: [{ boundingVolume: { sphere: [0.5, 0.5, 0, 2] }, geometricError: 0, content: { uri: 'a.gltf' } }],
    };
    const data = memoryFetch(
      new Map([
        [
          'tileset.json',
          new TextEncoder().encode(JSON.stringify({ asset: { version: '1.1' }, geometricError: 1000, root })),
        ],
        ['a.gltf', bytes],
      ]),
    );
    let time = 0;
    const fade = new TilesFade({ duration: 1, clock: () => time });
    engine.camera.position = [0.5, 0.5, 2];
    engine.camera.target = [0.5, 0.5, 0];
    tiles = await TilesRenderer.load(engine, data.url, {
      fetch: data.fetch,
      frame: 'local',
      maximumScreenSpaceError: 1e9,
      decorate: fade.decorate,
    });
    fade.attach(tiles);
    await converge();
    const before = pixels();
    tiles.tileset.maximumScreenSpaceError = 0;
    await converge();
    tiles.tileset.memoryBudget = 1;
    time = 0.5;
    await frame();
    const middle = pixels();
    const parentRetained = tiles.tileset.root.renderable?.visible === true;
    let difference = 0,
      litCount = 0;
    for (let i = 0; i < before.length; i++) {
      difference = Math.max(difference, Math.abs(before[i] - middle[i]));
      if (i % 4 !== 3 && before[i] > 10) litCount++;
    }
    time = 1.1;
    await frame();
    const evicted = tiles.tileset.root.state === 'unloaded';
    fade.dispose();
    tiles.dispose();
    const host = PointsPlugin.attach(engine);
    const point = host.add(
      new PointCloud({
        positions: new Float32Array([0.5, 0.5, 0]),
        material: { size: 128, minPixelSize: 128, maxPixelSize: 128, shape: 'square' },
      }),
    );
    await frame();
    const fullPoint = pixels();
    point.material.ditherFade = [0, 0.5];
    await frame();
    const halfPoint = pixels();
    point.material.ditherFade = [0, 0];
    await frame();
    const noPoint = pixels();
    let pointPixels = 0,
      pointHalf = 0,
      pointZero = 0,
      pointWrong = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (fullPoint[i] + fullPoint[i + 1] + fullPoint[i + 2] > 10) {
          pointPixels++;
          const present = halfPoint[i] + halfPoint[i + 1] + halfPoint[i + 2] > 10;
          if (present) pointHalf++;
          if (present !== ditherRank(x, y) < 8) pointWrong++;
        }
        if (noPoint[i] + noPoint[i + 1] + noPoint[i + 2] > 10) pointZero++;
      }
    host.dispose();
    const cube = new Uint8Array(
      await (await fetch('/examples/assets/3d-tiles/GaussianSplats/sh_unit_cube/0/0.glb')).arrayBuffer(),
    );
    const chunks = glbChunks(cube),
      doc = JSON.parse(new TextDecoder().decode(chunks[0].data)),
      asset = new GLTFAsset(doc, [], chunks[1].data, { splats: gaussianSplats }, 2 ** 30),
      splatsData = await readGaussianSplats(asset, doc.meshes[0].primitives[0]);
    engine.camera.position = [3, 2, 4];
    engine.camera.target = [0, 0, 0];
    const cloud = Splats.attach(engine, splatsData);
    await frame();
    const fullSplat = pixels();
    cloud.setDitherFade(0, cloud.count, 0, 0.5);
    await frame();
    const halfSplat = pixels();
    let splatPixels = 0,
      splatHalf = 0,
      splatWrong = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (fullSplat[i] + fullSplat[i + 1] + fullSplat[i + 2] > 10) {
          splatPixels++;
          const present = halfSplat[i] + halfSplat[i + 1] + halfSplat[i + 2] > 10;
          if (present) splatHalf++;
          if (present !== ditherRank(x, y) < 8) splatWrong++;
        }
      }
    const fadeBytes = cloud.ditherFadeBytes;
    cloud.dispose();
    engine.camera.position = [0, 0, 3];
    engine.camera.target = [0, 0, 0];
    const sorted = Splats.attach(engine, {
      positions: new Float32Array([0, 0, 0, 0, 0, -1]),
      covariances: new Float32Array([0.1, 0, 0, 0.1, 0, 0.1, 0.1, 0, 0, 0.1, 0, 0.1]),
      colors: new Float32Array([1, 0, 0, 1, 0, 1, 0, 1]),
    });
    sorted.setDitherFade(0, 1, 0, 0.5);
    sorted.setDitherFade(1, 1, 0.5, 1);
    await frame();
    const sortedPixels = pixels();
    let sortedChecked = 0,
      sortedWrong = 0;
    for (let y = H / 2 - 10; y < H / 2 + 10; y++)
      for (let x = W / 2 - 10; x < W / 2 + 10; x++) {
        const i = (y * W + x) * 4;
        const red = sortedPixels[i] > sortedPixels[i + 1];
        if (sortedPixels[i] + sortedPixels[i + 1] > 10) {
          sortedChecked++;
          if (red !== ditherRank(x, y) < 8) sortedWrong++;
        }
      }
    sorted.dispose();
    engine.camera.position = [0, 120, 1800];
    engine.camera.target = [0, 0, 0];
    return {
      errors: errors.slice(from),
      difference,
      litCount,
      parentRetained,
      evicted,
      pointPixels,
      pointHalf,
      pointZero,
      pointWrong,
      splatPixels,
      splatHalf,
      splatWrong,
      fadeBytes,
      sortedChecked,
      sortedWrong,
      count: splatsData.positions.length / 3,
    };
  }
  if (name === 'features') {
    const from = errors.length;
    const url =
      '/examples/assets/3d-tiles/EXT_structural_metadata/FeatureIdAttributeAndPropertyTable/FeatureIdAttributeAndPropertyTable.gltf';
    const doc = await (await fetch(url)).json();
    const primitive = doc.meshes[0].primitives[0],
      accessor = doc.accessors[primitive.attributes._FEATURE_ID_0],
      view = doc.bufferViews[accessor.bufferView];
    const raw = Uint8Array.from(atob(doc.buffers[view.buffer].uri.split(',')[1]), (c) => c.charCodeAt(0));
    for (let i = 0; i < accessor.count; i++) raw[(view.byteOffset ?? 0) + i * (view.byteStride ?? 1)] = i % 3;
    doc.buffers[view.buffer].uri = 'data:application/octet-stream;base64,' + btoa(String.fromCharCode(...raw));
    const bytes = new TextEncoder().encode(JSON.stringify(doc)),
      model = await parseGLTFAsync(engine, bytes);
    const p = model.primitives[0],
      v = p.vertices.slice();
    for (let i = 0; i < v.length; i += 20) {
      const x = v[i],
        y = v[i + 1],
        n = Math.hypot(x * 0.6, y * 0.6, 1);
      v.set([(x * 0.6) / n, (y * 0.6) / n, 1 / n], i + 4);
    }
    model.writeGeometry([{ vertices: v, indices: p.indices }]);
    engine.camera.position = [0.5, 0.5, 2];
    engine.camera.target = [0.5, 0.5, 0];
    await frame();
    const before = pixels();
    const features = new TileFeatures(engine);
    const tile = { id: 0, contentUrls: [new URL(url, location.href).href] } as any;
    const decoration = await features.decorate({
      kind: 'model',
      model,
      content: { type: 'gltf', gltf: bytes, byteLength: bytes.length },
      tile,
    });
    const feature = features.resolve({ primitive: p, faceIndex: 0, barycoord: [0.8, 0.1, 0.1] })!;
    features.highlight(feature, [1, 1, 1, 1]);
    await frame();
    const white = pixels();
    let maxDifference = 0,
      visible = 0;
    for (let i = 0; i < white.length; i++) {
      maxDifference = Math.max(maxDifference, Math.abs(white[i] - before[i]));
      if (i % 4 !== 3 && before[i] > 10) visible++;
    }
    features.highlight(feature, [1, 0, 0, 1]);
    await frame();
    const red = pixels();
    let changed = 0;
    for (let i = 0; i < red.length; i += 4) if (red[i + 1] + 10 < before[i + 1]) changed++;
    decoration.dispose();
    features.dispose();
    await frame();
    const restored = pixels();
    let restoreDifference = 0;
    for (let i = 0; i < restored.length; i++)
      restoreDifference = Math.max(restoreDifference, Math.abs(restored[i] - before[i]));
    // Exercise the UINT32 comparison and transformed UV shader on the same real sample.
    const set = primitive.extensions.EXT_mesh_features.featureIds[0];
    delete set.attribute;
    delete set.propertyTable;
    set.texture = {
      index: 0,
      channels: [0, 1, 2, 3],
      extensions: { KHR_texture_transform: { offset: [0.5, 0], scale: [0, 0], rotation: 0.3, texCoord: 2 } },
    };
    const pos = p.definition.attributes.POSITION!;
    p.definition.attributes.TEXCOORD_2 = pos;
    const originalAccessor = model.asset.accessor.bind(model.asset);
    model.asset.accessor = ((index: unknown, type?: string) =>
      index === pos && type === 'VEC2'
        ? new Float32Array(v.length / 10)
        : originalAccessor(index, type)) as typeof model.asset.accessor;
    model.asset.doc.textures = [{ source: 0 }];
    const textureBytes = new TextEncoder().encode(JSON.stringify({ ...doc, textures: [{ source: 0 }] }));
    const textures = new TileFeatures(engine, {
      image: () => ({ width: 1, height: 1, data: new Uint8Array([254, 255, 255, 255]) }),
    });
    const textureDecoration = await textures.decorate({
      kind: 'model',
      model,
      content: { type: 'gltf', gltf: textureBytes, byteLength: textureBytes.length },
      tile,
    });
    const textureFeature = textures.resolve({ primitive: p, faceIndex: 0, barycoord: [0.8, 0.1, 0.1] })!;
    textures.highlight(textureFeature, [0, 1, 0, 1]);
    await frame();
    const allocated = textureDecoration.bytes;
    textureDecoration.dispose();
    textures.dispose();
    model.dispose();
    engine.camera.position = [0, 120, 1800];
    engine.camera.target = [0, 0, 0];
    return {
      errors: errors.slice(from),
      visible,
      changed,
      maxDifference,
      restoreDifference,
      id: textureFeature.id,
      allocated,
    };
  }
  if (name === 'imagery') {
    const from = errors.length;
    const png = async (color: string) => {
      const canvas = new OffscreenCanvas(16, 16),
        ctx = canvas.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 16, 16);
      return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    };
    const red = await png('#ff0000'),
      blue = await png('#0000ff');
    const terrainBytes = new Uint8Array(
      await (
        await fetch(
          new URL(
            '../../../examples/assets/terrain/QuantizedMeshWithOctVertexNormals/tile.octvertexnormals.terrain',
            import.meta.url,
          ),
        )
      ).arrayBuffer(),
    );
    const requests: string[] = [];
    const outer = async (url: string) => {
      requests.push(url);
      if (url.endsWith('layer.json'))
        return new Response(JSON.stringify({ tiles: ['{z}/{x}/{y}.terrain'], projection: 'EPSG:3857', maxzoom: 0 }));
      return new Response(
        (url.includes('/wms?') ? red : url.includes('/wmts?') ? blue : terrainBytes) as Uint8Array<ArrayBuffer>,
      );
    };
    const layers = [
      wms({ url: 'https://map.test/wms', layers: 'red', crs: 'CRS:84' }),
      Object.assign(wmts({ url: 'https://map.test/wmts', layer: 'blue', matrixSet: 'WebMercator' }), { opacity: 0.5 }),
    ];
    const merged = await compositeImagery(
      layers,
      [-Math.PI, -1, Math.PI, 1],
      0,
      outer,
      new AbortController().signal,
      16,
    );
    const image = await createImageBitmap(new Blob([merged.bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' })),
      canvas = new OffscreenCanvas(16, 16),
      ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    image.close();
    const center = [...ctx.getImageData(8, 8, 1, 1).data];
    const beforePolar = requests.length;
    const polar = await compositeImagery(
      [
        wms({ url: 'https://map.test/wms', layers: 'polar', crs: 'EPSG:3857' }),
        wmts({ url: 'https://map.test/wmts', layer: 'polar', matrixSet: 'WebMercator' }),
      ],
      [-1, 1.5, 1, Math.PI / 2],
      0,
      outer,
      new AbortController().signal,
      16,
    );
    const polarImage = await createImageBitmap(
      new Blob([polar.bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }),
    );
    ctx.clearRect(0, 0, 16, 16);
    ctx.drawImage(polarImage, 0, 0);
    polarImage.close();
    const polarAlpha = ctx.getImageData(8, 8, 1, 1).data[3],
      polarRequests = requests.length - beforePolar;
    const source = await terrainImagery('https://terrain.test/layer.json', {
      fetch: outer,
      imagery: layers,
      imagerySize: 64,
    });
    engine.camera.near = 100_000;
    engine.camera.far = 100_000_000;
    engine.camera.position = [0, 0, 23_400_000];
    engine.camera.target = [0, 0, 0];
    tiles = await TilesRenderer.load(engine, source.url, { fetch: source.fetch, frame: 'local' });
    tiles.tileset.on('error', ({ error }) => errors.push(String(error)));
    await converge();
    const data = pixels();
    let purple = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 30 && data[i + 1] < 5 && data[i + 2] > 30) purple++;
    const selected = tiles.last.selected.length;
    tiles.dispose();
    source.dispose();
    engine.camera.near = 1;
    engine.camera.far = 20_000;
    return {
      purple,
      center,
      selected,
      polarAlpha,
      polarRequests,
      wms: requests.some((url) => url.includes('SERVICE=WMS')),
      wmts: requests.some((url) => url.includes('SERVICE=WMTS')),
      errors: errors.slice(from),
    };
  }
  if (name === 'properties') {
    const from = errors.length;
    const base = '/examples/assets/3d-tiles/EXT_structural_metadata/';
    const doc = await (await fetch(base + 'PropertyAttributesPointCloud/PropertyAttributesPointCloudTree.gltf')).json();
    const bytes = new Uint8Array(
      await (await fetch(base + 'PropertyAttributesPointCloud/PropertyAttributesPointCloudTree.bin')).arrayBuffer(),
    );
    const schema = await (await fetch(base + 'PropertyAttributesPointCloud/MetadataSchema.json')).json();
    const asset = new GLTFAsset(doc, [bytes]);
    const attributes = readPropertyMetadata(asset, { schema }).primitives[0][0].attributes[0];
    const positions = asset.accessor(doc.meshes[0].primitives[0].attributes.POSITION);
    const colors = new Float32Array(attributes.count * 4);
    let classified = 0;
    for (let i = 0; i < attributes.count; i++) {
      if (attributes.get(i, 'classification') === 'MediumVegetation') classified++;
      colors[i * 4 + 1] = 0.2 + 1.6 * Number(attributes.get(i, 'intensity'));
      colors[i * 4 + 3] = 1;
    }
    const points = PointsPlugin.attach(engine, { name: 'property-attribute-proof' });
    points.add(new PointCloud({ positions, colors, material: { size: 3, sizeAttenuation: false } }));
    engine.camera.position = [2.5, 3.7, 15];
    engine.camera.target = [2.5, 3.7, 0];
    await frame();
    const image = pixels();
    let green = 0;
    for (let i = 0; i < image.length; i += 4) if (image[i + 1] > 30 && image[i] < 5 && image[i + 2] < 5) green++;
    points.dispose();
    const textureDoc = await (await fetch(base + 'SimplePropertyTexture/SimplePropertyTexture.gltf')).json();
    const metadata = await loadPropertyMetadata(new GLTFAsset(textureDoc, []));
    const texture = metadata.propertyTextures[0];
    return {
      count: attributes.count,
      classified,
      green,
      rows: [texture.row([0, 0]), texture.row([0.25, 0.25])],
      errors: errors.slice(from),
    };
  }
  if (name === 'style') {
    // Real OGC metadata sample, already licensed in examples/assets/3d-tiles/NOTICE.md.
    const start = errors.length;
    engine.camera.position = [0.5, 0.5, 2];
    engine.camera.target = [0.5, 0.5, 0];
    const folder = '../../../examples/assets/3d-tiles/EXT_structural_metadata/FeatureIdAttributeAndPropertyTable/';
    const style = new TilesStyle({ show: '${example_VEC3_FLOAT32}[0] < 2', color: 'color("red")' });
    const matrices = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]; // cancel tiles' y-up to z-up turn
    tiles = await TilesRenderer.load(engine, new URL(folder + 'tileset.json', import.meta.url), {
      frame: matrices,
      decorate: style.decorate,
    });
    tiles.tileset.on('error', ({ error }) => errors.push(String(error)));
    await converge();
    const data = pixels();
    const samples = [
      [0.2, 0.2, 0],
      [0.8, 0.2, 0],
      [0.2, 0.8, 0],
      [0.8, 0.8, 0],
    ].map((p) => {
      const [x, y] = project(p),
        at = (Math.round(y) * W + Math.round(x)) * 4;
      return [...data.slice(at, at + 3)];
    });
    tiles.dispose();
    await frame();
    engine.camera.position = [0, 0, 2];
    engine.camera.target = [0, 0, 0];
    const points = PointsPlugin.attach(engine, { name: 'style-point-proof' });
    const cloud = points.add(new PointCloud({ positions: [-0.3, 0, 0, 0.3, 0, 0], material: { minPixelSize: 20 } }));
    const handle = new TilesStyle({ show: '${id} === 0', color: 'color("lime")', pointSize: 10 }).bindPoints(
      cloud,
      (i) => ({ id: i }),
    );
    await frame();
    const pointPixels = pixels();
    const pointSamples = [
      [-0.3, 0, 0],
      [0.3, 0, 0],
    ].map((p) => {
      const [x, y] = project(p),
        at = (Math.round(y) * W + Math.round(x)) * 4;
      return [...pointPixels.slice(at, at + 3)];
    });
    const greenPixels = Array.from({ length: W * H }, (_, i) => i * 4).filter(
      (i) => pointPixels[i] < 5 && pointPixels[i + 1] > 30 && pointPixels[i + 2] < 5,
    ).length;
    handle.dispose();
    points.dispose();
    return { samples, pointSamples, greenPixels, errors: errors.slice(start) };
  }
  if (name === 'grove') {
    // 25 box trees from one i3dm tile (EAST_NORTH_UP, RTC_CENTER, ECEF), drawn as instances through gltf-pro.
    const grove = groveTileset({ n: 5, spacing: 40, height: 12 }),
      files = memoryFetch(grove.files);
    engine.camera.position = [0, 90, 230];
    engine.camera.target = [0, 0, -10];
    tiles = await TilesRenderer.load(engine, files.url, { fetch: files.fetch, i3dm });
    const timing = await converge();
    const data = pixels();
    const trees = grove.offsets.map((_, i) => {
      const content = tiles.tileset.root.contents[0] as unknown as { matrices: Float64Array };
      const foot = tiles.toWorld([0, 1, 2].map((k) => content.matrices[i * 16 + 12 + k] + grove.rtc[k]));
      return project([foot[0], foot[1] + 6, foot[2]]);
    });
    const onScreen = trees.filter(([x, y, w]) => w > 0 && x > 4 && x < W - 4 && y > 4 && y < H - 4);
    const drawn = onScreen.filter(([x, y]) => lit(data, x, y)).length;
    // Between trees (half a spacing east of the middle one, at half height) the background shows.
    const gap = project([20, 6, 0]);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 30) count++;
    const result = {
      ...timing,
      ...snapshot(),
      onScreen: onScreen.length,
      drawn,
      gapLit: lit(data, gap[0], gap[1]),
      lit: count,
      errors: [...errors],
    };
    tiles.dispose();
    return result;
  }
  if (name === 'cesium-trees') {
    // The real TilesetWithTreeBillboards sample (Cesium 3d-tiles-samples, CC0): 25 trees in each of two i3dm tiles,
    // fetched from the repository by a relative URL, as a page would. Close enough (under 146 m) that the root's
    // geometric error of 10 m refines to the full trees; the root's billboards need KHR_techniques_webgl (GLSL
    // shaders), which gltf-pro refuses with a coded error, as glTF says a loader must for a required extension.
    engine.camera.position = [0, 70, 110];
    engine.camera.target = [0, 0, 0];
    tiles = await TilesRenderer.load(
      engine,
      '../../../examples/assets/3d-tiles/TilesetWithTreeBillboards/tileset.json',
      { i3dm },
    );
    tiles.tileset.on('error', ({ error }) => errors.push(`tile: ${(error as Error).message}`));
    const timing = await converge();
    const data = pixels();
    const shown = tiles.last.selected.flatMap((tile) => tile.contents) as unknown as { matrices?: Float64Array }[];
    const trees = shown.flatMap((content) =>
      Array.from({ length: (content.matrices?.length ?? 0) / 16 }, (_, i) => {
        const foot = tiles.toWorld([0, 1, 2].map((k) => content.matrices![i * 16 + 12 + k]));
        // 10 m up the 20 m tree is the textured crown; the trunk below is darker than the lit threshold.
        return project([foot[0], foot[1] + 10, foot[2]]);
      }),
    );
    const onScreen = trees.filter(([x, y, w]) => w > 0 && x > 4 && x < W - 4 && y > 4 && y < H - 4);
    const result = {
      ...timing,
      ...snapshot(),
      trees: trees.length,
      onScreen: onScreen.length,
      drawn: onScreen.filter(([x, y]) => lit(data, x, y)).length,
      urls: tiles.last.selected.map((tile) => tile.contentUrls[0]?.split('/').pop()),
      errors: [...errors],
    };
    tiles.dispose();
    return result;
  }
  if (name === 'terrain') {
    // Cesium's real quantized-mesh sample (CesiumJS Specs/Data, Apache-2.0, oct normals) as a whole-globe layer of two
    // levels, every tile the same file placed in its own rectangle, draped with a STAND-IN imagery tile made here: a
    // red and blue checker, so the drape shows as both colours on the globe.
    const from = errors.length,
      checker = document.createElement('canvas');
    checker.width = checker.height = 64;
    const g = checker.getContext('2d')!;
    for (let i = 0; i < 8; i++)
      for (let j = 0; j < 8; j++) {
        g.fillStyle = (i + j) % 2 ? '#ff2020' : '#2040ff';
        g.fillRect(i * 8, j * 8, 8, 8);
      }
    const png = new Uint8Array(
      await (await new Promise<Blob>((r) => checker.toBlob((b) => r(b!), 'image/png'))).arrayBuffer(),
    );
    const folder = '../../../examples/assets/terrain/QuantizedMeshWithOctVertexNormals/',
      fetchAll = async (input: string, init?: { signal?: AbortSignal }) =>
        input.startsWith('imagery/') ? new Response(png) : fetch(input.split('?')[0], init);
    const source = await terrain(folder + 'layer.json', {
      fetch: fetchAll,
      imagery: { url: 'imagery/{z}/{x}/{y}.png' },
    });
    engine.camera.near = 100_000;
    engine.camera.far = 100_000_000;
    engine.camera.position = [0, 8_000_000, 22_000_000];
    engine.camera.target = [0, 0, 0];
    tiles = await TilesRenderer.load(engine, source.url, { fetch: source.fetch, frame: 'local' });
    tiles.tileset.on('error', ({ error }) => errors.push(`tile: ${(error as Error).message}`));
    const timing = await converge();
    const data = pixels();
    let litCount = 0,
      red = 0,
      blue = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] + data[i + 1] + data[i + 2] > 30) litCount++;
      if (data[i] > 150 && data[i + 2] < 100) red++;
      if (data[i + 2] > 150 && data[i] < 100) blue++;
    }
    const result = { ...timing, ...snapshot(), lit: litCount, red, blue, errors: errors.slice(from) };
    tiles.dispose();
    engine.camera.near = 1;
    engine.camera.far = 20_000;
    return result;
  }
  if (name === 'gpu-memory') {
    // What the GPU really holds for a tile, counted at the device: every buffer and texture created while the tile
    // loads and draws, less those destroyed; then what disposing the tile frees. The tile is Khronos's real BoomBox
    // (10.6 MB GLB, four 2048 x 2048 PNG textures) as one glTF tile, so the file size and the GPU size differ widely.
    const from = errors.length,
      sizes = new Map<object, number>();
    let live = 0;
    const blocks: Record<string, number> = { bc7: 16, astc: 16, etc2: 16, bc1: 8, bc4: 8 };
    const texel = (format: string) => {
      const block = Object.keys(blocks).find((k) => format.startsWith(k));
      return block ? blocks[block] / 16 : format.startsWith('rgba16') ? 8 : format.startsWith('rgba32') ? 16 : 4;
    };
    const track = (object: GPUBuffer | GPUTexture, bytes: number) => {
      sizes.set(object, bytes);
      live += bytes;
      const destroy = object.destroy.bind(object);
      object.destroy = () => {
        if (sizes.has(object)) live -= sizes.get(object)!;
        sizes.delete(object);
        destroy();
      };
      return object;
    };
    const createBuffer = device.createBuffer.bind(device),
      createTexture = device.createTexture.bind(device);
    device.createBuffer = (d) => track(createBuffer(d), d.size) as GPUBuffer;
    device.createTexture = (d) => {
      const t = createTexture(d),
        [w, h, layers = 1] = Array.isArray(d.size)
          ? d.size
          : [
              (d.size as GPUExtent3DDict).width,
              (d.size as GPUExtent3DDict).height ?? 1,
              (d.size as GPUExtent3DDict).depthOrArrayLayers ?? 1,
            ];
      let bytes = 0;
      for (let l = 0; l < (d.mipLevelCount ?? 1); l++)
        bytes += Math.max(1, w >> l) * Math.max(1, h >> l) * layers * texel(d.format);
      // Render targets (the frame's own) are not tile memory; keep them apart by their usage.
      return track(
        t,
        d.usage & GPUTextureUsage.TEXTURE_BINDING && !(d.usage & GPUTextureUsage.STORAGE_BINDING)
          ? bytes * (d.sampleCount ?? 1)
          : 0,
      ) as GPUTexture;
    };
    const glb = new Uint8Array(
      await (await fetch('../../../examples/assets/khronos/BoomBox/BoomBox.glb')).arrayBuffer(),
    );
    const json = {
      asset: { version: '1.1' },
      geometricError: 1,
      root: {
        boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
        geometricError: 0,
        content: { uri: 'boom.glb' },
      },
    };
    const files = memoryFetch(
      new Map([
        ['tileset.json', new TextEncoder().encode(JSON.stringify(json))],
        ['boom.glb', glb],
      ]),
    );
    engine.camera.position = [0, 0, 0.08];
    engine.camera.target = [0, 0, 0];
    await frame();
    const before = live;
    tiles = await TilesRenderer.load(engine, files.url, { fetch: files.fetch });
    const timing = await converge();
    await frame();
    await frame();
    const loaded = live - before,
      counted = tiles.tileset.progress.bytes;
    tiles.dispose();
    await frame();
    const freed = loaded - (live - before);
    device.createBuffer = createBuffer;
    device.createTexture = createTexture;
    return { ...timing, file: glb.byteLength, counted, loaded, freed, errors: errors.slice(from) };
  }
  if (name === 'cesium-splats') {
    // CesiumJS's real sh_unit_cube splat tileset (Specs/Data, Apache-2.0): one glTF tile of 27 Gaussian splats with
    // SH degree 3 in an SPZ payload (KHR_gaussian_splatting_compression_spz_2), not geo-referenced ('local' frame).
    const base = '../../../examples/assets/3d-tiles/GaussianSplats/sh_unit_cube/',
      from = errors.length; // the cases before leave their own (expected) errors
    const bytes = new Uint8Array(await (await fetch(base + '0/0.glb')).arrayBuffer()),
      [json, binary] = glbChunks(bytes),
      doc = JSON.parse(new TextDecoder().decode(json.data)),
      raw = await readGaussianSplats(
        new GLTFAsset(doc, [], binary.data, { splats: gaussianSplats }, 2 ** 30),
        doc.meshes[0].primitives[0],
      );
    // Its one node turns and moves the primitive (z up to y up, then 50 m along x and z, -50 m along y).
    const data = transformSplats(raw, doc.nodes[0].matrix);
    const count = data.positions.length / 3;
    let low = [Infinity, Infinity, Infinity],
      high = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++)
      for (let k = 0; k < 3; k++) {
        low[k] = Math.min(low[k], data.positions[i * 3 + k]);
        high[k] = Math.max(high[k], data.positions[i * 3 + k]);
      }
    tiles = await TilesRenderer.load(engine, base + 'tileset.json', { splats });
    tiles.tileset.on('error', ({ error }) => errors.push(`tile: ${(error as Error).message}`));
    // glTF content in a 'local' frame: the y-up to z-up turn and the frame's z-up to y-up cancel, so a centre's world
    // position is its glTF position. Look at the cube from 2.5 of its spans away.
    const middle = low.map((v, k) => (v + high[k]) / 2),
      span = Math.max(...high.map((v, k) => v - low[k]));
    engine.camera.position = [middle[0] + span * 1.2, middle[1] + span * 0.9, middle[2] + span * 2];
    engine.camera.target = middle;
    const timing = await converge();
    const data2 = pixels();
    const scene = await tileSplats((tiles as unknown as { host: Parameters<typeof tileSplats>[0] }).host);
    const centres = Array.from({ length: count }, (_, i) =>
      project([data.positions[i * 3], data.positions[i * 3 + 1], data.positions[i * 3 + 2]]),
    ).filter(([x, y, w]) => w > 0 && x > 2 && x < W - 2 && y > 2 && y < H - 2);
    let lit2 = 0;
    for (let i = 0; i < data2.length; i += 4) if (data2[i] + data2[i + 1] + data2[i + 2] > 30) lit2++;
    const result = {
      ...timing,
      ...snapshot(),
      splats: scene?.count ?? 0,
      clouds: scene?.clouds.length ?? 0,
      centres: centres.length,
      drawn: centres.filter(([x, y]) => lit(data2, x, y)).length,
      lit: lit2,
      errors: errors.slice(from),
    };
    // Hiding the tile (selection frozen) empties the cloud at the next flush (the renderer flushes after each update).
    tiles.enabled = false;
    for (const tile of tiles.last.selected) if (tile.renderable) tile.renderable.visible = false;
    scene?.flush();
    const hidden = scene?.count ?? -1;
    tiles.dispose();
    const after = pixels();
    let litAfter = 0;
    for (let i = 0; i < after.length; i += 4) if (after[i] + after[i + 1] + after[i + 2] > 30) litAfter++;
    // The control: the same splats drawn straight by @margoengine/splats at their glTF positions. The tile path must
    // give the same picture (the same splats, in the same place, the same shapes and colours).
    const direct = Splats.attach(engine, data),
      reference = pixels();
    direct.dispose();
    let differ = 0,
      worst = 0;
    for (let i = 0; i < reference.length; i += 4) {
      const d = Math.max(...[0, 1, 2].map((c) => Math.abs(reference[i + c] - data2[i + c])));
      worst = Math.max(worst, d);
      if (d > 2) differ++;
    }
    const directDrawn = centres.filter(([x, y]) => lit(reference, x, y)).length;
    return { ...result, hidden, litAfter, cloudsAfter: scene?.clouds.length ?? -1, directDrawn, differ, worst };
  }
  if (name === 'city') {
    tiles = await TilesRenderer.load(engine, memory.url, {
      fetch: memory.fetch,
      maxConcurrentRequests: 8,
      memoryBudget: 80_000,
      // This case checks eviction against file sizes (its 80 kB is a file budget); 'gpu-memory' checks the GPU count.
      budget: 'content',
    });
    const timing = await converge();
    const data = pixels();
    let count = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 30) count++;
    // Every on-screen leaf building: its centre (the tile volume's centre, through the float64 frame) must be drawn.
    const centres = tiles.last.selected
      .filter((t) => t.children.length === 0)
      .map((t) => project(tiles.toWorld(t.bounds.center)))
      .filter(([x, y, w]) => w > 0 && x > 8 && x < W - 8 && y > 8 && y < H - 8);
    const drawn = centres.filter(([x, y]) => lit(data, x, y)).length;
    // Sky above the horizon stays background.
    const sky = !lit(data, W / 2, 4);
    return {
      ...timing,
      ...snapshot(),
      lit: count,
      leavesOnScreen: centres.length,
      leavesDrawn: drawn,
      sky,
      errors: [...errors],
    };
  }
  // Fly 3 km east, low: new leaves load there, old ones are evicted under the 80 kB budget, models are disposed.
  const before = memory.requests.length;
  let unloads = 0;
  tiles.tileset.on('tileunload', () => unloads++);
  engine.camera.position = [3000, 60, 600];
  engine.camera.target = [3000, 0, -400];
  const timing = await converge();
  const data = pixels();
  let count = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 30) count++;
  return {
    ...timing,
    ...snapshot(),
    newRequests: memory.requests.length - before,
    unloads,
    lit: count,
    errors: [...errors],
  };
}

(window as unknown as { tilesFixture: unknown }).tilesFixture = {
  run,
  dispose: () => {
    tiles.dispose();
    return { plugins: engine.hasPlugin(tiles.name), errors: [...errors] };
  },
};
