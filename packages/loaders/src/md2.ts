// Quake II .md2 models: skins, texture coordinates, triangles and compressed vertex frames.
import { computeVertexNormals } from './normals.js';
import { LoaderError, type LoadedGeometry, type ParseLimits } from './types.js';
import { CornerWelder, latin1, limits, toBytes, type BinaryInput } from './util.js';

const F = 'MD2';
const HEADER = 68;

/** Options of {@link parseMD2}: the shared size limits. `maxVertices` counts vertices of all frames together. */
export interface MD2Options extends ParseLimits {}

/** One frame of {@link MD2Model.frames}, with the same vertices and triangles as the first. */
export interface MD2Frame {
  name: string;
  positions: Float32Array;
  normals: Float32Array;
}

/** One run of frames that share a name, such as `run1` to `run6`. */
export interface MD2Clip {
  name: string;
  /** First frame. */
  start: number;
  /** Frames in the clip. */
  count: number;
}

/** What {@link parseMD2} returns: the first frame as a mesh, and every frame beside it. Coordinates are the file's, Z up. */
export interface MD2Model extends LoadedGeometry {
  kind: 'mesh';
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  frames: MD2Frame[];
  clips: MD2Clip[];
  /** The skin paths the file names; `loadTextures` from `@margoengine/loaders/textures` reads them. */
  skins: string[];
}

function text(bytes: Uint8Array, start: number, size: number): string {
  let end = start;
  while (end < start + size && bytes[end]) end++;
  return latin1(bytes, start, end);
}

/**
 * Reads a Quake II `.md2` model. Corners that share a vertex but not a texture coordinate become separate vertices, so
 * every frame has the same layout as the mesh and frames can be blended as morph targets. Frames with one name and a
 * running number form a clip. Normals are computed from each frame's triangles. The GL command list is not needed.
 * `loadTextures` from `@margoengine/loaders/textures` reads the skins, and `parsePCX` from `@margoengine/decoders/pcx`
 * decodes the PCX files Quake II uses.
 *
 * @param input The file's bytes.
 * @param options The shared size limits.
 * @returns The first frame as a mesh, with `frames`, `clips` and `skins`.
 * @throws LoaderError with code `header`, `truncated`, `range` or `limit`.
 *
 * @example
 * ```ts
 * import { parseMD2 } from '@margoengine/loaders/md2';
 *
 * const bytes = await (await fetch('/models/knight.md2')).arrayBuffer();
 * const { frames, clips, skins } = parseMD2(bytes);
 * console.log(frames.length, clips[0]?.name, skins[0]);
 * ```
 */
export function parseMD2(input: BinaryInput, options: MD2Options = {}): MD2Model {
  const bytes = toBytes(input, F),
    { maxVertices, maxTriangles } = limits(options, F);
  if (bytes.length < HEADER) throw new LoaderError(F, 'header', 'the file is too small');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    int = (index: number): number => view.getInt32(index * 4, true);
  if (latin1(bytes, 0, 4) !== 'IDP2') throw new LoaderError(F, 'header', 'missing the IDP2 magic');
  if (int(1) !== 8) throw new LoaderError(F, 'header', `version ${int(1)} is not 8`);
  const skinWidth = int(2),
    skinHeight = int(3),
    frameSize = int(4),
    skinCount = int(5),
    vertexCount = int(6),
    coordCount = int(7),
    triangleCount = int(8),
    frameCount = int(10),
    skinsAt = int(11),
    coordsAt = int(12),
    trianglesAt = int(13),
    framesAt = int(14);
  for (const count of [skinCount, vertexCount, coordCount, triangleCount, frameCount])
    if (count < 0) throw new LoaderError(F, 'header', `negative count ${count}`);
  if (skinWidth <= 0 || skinHeight <= 0) throw new LoaderError(F, 'range', 'the skin size must be positive');
  if (!frameCount) throw new LoaderError(F, 'range', 'the model has no frames');
  if (frameSize < 40 + vertexCount * 4) throw new LoaderError(F, 'range', `frame size ${frameSize} is too small`);
  if (triangleCount > maxTriangles)
    throw new LoaderError(F, 'limit', `triangle count ${triangleCount} exceeds the limit of ${maxTriangles}`);
  const within = (at: number, size: number, what: string): void => {
    if (at < HEADER || at + size > bytes.length) throw new LoaderError(F, 'truncated', `${what} run past the file`);
  };
  within(skinsAt, skinCount * 64, 'skins');
  within(coordsAt, coordCount * 4, 'texture coordinates');
  within(trianglesAt, triangleCount * 12, 'triangles');
  within(framesAt, frameCount * frameSize, 'frames');

  const skins: string[] = [];
  for (let i = 0; i < skinCount; i++) skins.push(text(bytes, skinsAt + i * 64, 64));

  const welder = new CornerWelder(vertexCount),
    indices = new Uint32Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t++)
    for (let k = 0; k < 3; k++) {
      const at = trianglesAt + t * 12,
        vertex = view.getUint16(at + k * 2, true),
        coord = view.getUint16(at + 6 + k * 2, true);
      if (vertex >= vertexCount) throw new LoaderError(F, 'range', `vertex ${vertex} is outside 0..${vertexCount - 1}`);
      if (coord >= coordCount) throw new LoaderError(F, 'range', `coordinate ${coord} is outside 0..${coordCount - 1}`);
      // MD2 front faces wind clockwise: 0, 2, 1 makes them counter-clockwise.
      indices[t * 3 + (3 - k) % 3] = welder.weld(vertex, coord, 0, 0);
    }
  const count = welder.count,
    keys = welder.keys.array;
  if (count * frameCount > maxVertices)
    throw new LoaderError(F, 'limit', `${count * frameCount} frame vertices exceed the limit of ${maxVertices}`);

  const uvs = new Float32Array(count * 2);
  for (let v = 0; v < count; v++) {
    const at = coordsAt + keys[v * 4 + 1] * 4;
    uvs[v * 2] = view.getInt16(at, true) / skinWidth;
    uvs[v * 2 + 1] = view.getInt16(at + 2, true) / skinHeight;
  }

  const frames: MD2Frame[] = [],
    clips: MD2Clip[] = [];
  for (let f = 0; f < frameCount; f++) {
    const at = framesAt + f * frameSize,
      scale = [0, 1, 2].map((i) => view.getFloat32(at + i * 4, true)),
      move = [0, 1, 2].map((i) => view.getFloat32(at + 12 + i * 4, true)),
      name = text(bytes, at + 24, 16),
      positions = new Float32Array(count * 3);
    for (let v = 0; v < count; v++) {
      const from = at + 40 + keys[v * 4] * 4;
      for (let c = 0; c < 3; c++) positions[v * 3 + c] = bytes[from + c] * scale[c] + move[c];
    }
    frames.push({ name, positions, normals: computeVertexNormals(positions, indices) });
    const stem = name.replace(/\d+$/, ''),
      last = clips[clips.length - 1];
    if (last?.name === stem) last.count++;
    else clips.push({ name: stem, start: f, count: 1 });
  }
  const [first] = frames;
  return {
    kind: 'mesh',
    positions: first.positions,
    normals: first.normals,
    uvs,
    indices,
    frames,
    clips,
    skins,
  };
}
