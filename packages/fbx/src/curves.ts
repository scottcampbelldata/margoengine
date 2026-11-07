// FBX NURBS curves and lines as splines on their nodes. The record's fields are the ones real Maya and 3ds Max files carry,
// read against the FbxNurbsCurve class reference; the evaluation is @margoengine/geometry/nurbs.
import { NurbsCurve } from '@margoengine/geometry/nurbs';
import { array, findChild, type FBXNode } from './document.js';
import type { ExtensionHooks, FBXExtension } from './extension.js';
import { fbxGeometricTransform, multiply } from './math.js';
import { children, type SceneContext } from './scene.js';

/** A curve as it travels on a node's `extras.fbxCurve`, in the node's space. */
export interface FBXCurveRecord {
  /** `'Open'`, `'Closed'` or `'Periodic'` from the file, or `'Line'` for a polyline. */
  form: string;
  /** Polynomial degree; 1 for a line. */
  degree: number;
  /** Flat xyz control points; a periodic curve's wrapped ones are included. */
  points: number[];
  /** One per control point. */
  weights: number[];
  knots: number[];
  /** The curve drawn as straight pieces, flat xyz: eight per knot span, or the points of a line. */
  polyline: number[];
}

/** Straight pieces per knot span of the `polyline`. */
const STEPS = 8;

const invalid = (name: string): never => {
  throw new RangeError(`Invalid FBX curve ${name}; re-export the file, it looks damaged`);
};

function moved(ctx: SceneContext, model: FBXNode, values: ArrayLike<number>, stride: number): number[] {
  const m = multiply(ctx.basis, fbxGeometricTransform(model)),
    out: number[] = [];
  ctx.budget.work(values.length);
  for (let i = 0; i + 2 < values.length; i += stride) {
    const x = values[i],
      y = values[i + 1],
      z = values[i + 2];
    out.push(
      m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14],
    );
  }
  return out;
}

function splineRecord(ctx: SceneContext, model: FBXNode, source: FBXNode): FBXCurveRecord {
  const order = Number(findChild(source, 'Order')?.properties[0]),
    form = String(findChild(source, 'Form')?.properties[0] ?? 'Open'),
    raw = array(source, 'Points'),
    knots = Array.from(array(source, 'KnotVector')),
    degree = order - 1,
    given = raw.length / 4;
  if (!Number.isInteger(order) || order < 2 || !Number.isInteger(given) || given < 1) invalid('points');
  // Points hold x, y, z and the weight, not the weighted coordinates: a Max curve on a 40 unit grid keeps 40 at weight 2.5.
  let points = moved(ctx, model, raw, 4),
    weights = Array.from({ length: given }, (_, i) => raw[i * 4 + 3]);
  // A periodic curve may list its loop once: the first points close it.
  const count = knots.length - order;
  if (count > given && count - given < order) {
    const extra = count - given;
    points = [...points, ...points.slice(0, extra * 3)];
    weights = [...weights, ...weights.slice(0, extra)];
  }
  const curve = spline({ form, degree, points, weights, knots, polyline: [] }),
    polyline: number[] = [];
  for (let span = degree; span < knots.length - order; span++) {
    const start = knots[span],
      end = knots[span + 1];
    if (end <= start) continue;
    for (let k = 0; k < STEPS; k++) polyline.push(...curve.evaluate(start + ((end - start) * k) / STEPS));
  }
  polyline.push(...curve.evaluate(curve.end));
  return { form, degree, points, weights, knots, polyline };
}

function lineRecord(ctx: SceneContext, model: FBXNode, source: FBXNode): FBXCurveRecord {
  const all = moved(ctx, model, array(source, 'Points'), 3),
    indices = Array.from(array(source, 'PointsIndex'), (v) => (v < 0 ? -v - 1 : v)),
    polyline: number[] = [];
  for (const i of indices) {
    if (!Number.isInteger(i) || (i + 1) * 3 > all.length) invalid('line index');
    polyline.push(all[i * 3], all[i * 3 + 1], all[i * 3 + 2]);
  }
  const count = polyline.length / 3;
  return {
    form: 'Line',
    degree: 1,
    points: polyline,
    weights: new Array<number>(count).fill(1),
    knots: [0, ...Array.from({ length: count }, (_, i) => i), count - 1],
    polyline,
  };
}

function attach(ctx: SceneContext): boolean {
  let found = false;
  for (const [key, model] of ctx.models)
    for (const source of children(ctx, key)) {
      if (source.name !== 'Geometry' || !['NurbsCurve', 'Line'].includes(String(source.properties[2]))) continue;
      const node = ctx.nodes.get(key)!,
        record = source.properties[2] === 'Line' ? lineRecord(ctx, model, source) : splineRecord(ctx, model, source);
      node.extras = { ...node.extras, fbxCurve: { ...record } };
      found = true;
    }
  return found;
}

/** A spline of a curve record, for paths, tubes and anything else that takes a `Curve`. */
export function spline(record: FBXCurveRecord): NurbsCurve {
  const points: [number, number, number][] = [];
  for (let i = 0; i < record.points.length; i += 3)
    points.push([record.points[i], record.points[i + 1], record.points[i + 2]]);
  return new NurbsCurve({ points, degree: record.degree, knots: record.knots, weights: record.weights });
}

/** The curves of a model, by node name, from `model.extras()`. */
export function fbxCurves(
  nodes: readonly { name?: string; extras: Record<string, unknown> }[],
): { name: string | undefined; record: FBXCurveRecord; curve: NurbsCurve }[] {
  return nodes
    .filter((node) => node.extras.fbxCurve)
    .map((node) => {
      const record = node.extras.fbxCurve as FBXCurveRecord;
      return { name: node.name, record, curve: spline(record) };
    });
}

/**
 * Reads NURBS curves and lines onto their nodes as `extras.fbxCurve`, with a spline and a polyline each.
 * Pass it in `extensions`: `loadFBX(engine, url, {extensions: [nurbsCurves]})`.
 */
export const nurbsCurves: FBXExtension = { name: 'curves', scene: attach } as ExtensionHooks;
