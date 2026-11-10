// Culling's route on the WebGL2 compatibility layer, loaded by import() only there.
// WebGL2 has no workgroup memory or atomics, so the layer would run the cull and scan kernels (their workgroup scans)
// one invocation at a time on the CPU and read GPU-written lists back every frame: about 12 ms a frame for 10,000
// parts against 1 ms natively. Here the same tests run on the CPU from the data the plugins already keep there, and
// the kept 96-byte records and the indirect arguments are uploaded; nothing is computed on the GPU. The tests are the
// kernels' own (shaders.ts and meshes.ts) in double precision: a padded sphere is conservative, so any part the GPU
// route keeps and this one drops lies wholly outside the frustum, and the image is the same. Occlusion culling needs
// the Hi-Z pyramid of this frame's depth on the CPU, a GPU readback per frame, so on this route 'occlusion' culls
// against the frustum only: the same image with more parts drawn.

/** The six frustum planes (xyz normal, w distance; inside where dot(n, p) + w >= 0) as 24 floats. */
type Planes = ArrayLike<number>;

/** False when the sphere (cx, cy, cz, r) lies wholly outside one of the planes. */
function inside(planes: Planes, cx: number, cy: number, cz: number, r: number): boolean {
  for (let p = 0; p < 24; p += 4)
    if (planes[p] * cx + planes[p + 1] * cy + planes[p + 2] * cz + planes[p + 3] < -r) return false;
  return true;
}

/** The parts of `CulledInstances` it keeps; see that class for the arrays. */
export interface PartLists {
  readonly records: Float32Array;
  readonly hidden: Uint32Array;
  readonly bounds: Float32Array;
  readonly batchOf: Uint32Array;
  readonly starts: readonly number[];
  readonly count: number;
}

/**
 * `CulledInstances`' cull, scan and scatter kernels on the CPU: each batch's kept parts, in their original order, from
 * its first slot in `drawn` (24 floats each), and each batch's instance count at `args[batch * 5 + 1]`. `cull` is
 * false for culling mode 'none' (every part not hidden is kept).
 * @returns The number of parts kept per batch, in `kept`.
 */
export function cullParts(
  lists: PartLists,
  planes: Planes,
  cull: boolean,
  drawn: Float32Array,
  args: Uint32Array,
  kept: Uint32Array,
): void {
  const { records, hidden, bounds, batchOf, starts, count } = lists;
  kept.fill(0);
  for (let i = 0; i < count; i++) {
    if (hidden[i]) continue;
    const b = batchOf[i],
      at = i * 24;
    if (cull) {
      const x = bounds[b * 4],
        y = bounds[b * 4 + 1],
        z = bounds[b * 4 + 2],
        m = records;
      const cx = m[at] * x + m[at + 4] * y + m[at + 8] * z + m[at + 12],
        cy = m[at + 1] * x + m[at + 5] * y + m[at + 9] * z + m[at + 13],
        cz = m[at + 2] * x + m[at + 6] * y + m[at + 10] * z + m[at + 14];
      const scale = Math.max(
        m[at] ** 2 + m[at + 1] ** 2 + m[at + 2] ** 2,
        m[at + 4] ** 2 + m[at + 5] ** 2 + m[at + 6] ** 2,
        m[at + 8] ** 2 + m[at + 9] ** 2 + m[at + 10] ** 2,
      );
      const r = bounds[b * 4 + 3] * Math.sqrt(scale);
      if (!inside(planes, cx, cy, cz, r + 1e-5 * (Math.hypot(cx, cy, cz) + r))) continue;
    }
    drawn.set(records.subarray(at, at + 24), (starts[b] + kept[b]++) * 24);
  }
  for (let b = 0; b < starts.length; b++) args[b * 5 + 1] = kept[b];
}

/**
 * `CulledMeshes`' kernel on the CPU for one core batch: its instance records (24 floats each) whose sphere `sphere`
 * (local centre and radius) passes the frustum and screen-size test of `frame` (camera, planes, then width, pixel
 * scale and minimum radius at 40 to 42), packed in order into `drawn`.
 * @returns How many were kept.
 */
export function cullMeshes(
  records: Float32Array,
  count: number,
  sphere: ArrayLike<number>,
  frame: Float32Array,
  drawn: Float32Array,
  test?: (records: Float32Array, at: number, frame: Float32Array) => boolean,
): number {
  let kept = 0;
  for (let i = 0; i < count; i++)
    if (keeps(records, i * 24, sphere, frame) && (!test || test(records, i * 24, frame)))
      drawn.set(records.subarray(i * 24, i * 24 + 24), kept++ * 24);
  return kept;
}

/** Whether the record at float `at` of `m` passes `CulledMeshes`' frustum and screen-size test (see cullMeshes). */
function keeps(m: Float32Array, at: number, sphere: ArrayLike<number>, frame: Float32Array): boolean {
  const x = sphere[0],
    y = sphere[1],
    z = sphere[2];
  const cx = m[at] * x + m[at + 4] * y + m[at + 8] * z + m[at + 12],
    cy = m[at + 1] * x + m[at + 5] * y + m[at + 9] * z + m[at + 13],
    cz = m[at + 2] * x + m[at + 6] * y + m[at + 10] * z + m[at + 14];
  // sqrt(norm1 * normInf) of the 3x3, as core's kernel bounds the radius.
  const cols = Math.max(
      Math.abs(m[at]) + Math.abs(m[at + 1]) + Math.abs(m[at + 2]),
      Math.abs(m[at + 4]) + Math.abs(m[at + 5]) + Math.abs(m[at + 6]),
      Math.abs(m[at + 8]) + Math.abs(m[at + 9]) + Math.abs(m[at + 10]),
    ),
    rows = Math.max(
      Math.abs(m[at]) + Math.abs(m[at + 4]) + Math.abs(m[at + 8]),
      Math.abs(m[at + 1]) + Math.abs(m[at + 5]) + Math.abs(m[at + 9]),
      Math.abs(m[at + 2]) + Math.abs(m[at + 6]) + Math.abs(m[at + 10]),
    );
  let r = sphere[3] * Math.sqrt(cols * rows);
  r += 1e-5 * (Math.hypot(cx, cy, cz) + r);
  for (let p = 16; p < 40; p += 4)
    if (frame[p] * cx + frame[p + 1] * cy + frame[p + 2] * cz + frame[p + 3] < -r) return false;
  const w = frame[3] * cx + frame[7] * cy + frame[11] * cz + frame[15],
    least = frame[42];
  return least <= 0 || w <= r || (r * frame[41]) / w >= least;
}

/** `CulledInstances`' route: culls its parts on the CPU each frame and uploads the kept records and the arguments. */
export function instancesRoute(lists: PartLists, args: Uint32Array, batches: number) {
  const drawn = new Float32Array(lists.count * 24),
    kept = new Uint32Array(batches);
  return (device: GPUDevice, buffers: Record<string, GPUBuffer>, planes: Planes, cull: boolean): void => {
    cullParts(lists, planes, cull, drawn, args, kept);
    lists.starts.forEach((start, i) => {
      if (kept[i])
        device.queue.writeBuffer(
          buffers.drawn,
          start * 96,
          drawn as Float32Array<ArrayBuffer>,
          start * 24,
          kept[i] * 24,
        );
    });
    device.queue.writeBuffer(buffers.args, 0, args as Uint32Array<ArrayBuffer>);
  };
}

/** `CulledMeshes`' route: culls one core batch on the CPU and uploads its kept records and draw arguments. */
export function meshesRoute() {
  let packed = new Float32Array(0);
  const args = new Uint32Array(5);
  return (
    device: GPUDevice,
    batch: {
      instances: Float32Array;
      count: number;
      geometry: { bounds: ArrayLike<number>; indices: ArrayLike<number>; vertices: Float32Array };
    },
    drawn: GPUBuffer,
    argsBuffer: GPUBuffer,
    frame: Float32Array,
    test?: import('./shape.js').CullShape['cpu'],
  ): void => {
    if (packed.length < batch.count * 24) packed = new Float32Array(batch.count * 48);
    const kept = cullMeshes(
      batch.instances,
      batch.count,
      batch.geometry.bounds,
      frame,
      packed,
      test ? (records, at, frame) => test(records, at, batch.geometry.vertices, 6, 0, frame) : undefined,
    );
    if (kept) device.queue.writeBuffer(drawn, 0, packed as Float32Array<ArrayBuffer>, 0, kept * 24);
    args[0] = batch.geometry.indices.length;
    args[1] = kept;
    device.queue.writeBuffer(argsBuffer, 0, args);
  };
}

/**
 * `DynamicInstances`' route: its cull kernel on the CPU from the rows it keeps there. Every live, shown, finite row's
 * 96-byte record goes to `world` (shadows and picking read it; other rows are zero), the kept ones in index order to
 * `drawn`, and the count to the indirect arguments. `part` is the kernel's uniform as floats (count and index count
 * as words at 0 and 1, sphere at 4, factors at 8, material colour at 12).
 */
export function dynamicRoute(capacity: number) {
  const world = new Float32Array(capacity * 24),
    drawn = new Float32Array(capacity * 24),
    args = new Uint32Array(5);
  let states: Uint32Array | undefined;
  return (
    device: GPUDevice,
    high: number,
    matrices: Float32Array,
    tints: Float32Array,
    buffers: { world: GPUBuffer; drawn: GPUBuffer; args: GPUBuffer },
    frame: Float32Array,
    part: Float32Array,
    sphere: Float32Array,
    indices: number,
    test?: (records: Float32Array, at: number, frame: Float32Array) => boolean,
  ): void => {
    // The state word of each row shares the tints' buffer (Uint32 view, made once).
    if (states?.buffer !== tints.buffer) states = new Uint32Array(tints.buffer, tints.byteOffset, tints.length);
    let kept = 0;
    for (let i = 0; i < high; i++) {
      const at = i * 12,
        out = i * 24;
      let ok = states[i * 4 + 3] === 1;
      for (let j = 0; ok && j < 12; j++) ok = Number.isFinite(matrices[at + j]);
      if (!ok) {
        world.fill(0, out, out + 24);
        continue;
      }
      for (let c = 0; c < 4; c++) {
        world[out + c * 4] = matrices[at + c * 3];
        world[out + c * 4 + 1] = matrices[at + c * 3 + 1];
        world[out + c * 4 + 2] = matrices[at + c * 3 + 2];
        world[out + c * 4 + 3] = c === 3 ? 1 : 0;
      }
      for (let k = 0; k < 3; k++) world[out + 16 + k] = part[12 + k] * tints[i * 4 + k];
      world[out + 19] = 1;
      for (let k = 0; k < 4; k++) world[out + 20 + k] = part[8 + k];
      if (keeps(world, out, sphere, frame) && (!test || test(world, out, frame))) {
        // A loop, not set(subarray): a view per kept row would be garbage every frame.
        for (let k = 0; k < 24; k++) drawn[kept * 24 + k] = world[out + k];
        kept++;
      }
    }
    if (high) device.queue.writeBuffer(buffers.world, 0, world as Float32Array<ArrayBuffer>, 0, high * 24);
    if (kept) device.queue.writeBuffer(buffers.drawn, 0, drawn as Float32Array<ArrayBuffer>, 0, kept * 24);
    args[0] = indices;
    args[1] = kept;
    device.queue.writeBuffer(buffers.args, 0, args);
  };
}
