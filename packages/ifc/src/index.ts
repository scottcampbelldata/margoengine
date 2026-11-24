/// <reference lib="esnext.disposable" preserve="true" />
import type { IfcAPI } from 'web-ifc';
import { computeVertexNormals, type LoadedGeometry, type LoadedGroup, type ParseLimits } from '@margoengine/loaders/common';
import { checkAbort, checkModel, fail, native, openIFC, type IFCModel, type IFCOpenOptions } from './open.js';

export { openIFC, type IFCModel, type IFCOpenOptions } from './open.js';

/** Options of readIFCGeometry: vertex and triangle limits, an AbortSignal and the origin to rebase onto. */
export interface IFCGeometryOptions extends ParseLimits {
  signal?: AbortSignal;
  /**
   * World point subtracted from every vertex in float64 before it is stored as float32, so georeferenced models with
   * coordinates in the hundreds of kilometres keep millimetre precision. `'auto'` takes the first placement's
   * translation rounded to whole metres. Default: none (model coordinates). Engine axes: Y up, meters.
   */
  origin?: 'auto' | readonly [number, number, number];
}
/** Options of parseIFC: openIFC's options plus readIFCGeometry's. */
export interface IFCOptions extends IFCOpenOptions, IFCGeometryOptions {}
/** One IFC product: its express ID, type, optional GlobalId and name. */
export interface IFCProduct {
  expressID: number;
  type: string;
  globalId?: string;
  name?: string;
}
/** The geometry parseIFC returns, with the IFC schema name and the list of products. */
export interface IFCResult extends LoadedGeometry {
  kind: 'mesh';
  schema: string;
  products: IFCProduct[];
  /** The point subtracted from every vertex (engine axes, meters); [0, 0, 0] unless `origin` was set. */
  origin: [number, number, number];
}

/** Reads geometry in meters using an initialized, caller-owned web-ifc API. The opened model is always closed. */
export function parseIFC(api: IfcAPI, data: Uint8Array, options: IFCOptions = {}): IFCResult {
  checkLimits(options);
  const model = openIFC(api, data, options);
  try {
    return readIFCGeometry(model, options);
  } finally {
    model.close();
  }
}

function checkLimits(options: IFCGeometryOptions) {
  for (const value of [options.maxVertices ?? 0, options.maxTriangles ?? 0, (options as IFCOpenOptions).maxBytes ?? 0])
    if (!Number.isSafeInteger(value) || value < 0) fail('range', 'limits must be non-negative integers');
  const origin = options.origin;
  if (origin !== undefined && origin !== 'auto' && !(Array.isArray(origin) && origin.length === 3 && origin.every(Number.isFinite)))
    fail('range', "origin must be 'auto' or three finite numbers");
}

/**
 * Reads every product's triangles from an open model into one LoadedGeometry: world-space meters (engine axes,
 * Y up), one named, coloured group per placed geometry with the element's expressID in `objectId`, reflected
 * winding corrected and normals computed. The model stays open.
 */
export function readIFCGeometry(model: IFCModel, options: IFCGeometryOptions = {}): IFCResult {
  checkModel(model);
  checkLimits(options);
  const { api, id } = model;
  const maxVertices = options.maxVertices ?? 8_000_000,
    maxTriangles = options.maxTriangles ?? 16_000_000;
  checkAbort(options.signal);
  const positions: number[] = [],
    indices: number[] = [],
    groups: LoadedGroup[] = [],
    products: IFCProduct[] = [];
  let origin: [number, number, number] | undefined = Array.isArray(options.origin)
    ? [options.origin[0], options.origin[1], options.origin[2]]
    : options.origin === 'auto'
      ? undefined
      : [0, 0, 0];
  let failure: unknown;
  native('reading meshes', () =>
    api.StreamAllMeshes(
      id,
      (mesh) => {
        if (failure) return;
        try {
          checkAbort(options.signal);
          const line = api.GetLine(id, mesh.expressID),
            type = api.GetNameFromTypeCode(api.GetLineType(id, mesh.expressID));
          const product: IFCProduct = { expressID: mesh.expressID, type };
          if (typeof line?.GlobalId?.value === 'string') product.globalId = line.GlobalId.value;
          if (typeof line?.Name?.value === 'string') product.name = line.Name.value;
          products.push(product);
          for (let part = 0; part < mesh.geometries.size(); part++) {
            const placed = mesh.geometries.get(part),
              geometry = api.GetGeometry(id, placed.geometryExpressID);
            try {
              const vertices = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize()),
                faces = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
              if (vertices.length % 6 || faces.length % 3) fail('range', 'invalid geometry layout; export the file again');
              const count = vertices.length / 6,
                base = positions.length / 3,
                start = indices.length,
                m = placed.flatTransformation;
              if (base + count > maxVertices || start / 3 + faces.length / 3 > maxTriangles)
                fail('limit', 'geometry exceeds vertex or triangle limit; raise maxVertices or maxTriangles');
              const det = checkPlacement(m);
              origin ??= [Math.round(m[12]), Math.round(m[13]), Math.round(m[14])];
              for (let v = 0; v < count; v++) {
                const x = vertices[v * 6],
                  y = vertices[v * 6 + 1],
                  z = vertices[v * 6 + 2];
                for (let r = 0; r < 3; r++) {
                  const value = Math.fround(m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r] - origin[r]);
                  if (!Number.isFinite(value)) fail('range', 'non-finite vertex; export the file again');
                  positions.push(value);
                }
              }
              for (let f = 0; f < faces.length; f += 3) {
                const a = faces[f],
                  b = faces[f + 1],
                  c = faces[f + 2];
                if (a >= count || b >= count || c >= count) fail('range', 'index outside geometry; export the file again');
                indices.push(base + a, base + (det < 0 ? c : b), base + (det < 0 ? b : c));
              }
              const color = checkColor(placed.color);
              if (faces.length)
                groups.push({
                  start,
                  count: faces.length,
                  objectId: String(mesh.expressID),
                  name: product.name ?? `${type} #${mesh.expressID}`,
                  color,
                });
            } finally {
              geometry.delete();
            }
          }
        } catch (error) {
          failure = error;
        }
      },
      true,
    ),
  );
  if (failure)
    native('reading a mesh', () => {
      throw failure;
    });
  checkAbort(options.signal);
  if (!indices.length) fail('unsupported', 'model contains no renderable triangles; check it has body representations');
  const points = new Float32Array(positions),
    triangles = new Uint32Array(indices);
  return {
    kind: 'mesh',
    positions: points,
    indices: triangles,
    normals: computeVertexNormals(points, triangles),
    groups,
    products,
    schema: model.schema,
    origin: origin ?? [0, 0, 0],
  };
}

/** Checks a column-major affine placement and returns its determinant. */
export function checkPlacement(m: ArrayLike<number>): number {
  if (
    m.length !== 16 ||
    !Array.prototype.every.call(m, Number.isFinite) ||
    m[3] !== 0 ||
    m[7] !== 0 ||
    m[11] !== 0 ||
    m[15] !== 1
  )
    fail('range', 'invalid affine placement; export the file again');
  const det =
    m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (!Number.isFinite(det) || det === 0) fail('range', 'singular placement; export the file again');
  return det;
}

/** Checks a web-ifc surface colour and returns it as RGBA in 0..1. */
export function checkColor({ x, y, z, w }: { x: number; y: number; z: number; w: number }): [number, number, number, number] {
  const color: [number, number, number, number] = [x, y, z, w];
  if (color.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) fail('range', 'invalid surface color; export the file again');
  return color;
}
