import {toGeometry} from '../../packages/loaders/dist/index.js';
import {PbrMaterial} from '../../packages/core/dist/index.js';

/** Display normalization preserves the parsed model's topology; original data stays untouched. */
export function displayGeometry(loaded) {
  const positions = loaded.positions.slice(), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {const axis = i % 3; min[axis] = Math.min(min[axis], positions[i]); max[axis] = Math.max(max[axis], positions[i]);}
  const extent = Math.max(...max.map((value, axis) => value - min[axis])); if (!(extent > 0)) throw new RangeError('Empty asset bounds');
  for (let i = 0; i < positions.length; i++) {const axis = i % 3; positions[i] = (positions[i] - (min[axis] + max[axis]) / 2) * 1.8 / extent;}
  return toGeometry({...loaded, positions});
}

export function geometryData(geometry) {
  const vertices = geometry.vertices, positions = new Float32Array(vertices.length / 2), normals = new Float32Array(positions.length);
  for (let i = 0; i < vertices.length / 6; i++) for (let axis = 0; axis < 3; axis++) {positions[i * 3 + axis] = vertices[i * 6 + axis]; normals[i * 3 + axis] = vertices[i * 6 + axis + 3];}
  return {positions, normals, indices: geometry.indices};
}

/** Bounded real parse/decode/export jobs, with one batch at a time and explicit late-result ownership. */
export async function assetWorkload(count, load, description, {signal, cleanup = () => {}, details = () => ({}), material, repeat = true} = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 9) throw new RangeError('Asset workload count must be 1..9');
  signal?.throwIfAborted(); const setup = performance.now(), points = new Float32Array(count * 4), yaw = new Float32Array(count), side = Math.ceil(Math.sqrt(count)), extent = side * 1.2;
  let geometries, meshes = [], context, time = 0, nextBatch = 1, generation = 0, batchController, pending = false, disposed = false, batches = 0, completedJobs = 0, batchElapsedMilliseconds = 0, error = null;
  const cancel = () => {generation++; batchController?.abort(); pending = false;};
  const dispose = () => {if (disposed) return; disposed = true; cancel(); signal?.removeEventListener('abort', dispose); cleanup(); geometries = null; meshes = []; context = null;};
  signal?.addEventListener('abort', dispose, {once: true});
  const batch = async initial => {
    const ticket = ++generation, started = performance.now(); batchController = new AbortController(); pending = true;
    try {
      const output = await Promise.all(Array.from({length: count}, (_, index) => load(index, batchController.signal)));
      if (disposed || ticket !== generation) return;
      geometries = output; completedJobs += output.length; batches++; batchElapsedMilliseconds = performance.now() - started;
      meshes.forEach((mesh, index) => mesh.setGeometry(geometries[index])); context?.render();
    } catch (failure) {if (!disposed && ticket === generation) {error = String(failure.message ?? failure).slice(0, 160); if (initial) throw failure;}}
    finally {if (ticket === generation) pending = false;}
  };
  try {await batch(true); signal?.throwIfAborted();} catch (failure) {dispose(); throw failure;}
  const setupElapsedMilliseconds = performance.now() - setup;
  return {points, yaw, get geometries() {return geometries;}, description, bounds: {min: [-extent, 0, -extent], max: [extent, 2.2, extent]},
    mount(value) {if (disposed) throw new Error('Asset workload is disposed'); context = value; meshes = value.meshes; const appearance = material ? new PbrMaterial(material) : null; meshes.forEach((mesh, index) => {mesh.name = `Asset ${index + 1}`; mesh.setGeometry(geometries[index]); if (appearance) mesh.setMaterial(appearance);});},
    step(delta) {
      if (disposed) return; if (!Number.isFinite(delta) || delta < 0 || delta > 0.1) throw new RangeError('Invalid asset frame delta'); time += delta;
      for (let i = 0; i < count; i++) {points[i * 4] = (i % side - (side - 1) / 2) * 2.4; points[i * 4 + 1] = 1.1; points[i * 4 + 2] = (Math.floor(i / side) - (side - 1) / 2) * 2.4; points[i * 4 + 3] = i % 3; yaw[i] = time * 0.2 + i * 0.15;}
      if (repeat && time >= nextBatch && !pending) {nextBatch = time + 1; void batch(false);}
    },
    pause: cancel,
    details: () => ({models: count, batches, completedJobs, pending, batchElapsedMilliseconds, setupElapsedMilliseconds, jobError: error, ...details()}), dispose
  };
}
