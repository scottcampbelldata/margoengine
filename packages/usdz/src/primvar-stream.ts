import { LoaderError } from '@margoengine/loaders/common';
import { flat } from './clip.js';
import type { TimeSamples } from './crate.js';
import type { SceneRead, SceneMesh } from './extension.js';

/** Expand a named primvar through indexed topology, triangulation and optional subdivision. */
export function primvarStream(
  read: SceneRead,
  mesh: SceneMesh,
  name: string,
  width: number,
  fallback: number[],
): Float32Array {
  const { specs } = read,
    path = mesh.path,
    prop = 'primvars:' + name;
  const get = (name: string): unknown => {
    const f = specs[path + '.' + name]?.fields,
      s = f?.timeSamples as TimeSamples | undefined;
    return s?.times.length ? s.values[0] : f?.default;
  };
  const authored = get(prop),
    interpolation = String(specs[path + '.' + prop]?.fields.interpolation ?? 'constant'),
    blocked = authored == null || authored === '',
    values = blocked ? fallback : typeof authored === 'number' ? [authored] : flat(authored),
    indices = get(prop + ':indices');
  const ids = indices == null || indices === '' || blocked ? undefined : flat(indices);
  if (values.length % width || values.some((n) => !Number.isFinite(n)))
    throw new LoaderError('USD', 'syntax', 'invalid primvar stream; fix ' + prop);
  if (!['constant', 'uniform', 'vertex', 'varying', 'faceVarying'].includes(interpolation))
    throw new LoaderError('USD', 'syntax', 'unknown primvar interpolation; fix ' + prop);
  const shape = mesh.shape,
    shaped = shape?.corners(values, width, ids, blocked ? 'constant' : interpolation);
  const counts = Array.from(shape?.counts ?? flat(get('faceVertexCounts'))),
    faces = Array.from(shape?.faces ?? flat(get('faceVertexIndices')));
  const out = new Float32Array(mesh.vertexOf.length * width),
    left = get('orientation') === 'leftHanded';
  let cursor = 0,
    at = 0;
  for (let f = 0; f < counts.length; f++) {
    for (let k = 1; k < counts[f] - 1; k++)
      for (let t = 0; t < 3; t++) {
        const corner = cursor + (t === 0 ? 0 : left ? (t === 1 ? k + 1 : k) : t === 1 ? k : k + 1),
          vertex = faces[corner];
        const slot = shaped
          ? corner
          : blocked || interpolation === 'constant'
            ? 0
            : interpolation === 'uniform'
              ? f
              : interpolation === 'faceVarying'
                ? corner
                : vertex;
        const i = shaped ? slot : ids ? ids[slot] : slot,
          stream = shaped ?? values;
        if (!Number.isInteger(i) || i < 0 || (i + 1) * width > stream.length)
          throw new LoaderError('USD', 'syntax', 'primvar index outside stream; fix ' + prop);
        for (let d = 0; d < width; d++) out[at * width + d] = stream[i * width + d];
        at++;
      }
    cursor += counts[f];
  }
  return out;
}
