import { decodeMargo, parseMargo } from '../../packages/blender/dist/index.js';
import { fetchBytes } from '../../packages/loaders/dist/index.js';

/** Reproducible Python-writer fixture: shared geometry, mirrored TRS and embedded PNG. */
export async function createWorkload(count = 4, options = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 9) throw new RangeError('Blender model count must be 1..9');
  const started = performance.now(),
    source = await fetchBytes(new URL('../../packages/blender/tests/fixtures/triangle.margo', import.meta.url), {
      ...options,
      maxBytes: 10000,
    });
  options.signal?.throwIfAborted();
  const asset = decodeMargo(source),
    points = new Float32Array(count * 4),
    yaw = new Float32Array(count),
    models = [],
    side = Math.ceil(Math.sqrt(count)),
    extent = side * 1.2;
  const primitives = asset.document.nodes.reduce(
    (sum, node) => sum + (node.mesh === undefined ? 0 : asset.geometry[node.mesh].length),
    0,
  );
  let context,
    disposed = false,
    time = 0,
    frames = 0,
    decodedJobs = 0,
    nextBatch = 1,
    decodeCpuMilliseconds = 0,
    mountElapsedMilliseconds = 0;
  const setupElapsedMilliseconds = performance.now() - started;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.signal?.removeEventListener('abort', dispose);
    models.forEach((model) => model.dispose());
    context = undefined;
  };
  options.signal?.addEventListener('abort', dispose, { once: true });
  const step = (delta) => {
    if (disposed) return;
    if (!Number.isFinite(delta) || delta < 0 || delta > 0.1) throw new RangeError('Invalid Blender frame delta');
    time += delta;
    frames++;
    for (let i = 0; i < count; i++) {
      points[i * 4] = ((i % side) - (side - 1) / 2) * 2.4;
      points[i * 4 + 1] = 1.1;
      points[i * 4 + 2] = (Math.floor(i / side) - (side - 1) / 2) * 2.4;
      points[i * 4 + 3] = i % 3;
      yaw[i] = time * 0.2 + i * 0.15;
    }
    if (time >= nextBatch) {
      nextBatch = time + 1;
      const start = performance.now();
      for (let i = 0; i < count; i++) decodeMargo(source);
      decodeCpuMilliseconds = performance.now() - start;
      decodedJobs += count;
    }
  };
  step(0);
  return {
    points,
    yaw,
    capacity: count * (asset.document.nodes.length + 2),
    renderedObjects: count * primitives,
    get models() {
      return models;
    },
    bounds: { min: [-extent, 0, -extent], max: [extent, 2.2, extent] },
    description:
      'The real checked-in .margo Python-writer fixture loads two textured PBR triangles sharing packed geometry, including an authored mirrored transform. Model anchors are cleared. Mount uses actual parseMargo image decoding/GPU upload; Run revalidates bounded decode-only batches once per second. This tiny format/lifecycle fixture does not claim complex Blender export or commercial-scene coverage.',
    step,
    async mount(value) {
      if (disposed) throw new Error('Blender workload is disposed');
      if (context) throw new Error('Blender workload is already mounted');
      options.signal?.throwIfAborted();
      if (value.engine.backend !== 'webgpu') throw new Error('Blender benchmark requires real WebGPU PBR draws');
      context = value;
      const start = performance.now();
      try {
        for (let i = 0; i < count; i++) {
          value.meshes[i].setGeometry(null);
          const model = await parseMargo(value.engine, source, { signal: options.signal });
          if (disposed || options.signal?.aborted) {
            model.dispose();
            throw new DOMException('Blender workload disposed', 'AbortError');
          }
          models.push(model);
          const b = model.bounds,
            scale = 1.8 / Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
          model.root
            .setScale([scale, scale, scale])
            .setPosition([(-(b[0] + b[3]) * scale) / 2, (-(b[1] + b[4]) * scale) / 2, (-(b[2] + b[5]) * scale) / 2])
            .setParent(value.meshes[i]);
        }
        mountElapsedMilliseconds = performance.now() - start;
      } catch (error) {
        dispose();
        throw error;
      }
    },
    details: () => ({
      models: models.length,
      primitives: models.reduce((n, model) => n + model.primitives.length, 0),
      sourceBytes: source.length,
      sharedGeometryPerModel: asset.geometry.length,
      embeddedPngsPerModel: asset.images.length,
      frames,
      decodedJobs,
      lastDecodeBatchCpuMilliseconds: decodeCpuMilliseconds,
      setupElapsedMilliseconds,
      mountElapsedMilliseconds,
    }),
    dispose,
  };
}
