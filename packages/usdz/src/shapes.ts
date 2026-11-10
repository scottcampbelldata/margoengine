import {
  boxGeometry,
  sphereGeometry,
  cylinderGeometry,
  coneGeometry,
  capsuleGeometry,
} from '@margoengine/geometry/primitives';
import { LoaderError } from '@margoengine/loaders/common';
import type { ExtensionHooks, USDExtension } from './extension.js';
import type { TimeSamples } from './crate.js';

/** Resolution of the optional implicit-shape tessellator. */
export interface ShapeOptions {
  /** Segments around a surface, integer 4..256, divisible by four. Default 32. */
  radialSegments?: number;
  /** Sphere latitude segments; capsule uses half per hemisphere. Even integer 2..128. Default 16. */
  latitudeSegments?: number;
}

/** Tessellate USD Cube, Sphere, Cylinder, Capsule and Cone prims with normals, UVs and closed ends. */
export function implicitShapes(options: ShapeOptions = {}): USDExtension {
  const radial = options.radialSegments ?? 32,
    latitude = options.latitudeSegments ?? 16;
  if (!Number.isInteger(radial) || radial < 4 || radial > 256 || radial % 4)
    throw new RangeError('radialSegments must be divisible by four, from 4 to 256');
  if (!Number.isInteger(latitude) || latitude < 2 || latitude > 128 || latitude % 2)
    throw new RangeError('latitudeSegments must be even, from 2 to 128');
  const hook: ExtensionHooks & { options: ShapeOptions } = {
    name: 'shapes',
    options,
    prepare({ specs, maxTriangles, maxVertices, signal }) {
      let total = 0;
      for (const [path, spec] of Object.entries(specs)) {
        const kind = spec.fields.typeName;
        if (spec.specType !== 6 || !['Cube', 'Sphere', 'Cylinder', 'Capsule', 'Cone'].includes(String(kind))) continue;
        signal?.throwIfAborted();
        const get = (name: string, fallback: unknown): unknown => {
          const f = specs[path + '.' + name]?.fields,
            samples = f?.timeSamples as TimeSamples | undefined;
          return (samples?.times.length ? samples.values[0] : f?.default) ?? fallback;
        };
        const dimension = (name: string, fallback: number) => {
          const v = get(name, fallback);
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
            throw new LoaderError('USD', 'syntax', `invalid ${kind} ${name}; use a finite nonnegative dimension`);
          return v;
        };
        const axis = get('axis', 'Z');
        if (!['X', 'Y', 'Z'].includes(String(axis)))
          throw new LoaderError('USD', 'syntax', 'invalid shape axis; use X, Y or Z');
        const count =
          kind === 'Cube'
            ? 12
            : kind === 'Sphere'
              ? 2 * radial * (latitude - 1)
              : kind === 'Capsule'
                ? 2 * radial * latitude
                : kind === 'Cylinder'
                  ? 4 * radial
                  : 2 * radial;
        total += count;
        if (total > maxTriangles || total * 3 > maxVertices)
          throw new LoaderError(
            'USD',
            'limit',
            'implicit shape geometry budget exceeded; lower tessellation resolution or raise limits',
          );
        const radius = dimension('radius', kind === 'Capsule' ? 0.5 : 1),
          height = dimension('height', kind === 'Capsule' ? 1 : 2),
          size = dimension('size', 2);
        const g =
          kind === 'Cube'
            ? boxGeometry(size, size, size)
            : kind === 'Sphere'
              ? sphereGeometry(radius, radial, latitude)
              : kind === 'Cylinder'
                ? cylinderGeometry(radius, radius, height, radial)
                : kind === 'Cone'
                  ? coneGeometry(radius, height, radial)
                  : capsuleGeometry(radius, height, latitude / 2, radial);
        // Geometry's axial primitives point along +Y; USD defaults to +Z. Proper rotations preserve winding.
        if (kind !== 'Cube' && kind !== 'Sphere' && axis !== 'Y')
          for (const stream of [g.positions, g.normals])
            if (stream)
              for (let i = 0; i < stream.length; i += 3) {
                const x = stream[i],
                  y = stream[i + 1],
                  z = stream[i + 2];
                if (axis === 'Z') {
                  stream[i + 1] = -z;
                  stream[i + 2] = y;
                } else {
                  stream[i] = y;
                  stream[i + 1] = -x;
                }
              }
        spec.fields = { ...spec.fields, typeName: 'Mesh' };
        const set = (name: string, typeName: string, value: unknown, extra: object = {}) => {
          specs[path + '.' + name] = { specType: 1, fields: { typeName, default: value, ...extra } };
        };
        set('subdivisionScheme', 'token', 'none');
        set('points', 'point3f[]', g.positions);
        set('faceVertexCounts', 'int[]', new Uint32Array(g.indices.length / 3).fill(3));
        set('faceVertexIndices', 'int[]', g.indices);
        set('normals', 'normal3f[]', Array.from(g.normals!), { interpolation: 'vertex' });
        if (!specs[path + '.primvars:st']) set('primvars:st', 'texCoord2f[]', g.uvs, { interpolation: 'vertex' });
      }
    },
  };
  return hook;
}
