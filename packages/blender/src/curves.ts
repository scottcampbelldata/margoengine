// @margoengine/blender/curves: the curves, point clouds and volumes a Blender scene exports with "Curves, points and
// volumes" on (header flag 2), as data for the engine's own line, point and volume packages, plus the scene's meshes
// drawn as parseMargo draws them. evaluateSpline turns a spline into the polyline Blender draws at its resolution.
import type { EngineKernel } from "@margoengine/core";
import {
  parsePreparedPBR,
  type PBRModel,
} from "@margoengine/gltf-pro/model";
import { countLimit, checkCount } from "../../shared/limits.js";
import { readResponse } from "../../shared/loading.js";
import {
  decodeImages,
  maxBytes,
  readContainer,
  shapesFlag,
  type MargoSection,
} from "./container.js";
import type { MargoAsset, MargoOptions } from "./index.js";
import { decodeScene } from "./scene.js";

/** Blender's curve types: `catmullRom` (hair's default), `poly`, `bezier` and `nurbs`. */
export type MargoSplineType = "catmullRom" | "poly" | "bezier" | "nurbs";
/** Blender's NURBS knot modes: `normal` (Uniform), `endpoint`, `bezier` and `endpointBezier`. */
export type MargoKnotMode = "normal" | "endpoint" | "bezier" | "endpointBezier";

/** One spline of a curves object, its control points in the object's Y-up metres (views of the file's bytes). */
export interface MargoSpline {
  readonly type: MargoSplineType;
  readonly cyclic: boolean;
  /** Evaluated points per segment, as Blender's resolution. */
  readonly resolution: number;
  /** NURBS order (degree + 1); 0 for other types. */
  readonly order: number;
  /** NURBS knot mode; undefined for other types. */
  readonly knots: MargoKnotMode | undefined;
  /** xyz per control point. */
  readonly positions: Float32Array;
  /** Per control point, in metres; absent when Blender holds no radius attribute. */
  readonly radius: Float32Array | undefined;
  /** Twist per control point, radians. */
  readonly tilt: Float32Array | undefined;
  /** NURBS weight per control point (1 when absent). */
  readonly weight: Float32Array | undefined;
  /** Bezier handles, xyz per control point. */
  readonly handleLeft: Float32Array | undefined;
  readonly handleRight: Float32Array | undefined;
  /** Bezier handle types per control point, Blender's enum: 0 free, 1 auto, 2 vector, 3 aligned. */
  readonly handleTypeLeft: Float32Array | undefined;
  readonly handleTypeRight: Float32Array | undefined;
}
/** What every shape shares: the scene node it hangs on, its name and the node's matrix (column-major). */
export interface MargoShape {
  readonly node: number;
  readonly name: string;
  /** Object to scene: the node's TRS as a column-major 4 x 4 matrix. */
  readonly matrix: Float32Array<ArrayBuffer>;
}
/** A Blender curves object (legacy curve, hair curves or geometry-node curves). */
export interface MargoCurves extends MargoShape {
  readonly splines: readonly MargoSpline[];
}
/** A Blender point cloud: xyz per point, its radius and its first colour attribute (linear RGBA) when it has one. */
export interface MargoPointCloud extends MargoShape {
  readonly positions: Float32Array;
  readonly radius: Float32Array | undefined;
  readonly colors: Float32Array | undefined;
}
/**
 * A Blender volume: the OpenVDB file of its grids, for parseVDB from @margoengine/loaders/vdb. Its grids keep Blender's
 * Z-up object space; `matrix` turns that into the scene's Y-up metres.
 */
export interface MargoVolume extends MargoShape {
  readonly grids: readonly string[];
  readonly vdb: Uint8Array<ArrayBuffer>;
}
/** A decoded shapes file: its meshes (undefined when it has none) and its curves, point clouds and volumes. */
export interface MargoShapes {
  readonly asset: MargoAsset | undefined;
  readonly curves: readonly MargoCurves[];
  readonly points: readonly MargoPointCloud[];
  readonly volumes: readonly MargoVolume[];
}

type Bag = Record<string, unknown>;
const bag = (value: unknown): value is Bag =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const bad = (what: string): never => {
  throw new TypeError(
    `Invalid .margo ${what}; the file is corrupt, so re-export it from Blender with Curves, points and volumes on`,
  );
};
const whole = (value: unknown, lo: number, hi: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= lo && value <= hi;
const types: readonly MargoSplineType[] = ["catmullRom", "poly", "bezier", "nurbs"],
  modes: readonly MargoKnotMode[] = ["normal", "endpoint", "bezier", "endpointBezier"],
  widths: Record<string, number> = {
    position: 3,
    handleLeft: 3,
    handleRight: 3,
    handleTypeLeft: 1,
    handleTypeRight: 1,
    radius: 1,
    tilt: 1,
    weight: 1,
    color: 4,
  };

/** The node's TRS (translation, quaternion xyzw, scale) as a column-major matrix. */
function trs(node: Bag): Float32Array<ArrayBuffer> {
  const [x, y, z] = (node.translation as number[]) ?? [0, 0, 0],
    [qx, qy, qz, qw] = (node.rotation as number[]) ?? [0, 0, 0, 1],
    [sx, sy, sz] = (node.scale as number[]) ?? [1, 1, 1];
  return new Float32Array([
    (1 - 2 * (qy * qy + qz * qz)) * sx, 2 * (qx * qy + qz * qw) * sx, 2 * (qx * qz - qy * qw) * sx, 0,
    2 * (qx * qy - qz * qw) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, 2 * (qy * qz + qx * qw) * sy, 0,
    2 * (qx * qz + qy * qw) * sz, 2 * (qy * qz - qx * qw) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0,
    x, y, z, 1,
  ]);
}

/**
 * Validates and decodes a `.margo` file's curves, point clouds and volumes without a GPU, plus its meshes as
 * decodeMargo does. A static file (no flag 2) decodes too, with no shapes. The arrays are views of the input, so keep
 * the bytes alive and unmodified while the result is used.
 *
 * @example
 * const { curves, points, volumes } = decodeMargoCurves(await (await fetch('/hair.margo')).arrayBuffer());
 * console.log(curves[0]?.splines.length, points[0]?.positions.length);
 */
export function decodeMargoCurves(
  input: ArrayBuffer | ArrayBufferView,
  { maxNodes = 100_000 }: MargoOptions = {},
): MargoShapes {
  countLimit("maxNodes", maxNodes);
  const { buffer, sections, manifest, flags } = readContainer(input, shapesFlag);
  if (!bag(manifest) || !Array.isArray(manifest.nodes)) return bad("scene");
  const doc = manifest,
    nodes = doc.nodes as unknown[];
  checkCount("Too many .margo nodes", nodes.length, maxNodes, "maxNodes");
  const kinds = ["curves", "pointClouds", "volumes"] as const;
  for (const kind of kinds)
    if (doc[kind] !== undefined && (flags !== shapesFlag || !Array.isArray(doc[kind]))) bad(kind);
  const section = (id: unknown, type: number): MargoSection =>
    whole(id, 1, sections.length - 1) && sections[id as number].type === type
      ? sections[id as number]
      : bad("shape section reference");
  const views = (record: Bag, count: number) => {
    const data = section(record.section, 6),
      found: Record<string, Float32Array> = {};
    if (!bag(record.attributes)) return bad("shape attributes");
    for (const [name, view] of Object.entries(record.attributes)) {
      const width = widths[name];
      if (
        !width ||
        !bag(view) ||
        view.components !== width ||
        !whole(view.byteOffset, 0, data.bytes.byteLength) ||
        (view.byteOffset as number) % 4 ||
        (view.byteOffset as number) + count * width * 4 > data.bytes.byteLength
      )
        bad(`shape attribute ${name}`);
      const values = new Float32Array(buffer, data.bytes.byteOffset + (view as Bag & { byteOffset: number }).byteOffset, count * width);
      for (const v of values) if (!Number.isFinite(v)) bad(`shape attribute ${name}`);
      found[name] = values;
    }
    if (!found.position) bad("shape positions");
    return found;
  };
  const owners = new Map<string, number>();
  nodes.forEach((node, index) => {
    if (!bag(node)) return;
    for (const [key, kind] of [["curves", "curves"], ["points", "pointClouds"], ["volume", "volumes"]] as const)
      if (node[key] !== undefined) {
        const list = doc[kind] as unknown[] | undefined;
        if (!list || !whole(node[key], 0, list.length - 1)) bad(`node ${key} reference`);
        owners.set(`${kind}:${node[key]}`, index);
      }
  });
  const shape = (kind: string, index: number) => {
    const node = owners.get(`${kind}:${index}`);
    if (node === undefined) return bad(`${kind} without a node`);
    const owner = nodes[node] as Bag;
    return { node, name: typeof owner.name === "string" ? owner.name : "", matrix: trs(owner) };
  };
  const curves = ((doc.curves as unknown[] | undefined) ?? []).map((record, index): MargoCurves => {
    if (!bag(record) || !whole(record.count, 1, 50_000_000) || !Array.isArray(record.splines) || !record.splines.length)
      return bad("curves");
    const count = record.count as number,
      found = views(record, count);
    let first = 0;
    const splines = record.splines.map((spline): MargoSpline => {
      if (
        !bag(spline) ||
        !types.includes(spline.type as MargoSplineType) ||
        !whole(spline.points, 1, count - first) ||
        typeof spline.cyclic !== "boolean" ||
        !whole(spline.resolution, 1, 1024) ||
        (spline.type === "nurbs"
          ? !whole(spline.order, 2, 64) || !modes.includes(spline.knots as MargoKnotMode)
          : spline.order !== undefined || spline.knots !== undefined)
      )
        bad("spline");
      const n = spline.points as number,
        slice = (name: string) => found[name]?.subarray(first * widths[name], (first + n) * widths[name]);
      if (spline.type === "bezier" && (!found.handleLeft || !found.handleRight)) bad("Bezier handles");
      const result: MargoSpline = {
        type: spline.type as MargoSplineType,
        cyclic: spline.cyclic as boolean,
        resolution: spline.resolution as number,
        order: spline.type === "nurbs" ? (spline.order as number) : 0,
        knots: spline.type === "nurbs" ? (spline.knots as MargoKnotMode) : undefined,
        positions: slice("position")!,
        radius: slice("radius"),
        tilt: slice("tilt"),
        weight: slice("weight"),
        handleLeft: slice("handleLeft"),
        handleRight: slice("handleRight"),
        handleTypeLeft: slice("handleTypeLeft"),
        handleTypeRight: slice("handleTypeRight"),
      };
      first += n;
      return result;
    });
    if (first !== count) bad("spline point counts");
    return { ...shape("curves", index), splines };
  });
  const points = ((doc.pointClouds as unknown[] | undefined) ?? []).map((record, index): MargoPointCloud => {
    if (!bag(record) || !whole(record.count, 1, 50_000_000)) return bad("point cloud");
    const found = views(record, record.count as number);
    return { ...shape("pointClouds", index), positions: found.position, radius: found.radius, colors: found.color };
  });
  const volumes = ((doc.volumes as unknown[] | undefined) ?? []).map((record, index): MargoVolume => {
    if (!bag(record) || !Array.isArray(record.grids) || !record.grids.every((g) => typeof g === "string"))
      return bad("volume");
    return { ...shape("volumes", index), grids: record.grids as string[], vdb: section(record.section, 7).bytes };
  });
  // The meshes: the same scene without the shape records, checked and decoded as decodeMargo does.
  let asset: MargoAsset | undefined;
  if (Array.isArray(doc.meshes) && doc.meshes.length) {
    const plain: Bag = { ...doc, nodes: nodes.map((node) => {
      if (!bag(node)) return node;
      const { curves: _c, points: _p, volume: _v, ...rest } = node;
      return rest;
    }) };
    for (const kind of kinds) delete plain[kind];
    asset = decodeScene(buffer, sections, plain, maxNodes);
  } else if (!curves.length && !points.length && !volumes.length) bad("scene: it has no meshes, curves, points or volumes");
  return { asset, curves, points, volumes };
}

/** Appends the cubic Bezier p0 p1 p2 p3 at t to `out`. */
function bezier(out: number[], p: Float32Array, a: number, h1: Float32Array, h2: Float32Array, b: number, t: number) {
  const s = 1 - t;
  for (let axis = 0; axis < 3; axis++)
    out.push(
      s * s * s * p[a * 3 + axis] + 3 * s * s * t * h1[a * 3 + axis] + 3 * s * t * t * h2[b * 3 + axis] + t * t * t * p[b * 3 + axis],
    );
}

/**
 * The polyline Blender draws for `spline`, xyz per evaluated point in the spline's object space: Bezier and
 * Catmull-Rom splines take `resolution` points per segment (a segment whose two handles are vector handles stays one
 * straight step; an open end repeats its end point), NURBS `resolution` points per knot span, poly splines their
 * control points. A cyclic spline does not repeat its first point at the end. NURBS with Bezier knot modes and cyclic
 * NURBS with Endpoint knots are refused by name.
 *
 * @example
 * const line = evaluateSpline(curves[0].splines[0]);
 * lines.add(new Line({ positions: line, width: 2 }));
 */
export function evaluateSpline(spline: MargoSpline): Float32Array<ArrayBuffer> {
  const p = spline.positions,
    n = p.length / 3,
    r = spline.resolution,
    out: number[] = [],
    segments = spline.cyclic ? n : n - 1;
  if (spline.type === "poly" || n === 1) return Float32Array.from(p);
  if (spline.type === "bezier") {
    const left = spline.handleLeft!, right = spline.handleRight!;
    for (let i = 0; i < segments; i++) {
      const b = (i + 1) % n;
      if (spline.handleTypeRight?.[i] === 2 && spline.handleTypeLeft?.[b] === 2) bezier(out, p, i, right, left, b, 0);
      else for (let j = 0; j < r; j++) bezier(out, p, i, right, left, b, j / r);
    }
  } else if (spline.type === "catmullRom") {
    const at = (i: number, axis: number) => {
      if (spline.cyclic) return p[((i + n) % n) * 3 + axis];
      // An open end repeats its end point, as Blender does.
      if (i < 0) return p[axis];
      if (i >= n) return p[(n - 1) * 3 + axis];
      return p[i * 3 + axis];
    };
    for (let i = 0; i < segments; i++)
      for (let j = 0; j < r; j++) {
        const t = j / r, t2 = t * t, t3 = t2 * t;
        for (let axis = 0; axis < 3; axis++) {
          const p0 = at(i - 1, axis), p1 = at(i, axis), p2 = at(i + 1, axis), p3 = at(i + 2, axis);
          out.push(0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t3));
        }
      }
  } else {
    const k = spline.order;
    if (spline.knots === "bezier" || spline.knots === "endpointBezier")
      throw new RangeError(
        "evaluateSpline does not evaluate NURBS with Bezier knots yet; set the spline's knot mode to Uniform or Endpoint in Blender",
      );
    if (spline.cyclic && spline.knots === "endpoint")
      throw new RangeError(
        "evaluateSpline does not evaluate a cyclic NURBS with Endpoint knots yet; set its knot mode to Uniform in Blender",
      );
    if (n < k)
      throw new RangeError(`A NURBS spline of order ${k} needs at least ${k} points; lower its order in Blender`);
    const count = spline.cyclic ? n + k - 1 : n,
      knots = new Float64Array(count + k);
    for (let i = 0; i < knots.length; i++)
      knots[i] = spline.knots === "endpoint" ? Math.min(Math.max(i - k + 1, 0), n - k + 1) : i;
    const start = knots[k - 1], end = knots[count], samples = spline.cyclic ? r * n : r * (n - k + 1) + 1,
      w = new Float64Array(k * 4);
    for (let j = 0; j < samples; j++) {
      const u = start + ((end - start) * j) / (spline.cyclic ? samples : samples - 1);
      let s = k - 1;
      while (s < count - 1 && u >= knots[s + 1]) s++;
      // de Boor on homogeneous points (x w, y w, z w, w).
      for (let i = 0; i < k; i++) {
        const c = (s - k + 1 + i) % n, weight = spline.weight?.[c] ?? 1;
        for (let axis = 0; axis < 3; axis++) w[i * 4 + axis] = p[c * 3 + axis] * weight;
        w[i * 4 + 3] = weight;
      }
      for (let level = 1; level < k; level++)
        for (let i = k - 1; i >= level; i--) {
          const at = s - k + 1 + i, span = knots[at + k - level] - knots[at],
            a = span ? (u - knots[at]) / span : 0;
          for (let c = 0; c < 4; c++) w[i * 4 + c] = (1 - a) * w[(i - 1) * 4 + c] + a * w[i * 4 + c];
        }
      const h = (k - 1) * 4;
      out.push(w[h] / w[h + 3], w[h + 1] / w[h + 3], w[h + 2] / w[h + 3]);
    }
    return new Float32Array(out);
  }
  if (!spline.cyclic) out.push(p[(n - 1) * 3], p[(n - 1) * 3 + 1], p[(n - 1) * 3 + 2]);
  return new Float32Array(out);
}

/** Options of parseMargoCurves and loadMargoCurves. */
export interface MargoCurvesOptions extends MargoOptions {
  /** Rejects with its reason and closes any decoded images. */
  signal?: AbortSignal;
}
/** parseMargoCurves' result: the meshes' model (undefined without meshes) and the shapes to hand to other packages. */
export interface MargoCurvesScene extends Omit<MargoShapes, "asset"> {
  readonly model: PBRModel | undefined;
}

/**
 * Decodes `.margo` bytes like decodeMargoCurves and attaches the meshes to `engine` as parseMargo does (WebGPU only);
 * the curves, point clouds and volumes come back as data for @margoengine/lines, @margoengine/points and
 * @margoengine/loaders/vdb.
 *
 * @example
 * const { model, curves, points, volumes } = await parseMargoCurves(engine, await file.arrayBuffer(), { signal });
 */
export async function parseMargoCurves(
  engine: EngineKernel,
  input: ArrayBuffer | ArrayBufferView,
  { signal, maxNodes }: MargoCurvesOptions = {},
): Promise<MargoCurvesScene> {
  signal?.throwIfAborted();
  const { asset, ...shapes } = decodeMargoCurves(input, { maxNodes });
  if (!asset) return { model: undefined, ...shapes };
  const images = await decodeImages(asset.images, signal);
  try {
    signal?.throwIfAborted();
    const model = parsePreparedPBR(engine, asset.document, asset.geometry, images, { maxNodes });
    return { model, ...shapes };
  } catch (error) {
    for (const image of images) image.close();
    throw error;
  }
}

/**
 * Fetches a .margo file over HTTP(S) through `fetch` (default `globalThis.fetch`) and parses it like parseMargoCurves.
 *
 * @example
 * const scene = await loadMargoCurves(engine, '/hair.margo', { signal: AbortSignal.timeout(10_000) });
 */
export async function loadMargoCurves(
  engine: EngineKernel,
  url: string | URL,
  { fetch: get = globalThis.fetch, ...options }: MargoCurvesOptions & { fetch?: typeof fetch } = {},
): Promise<MargoCurvesScene> {
  options.signal?.throwIfAborted();
  const target = new URL(url, globalThis.location?.href);
  if (!["http:", "https:"].includes(target.protocol))
    throw new TypeError(
      ".margo URL must use HTTP(S); pass an http: or https: URL, or read the file yourself and call parseMargoCurves",
    );
  const bytes = await readResponse(await get(target, { signal: options.signal }), {
    maxBytes,
    signal: options.signal,
    label: ".margo download",
  });
  return parseMargoCurves(engine, bytes, options);
}
