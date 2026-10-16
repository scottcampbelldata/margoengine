import type { MorphData } from '@margoengine/exporters';
import { array, findChild, id, property, objectName, type FBXNode } from './document.js';
import { inverse } from './math.js';
import { children, type SceneContext, type MeshBinding } from './scene.js';

export interface MorphBinding {
  mesh: MeshBinding;
  channels: bigint[];
}
interface ShapeData {
  cpCount: number;
  lookup: Int32Array;
  positions: ArrayLike<number>;
  normals?: ArrayLike<number>;
}
const lookups = new WeakMap<SceneContext, Map<FBXNode, ShapeData>>();
export function attachMorphs(ctx: SceneContext, mesh: MeshBinding): MorphBinding | undefined {
  const shapes = children(ctx, id(mesh.source.properties[0])).filter((n) => n.properties[2] === 'BlendShape'),
    targets: MorphData[] = [],
    channels: bigint[] = [],
    weights: number[] = [];
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
      const full = findChild(channel, 'FullWeights');
      // Blender also emits one all-100 FullWeights value per affected control point.
      if (sources.length !== 1) throw new TypeError(`Unsupported FBX progressive morph: ${objectName(channel)}`);
      if (full) {
        const values = array(channel, 'FullWeights');
        ctx.budget.work(values.length);
        for (let i = 0; i < values.length; i++)
          if (!Number.isFinite(values[i]) || Math.abs(values[i] - 100) > 1e-6)
            throw new TypeError(`Unsupported FBX progressive morph: ${objectName(channel)}`);
      }
      if (targets.length >= 256) throw new RangeError('FBX morph target budget exceeded');
      const shape = sources[0];
      let data = cache.get(shape);
      if (!data) {
        const indices = array(shape, 'Indexes'),
          positions = array(shape, 'Vertices'),
          normalNode = findChild(shape, 'Normals'),
          normals = normalNode ? array(shape, 'Normals') : undefined;
        if (positions.length !== indices.length * 3 || (normals && normals.length !== positions.length))
          throw new RangeError('FBX morph delta count mismatch');
        if (!Number.isSafeInteger(cpCount) || cpCount < 1 || cpCount > 1_000_000)
          throw new RangeError('FBX geometry budget exceeded');
        ctx.budget.reserve(cpCount * 4 + 128);
        ctx.budget.work(cpCount + indices.length * 8);
        const lookup = new Int32Array(cpCount).fill(-1);
        for (let i = 0; i < indices.length; i++) {
          const cp = indices[i];
          if (!Number.isInteger(cp) || cp < 0 || cp >= cpCount || lookup[cp] !== -1)
            throw new RangeError('Invalid FBX morph control point');
          lookup[cp] = i;
          for (let k = 0; k < 3; k++)
            if (!Number.isFinite(positions[i * 3 + k]) || (normals && !Number.isFinite(normals[i * 3 + k])))
              throw new RangeError('Invalid FBX morph delta');
        }
        data = { cpCount, lookup, positions, normals };
        cache.set(shape, data);
      }
      if (data.cpCount !== cpCount) throw new RangeError('Invalid FBX morph control-point count');
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
          throw new RangeError('FBX morph position overflow');
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
          if (!length || !Number.isFinite(length)) throw new RangeError('Invalid FBX morph normal transform');
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
            throw new RangeError('FBX morph normal overflow');
        }
      }
      const weight = Number(property(channel, 'DeformPercent', 0)) / 100;
      if (!Number.isFinite(weight)) throw new RangeError('Invalid FBX morph weight');
      ctx.budget.reserve(128);
      targets.push({ name: objectName(channel), positions: out, normals: normalOut });
      weights.push(weight);
      channels.push(id(channel.properties[0]));
    }
  if (!targets.length) return;
  mesh.geometry.morphs = targets;
  mesh.node.morphWeights = weights;
  return { mesh, channels };
}
