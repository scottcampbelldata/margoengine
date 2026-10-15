import type { IfcAPI, LoaderSettings } from 'web-ifc';
import {
  LoaderError,
  computeVertexNormals,
  type LoadedGeometry,
  type LoadedGroup,
  type ParseLimits,
} from '@margoengine/loaders';

export interface IFCOptions extends ParseLimits {
  maxBytes?: number;
  signal?: AbortSignal;
  /** Native web-ifc settings. Model coordinates are kept unless COORDINATE_TO_ORIGIN is set. */
  settings?: LoaderSettings;
}
export interface IFCProduct {
  expressID: number;
  type: string;
  globalId?: string;
  name?: string;
}
export interface IFCResult extends LoadedGeometry {
  kind: 'mesh';
  schema: string;
  products: IFCProduct[];
}

/** Reads geometry in meters using an initialized, caller-owned web-ifc API. The opened model is always closed. */
export function parseIFC(api: IfcAPI, data: Uint8Array, options: IFCOptions = {}): IFCResult {
  const fail = (code: 'range' | 'limit' | 'header' | 'unsupported' | 'aborted', message: string): never => {
    throw new LoaderError('IFC', code, message);
  };
  const maxVertices = options.maxVertices ?? 8_000_000,
    maxTriangles = options.maxTriangles ?? 16_000_000,
    maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  for (const value of [maxVertices, maxTriangles, maxBytes])
    if (!Number.isSafeInteger(value) || value < 0) fail('range', 'limits must be non-negative integers');
  const aborted = () => {
    if (options.signal?.aborted) fail('aborted', 'aborted');
  };
  aborted();
  if (!(data instanceof Uint8Array)) fail('range', 'expected Uint8Array');
  if (data.byteLength > maxBytes) fail('limit', 'input exceeds maxBytes');
  if (!/^\s*ISO-10303-21;/i.test(new TextDecoder().decode(data.subarray(0, 128))))
    fail('header', 'expected a STEP IFC file');
  const model = api.OpenModel(data, { ALLOW_INCOMPATIBLE_SCHEMA_ALIASES: false, ...options.settings });
  if (model < 0 || !api.IsModelOpen(model)) fail('unsupported', 'web-ifc could not open the model');
  try {
    const positions: number[] = [],
      indices: number[] = [],
      groups: LoadedGroup[] = [],
      products: IFCProduct[] = [];
    let failure: unknown;
    api.StreamAllMeshes(
      model,
      (mesh) => {
        if (failure) return;
        try {
          aborted();
          const line = api.GetLine(model, mesh.expressID),
            type = api.GetNameFromTypeCode(api.GetLineType(model, mesh.expressID));
          const product: IFCProduct = { expressID: mesh.expressID, type };
          if (typeof line?.GlobalId?.value === 'string') product.globalId = line.GlobalId.value;
          if (typeof line?.Name?.value === 'string') product.name = line.Name.value;
          products.push(product);
          for (let part = 0; part < mesh.geometries.size(); part++) {
            const placed = mesh.geometries.get(part),
              geometry = api.GetGeometry(model, placed.geometryExpressID);
            try {
              const vertices = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize()),
                faces = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
              if (vertices.length % 6 || faces.length % 3) fail('range', 'invalid geometry layout');
              const count = vertices.length / 6,
                base = positions.length / 3,
                start = indices.length,
                m = placed.flatTransformation;
              if (base + count > maxVertices || start / 3 + faces.length / 3 > maxTriangles)
                fail('limit', 'geometry exceeds vertex or triangle limit');
              if (
                m.length !== 16 ||
                !m.every(Number.isFinite) ||
                m[3] !== 0 ||
                m[7] !== 0 ||
                m[11] !== 0 ||
                m[15] !== 1
              )
                fail('range', 'invalid affine placement');
              const det =
                m[0] * (m[5] * m[10] - m[6] * m[9]) -
                m[4] * (m[1] * m[10] - m[2] * m[9]) +
                m[8] * (m[1] * m[6] - m[2] * m[5]);
              if (!Number.isFinite(det) || det === 0) fail('range', 'singular placement');
              for (let v = 0; v < count; v++) {
                const x = vertices[v * 6],
                  y = vertices[v * 6 + 1],
                  z = vertices[v * 6 + 2];
                for (let r = 0; r < 3; r++) {
                  const value = Math.fround(m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);
                  if (!Number.isFinite(value)) fail('range', 'non-finite vertex');
                  positions.push(value);
                }
              }
              for (let f = 0; f < faces.length; f += 3) {
                const a = faces[f],
                  b = faces[f + 1],
                  c = faces[f + 2];
                if (a >= count || b >= count || c >= count) fail('range', 'index outside geometry');
                indices.push(base + a, base + (det < 0 ? c : b), base + (det < 0 ? b : c));
              }
              const { x, y, z, w } = placed.color,
                color: [number, number, number, number] = [x, y, z, w];
              if (color.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) fail('range', 'invalid surface color');
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
    );
    if (failure) throw failure;
    aborted();
    if (!indices.length) fail('unsupported', 'model contains no renderable triangles');
    const points = new Float32Array(positions),
      triangles = new Uint32Array(indices);
    return {
      kind: 'mesh',
      positions: points,
      indices: triangles,
      normals: computeVertexNormals(points, triangles),
      groups,
      products,
      schema: api.GetModelSchema(model),
    };
  } finally {
    api.CloseModel(model);
  }
}
