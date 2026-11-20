import type { MorphData } from '@margoengine/exporters';
import { array, findChild, id, property, objectName, type FBXNode } from './document.js';
import { inverse } from './math.js';
import { children, type SceneContext, type MeshBinding } from './scene.js';

export interface MorphBinding {
  mesh: MeshBinding;
  channels: bigint[];
  /** Each target's weight from its channel's percent. */
  shapes: ((percent: number) => number)[];
  /** A shape weight is not a straight line of the percent, so a curve between two keys needs more keys. */
  stepped: boolean;
}
interface ShapeData {
  cpCount: number;
  lookup: Int32Array;
  positions: ArrayLike<number>;
  normals?: ArrayLike<number>;
}
const lookups = new WeakMap<SceneContext, Map<FBXNode, ShapeData>>();
/** Each control point's area-weighted normal, unnormalized: the Newell normal of every polygon it is a corner of. */
function pointNormals(cpCount: number, polygons: ArrayLike<number>, at: (cp: number, axis: number) => number) {
  const out = new Float64Array(cpCount * 3);
  for (let start = 0; start < polygons.length; ) {
    let end = start;
    while (end < polygons.length && polygons[end] >= 0) end++;
    let x = 0,
      y = 0,
      z = 0;
    for (let i = start; i <= end && i < polygons.length; i++) {
      const a = polygons[i] < 0 ? ~polygons[i] : polygons[i],
        j = i === end || i + 1 >= polygons.length ? start : i + 1,
        b = polygons[j] < 0 ? ~polygons[j] : polygons[j];
      if (a >= cpCount || b >= cpCount) continue;
      x += (at(a, 1) - at(b, 1)) * (at(a, 2) + at(b, 2));
      y += (at(a, 2) - at(b, 2)) * (at(a, 0) + at(b, 0));
      z += (at(a, 0) - at(b, 0)) * (at(a, 1) + at(b, 1));
    }
    for (let i = start; i <= end && i < polygons.length; i++) {
      const cp = polygons[i] < 0 ? ~polygons[i] : polygons[i];
      if (cp >= cpCount) continue;
      out[cp * 3] += x;
      out[cp * 3 + 1] += y;
      out[cp * 3 + 2] += z;
    }
    start = end + 1;
  }
  return out;
}
/**
 * A shape whose normal deltas are not unit-vector differences (Character Creator writes some shapes' normals from
 * memory it never filled: NaN and values near 1e149) takes its normal deltas from its positions instead, as a tool
 * that recomputes normals does: the area-weighted normal of the moved mesh less that of the rest mesh, at every
 * control point whose normal moves, so the neighbours of the moved points turn with them.
 */
function shapeFromPositions(
  ctx: SceneContext,
  source: FBXNode,
  cpCount: number,
  indices: ArrayLike<number>,
  deltas: ArrayLike<number>,
): ShapeData {
  const rest = array(source, 'Vertices'),
    polygons = array(source, 'PolygonVertexIndex'),
    moved = new Float64Array(rest.length);
  ctx.budget.reserve(cpCount * 72 + 128);
  ctx.budget.work(cpCount * 6 + polygons.length * 4);
  moved.set(rest);
  for (let i = 0; i < indices.length; i++)
    for (let k = 0; k < 3; k++) moved[indices[i] * 3 + k] += deltas[i * 3 + k];
  const before = pointNormals(cpCount, polygons, (cp, axis) => rest[cp * 3 + axis]),
    after = pointNormals(cpCount, polygons, (cp, axis) => moved[cp * 3 + axis]),
    turn = new Float64Array(cpCount * 3),
    lookup = new Int32Array(cpCount).fill(-1);
  let count = 0;
  for (let cp = 0; cp < cpCount; cp++) {
    const b = Math.hypot(before[cp * 3], before[cp * 3 + 1], before[cp * 3 + 2]),
      a = Math.hypot(after[cp * 3], after[cp * 3 + 1], after[cp * 3 + 2]);
    if (!b || !a) continue;
    let changed = false;
    for (let k = 0; k < 3; k++) {
      turn[cp * 3 + k] = after[cp * 3 + k] / a - before[cp * 3 + k] / b;
      if (Math.abs(turn[cp * 3 + k]) > 1e-7) changed = true;
    }
    if (changed) lookup[cp] = count++;
  }
  for (let i = 0; i < indices.length; i++) if (lookup[indices[i]] === -1) lookup[indices[i]] = count++;
  const positions = new Float64Array(count * 3),
    normals = new Float64Array(count * 3);
  for (let i = 0; i < indices.length; i++)
    for (let k = 0; k < 3; k++) positions[lookup[indices[i]] * 3 + k] = deltas[i * 3 + k];
  for (let cp = 0; cp < cpCount; cp++)
    if (lookup[cp] !== -1) for (let k = 0; k < 3; k++) normals[lookup[cp] * 3 + k] = turn[cp * 3 + k];
  return { cpCount, lookup, positions, normals };
}
export function attachMorphs(ctx: SceneContext, mesh: MeshBinding): MorphBinding | undefined {
  const shapes = children(ctx, id(mesh.source.properties[0])).filter((n) => n.properties[2] === 'BlendShape'),
    targets: MorphData[] = [],
    channels: bigint[] = [],
    weights: number[] = [],
    shaping: ((percent: number) => number)[] = [],
    entry = ctx.extensions.find((extension) => extension.inbetweens);
  let stepped = false;
  if (!shapes.length) return;
  const cpCount = array(mesh.source, 'Vertices').length / 3,
    m = mesh.geometric;
  if (!mesh.geometricInverse) ctx.budget.reserve(128);
  const inv = mesh.geometricInverse ?? inverse(m);
  let cache = lookups.get(ctx);
  if (!cache) {
    cache = new Map();
    lookups.set(ctx, cache);
  }
  for (const deformer of shapes)
    for (const channel of children(ctx, id(deformer.properties[0])).filter(
      (n) => n.properties[2] === 'BlendShapeChannel',
    )) {
      ctx.signal?.throwIfAborted();
      const sources = children(ctx, id(channel.properties[0])).filter((n) => n.properties[2] === 'Shape');
      const full = findChild(channel, 'FullWeights'),
        values = full ? array(channel, 'FullWeights') : [];
      ctx.budget.work(values.length);
      // Blender also emits one all-100 FullWeights value per affected control point.
      let plain = sources.length === 1;
      for (let i = 0; i < values.length && plain; i++) plain = Math.abs(values[i] - 100) <= 1e-6;
      if (!plain && !entry)
        throw new TypeError(
          `FBX progressive morph: ${objectName(channel)}; pass deformers from @margoengine/fbx/deformers, or bake it in your 3D tool`,
        );
      const stops = plain ? [{ shape: sources[0], percent: 100 }] : entry!.inbetweens!(channel, sources),
        at = stops.map((stop) => stop.percent);
      if (!plain) stepped = true;
      const percent = Number(property(channel, 'DeformPercent', 0));
      if (!Number.isFinite(percent)) throw new RangeError('Invalid FBX morph weight; re-export the file, it looks damaged');
      for (const stop of stops) {
      if (targets.length >= 256)
        throw new RangeError(
          'FBX morph target budget exceeded; simplify or split the scene, the import limits are listed in the README',
        );
      const shape = stop.shape;
      let data = cache.get(shape);
      if (!data) {
        const indices = array(shape, 'Indexes'),
          positions = array(shape, 'Vertices'),
          normalNode = findChild(shape, 'Normals'),
          normals = normalNode ? array(shape, 'Normals') : undefined;
        if (positions.length !== indices.length * 3 || (normals && normals.length !== positions.length))
          throw new RangeError('FBX morph delta count mismatch; re-export the file, it looks damaged');
        if (!Number.isSafeInteger(cpCount) || cpCount < 1 || cpCount > ctx.budget.limits.vertices)
          throw new RangeError(
            'FBX geometry budget exceeded; simplify or split the scene, the import limits are listed in the README',
          );
        ctx.budget.reserve(cpCount * 4 + 128);
        ctx.budget.work(cpCount + indices.length * 8);
        const lookup = new Int32Array(cpCount).fill(-1);
        let normalsValid = true;
        for (let i = 0; i < indices.length; i++) {
          const cp = indices[i];
          if (!Number.isInteger(cp) || cp < 0 || cp >= cpCount || lookup[cp] !== -1)
            throw new RangeError('Invalid FBX morph control point; re-export the file, it looks damaged');
          lookup[cp] = i;
          for (let k = 0; k < 3; k++) {
            if (!Number.isFinite(positions[i * 3 + k]))
              throw new RangeError('Invalid FBX morph delta; re-export the file, it looks damaged');
            // A normal delta is the difference of two unit vectors, so no component passes 2.
            if (normals && !(Math.abs(normals[i * 3 + k]) <= 2)) normalsValid = false;
          }
        }
        data = normalsValid
          ? { cpCount, lookup, positions, normals }
          : shapeFromPositions(ctx, mesh.source, cpCount, indices, positions);
        cache.set(shape, data);
      }
      if (data.cpCount !== cpCount)
        throw new RangeError('Invalid FBX morph control-point count; re-export the file, it looks damaged');
      const { lookup, positions, normals } = data;
      ctx.budget.morph(mesh.controlPoints.length * 12 * (normals ? 2 : 1));
      ctx.budget.work(mesh.controlPoints.length * (normals ? 24 : 8));
      const out = new Float32Array(mesh.controlPoints.length * 3),
        normalOut = normals ? new Float32Array(out.length) : undefined;
      for (let i = 0; i < mesh.controlPoints.length; i++) {
        const source = lookup[mesh.controlPoints[i]];
        if (source === -1) continue;
        const at = source * 3,
          x = positions[at],
          y = positions[at + 1],
          z = positions[at + 2];
        const dst = i * 3;
        out[dst] = m[0] * x + m[4] * y + m[8] * z;
        out[dst + 1] = m[1] * x + m[5] * y + m[9] * z;
        out[dst + 2] = m[2] * x + m[6] * y + m[10] * z;
        if (!Number.isFinite(out[dst]) || !Number.isFinite(out[dst + 1]) || !Number.isFinite(out[dst + 2]))
          throw new RangeError('FBX morph position overflow; scale the model down or move it nearer the origin');
        if (normals && normalOut) {
          const base = mesh.geometry.normals,
            nx = base[dst],
            ny = base[dst + 1],
            nz = base[dst + 2];
          const bx = m[0] * nx + m[1] * ny + m[2] * nz,
            by = m[4] * nx + m[5] * ny + m[6] * nz,
            bz = m[8] * nx + m[9] * ny + m[10] * nz,
            bl = Math.hypot(bx, by, bz);
          const length =
            Math.hypot(
              inv[0] * bx + inv[1] * by + inv[2] * bz,
              inv[4] * bx + inv[5] * by + inv[6] * bz,
              inv[8] * bx + inv[9] * by + inv[10] * bz,
            ) / bl;
          if (!length || !Number.isFinite(length))
            throw new RangeError('Invalid FBX morph normal transform; re-export the file, it looks damaged');
          const a = normals[at],
            c = normals[at + 1],
            d = normals[at + 2];
          normalOut[dst] = (inv[0] * a + inv[1] * c + inv[2] * d) / length;
          normalOut[dst + 1] = (inv[4] * a + inv[5] * c + inv[6] * d) / length;
          normalOut[dst + 2] = (inv[8] * a + inv[9] * c + inv[10] * d) / length;
          if (
            !Number.isFinite(normalOut[dst]) ||
            !Number.isFinite(normalOut[dst + 1]) ||
            !Number.isFinite(normalOut[dst + 2])
          )
            throw new RangeError('FBX morph normal overflow; scale the model down or move it nearer the origin');
        }
      }
      const shaped = plain
        ? (value: number) => value / 100
        : (value: number) => entry!.inbetweenWeight!(at, stop.percent, value);
      ctx.budget.reserve(128);
      targets.push({
        name: plain || stop === stops[stops.length - 1] ? objectName(channel) : `${objectName(channel)} ${stop.percent}`,
        positions: out,
        normals: normalOut,
      });
      weights.push(shaped(percent));
      shaping.push(shaped);
      channels.push(id(channel.properties[0]));
      }
    }
  if (!targets.length) return;
  mesh.geometry.morphs = targets;
  mesh.node.morphWeights = weights;
  return { mesh, channels, shapes: shaping, stepped };
}
