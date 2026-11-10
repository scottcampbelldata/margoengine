// Voxel Max scene archive, from the public vmax data-model documentation only.
import { decodeLZFSE } from '@margoengine/decoders/lzfse';
import { decodePNG } from '@margoengine/decoders/png';
import { readZipDirectory, readZipEntry } from '@margoengine/loaders/common';
import type { Vec3 } from '@margoengine/math';
import { composeMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import { Colors, MAX_MODELS, rgba, view } from './file-colors.js';
import { parsePlist } from './format-plist.js';
import type { VoxelFile, VoxelFileModel } from './formats.js';
import { cellIndex, cellLimit, type GridLimits } from './grid.js';

/** Archive and decoded-payload budgets of {@link parseVMAX}. */
export interface VMAXOptions extends GridLimits {
  /** Maximum total extracted bytes plus decoded plist bytes. Default 256 MiB. */
  maxBytes?: number;
  /** Maximum archive entries. Default 10,000. */
  maxEntries?: number;
  /** Cancels archive reads and checks between objects and compressed blocks. */
  signal?: AbortSignal;
}

/** A VMAX object or group, retaining its hierarchy and local and world transforms. */
export interface VMAXNode {
  id: string;
  parentId?: string;
  name: string;
  /** The node's own hidden flag; ancestor flags remain available through parentId. */
  hidden: boolean;
  /** Column-major local TRS matrix in the file's Y-up axes. */
  matrix: Float64Array;
  /** Parent-composed matrix in file scene units. */
  worldMatrix: Float64Array;
  /** Original scene fields, including bounds, center and editor metadata. */
  metadata: Readonly<Record<string, unknown>>;
}

/** A voxel object. Apply gridToWorld to grid corner coordinates to place it in the scene. */
export interface VMAXModel extends VoxelFileModel {
  node: VMAXNode;
  gridToWorld: Float64Array;
  /** One material slot per grid cell, 0 for air; original material byte is retained. */
  materialSlots: Uint8Array;
  /** Original material palette settings, if present. */
  settings?: Readonly<Record<string, unknown>>;
}

/** Decoded voxel geometry, colour palette and scene hierarchy. */
export interface VMAXFile extends VoxelFile {
  models: VMAXModel[];
  groups: VMAXNode[];
  /** Original scene.json fields, including cameras and render settings. */
  scene: Readonly<Record<string, unknown>>;
}

const bad = (why: string): never => {
  throw new RangeError(`VMAX ${why}; save the complete document again`);
};
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Uint8Array) return bad('expected a dictionary');
  return v as Record<string, unknown>;
};
const array = (v: unknown): unknown[] => {
  if (!Array.isArray(v)) return bad('expected an array');
  return v;
};
const integer = (v: unknown, lo: number, hi: number): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < lo || v > hi) return bad('integer outside its range');
  return v;
};
const vector = (v: unknown, fallback: number[]): number[] => {
  if (v === undefined) return fallback;
  const a = array(v);
  if (a.length !== fallback.length || a.some((n) => typeof n !== 'number' || !Number.isFinite(n)))
    return bad('invalid transform vector');
  return a as number[];
};
const dataBytes = (v: unknown): Uint8Array => {
  if (v instanceof Uint8Array) return v;
  return Uint8Array.from(array(v).map((n) => integer(n, 0, 255)));
};
const morton = (n: number): [number, number, number] => {
  const p: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 10; i++) for (let a = 0; a < 3; a++) p[a] |= ((n >>> (3 * i + a)) & 1) << i;
  return p;
};

/**
 * Reads a ZIP-packaged VMAX scene (stored or deflated entries), all voxel objects,
 * current snapshots and legacy chunks. Last snapshot per chunk wins. Geometry is
 * cropped to occupied bounds, with full placement retained by gridToWorld. Undo
 * history and previews are not loaded; original scene and material metadata remain.
 */
export async function parseVMAX(input: Uint8Array | ArrayBuffer, options: VMAXOptions = {}): Promise<VMAXFile> {
  const bytes = view(input, 'parseVMAX'),
    maxBytes = options.maxBytes ?? 256 * 1024 * 1024,
    maxCells = cellLimit(options),
    colors = new Colors(maxCells),
    signal = options.signal;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 0x7fffffff)
    throw new RangeError('maxBytes must be 1..2147483647; set a finite document budget');
  signal?.throwIfAborted();
  const entries = readZipDirectory(bytes, { maxEntries: options.maxEntries, signal }),
    sceneEntries = entries.filter((e) => /(^|\/)scene\.json$/.test(e.name));
  if (sceneEntries.length !== 1) return bad('archive must contain exactly one scene.json');
  const prefix = sceneEntries[0].name.slice(0, -10),
    files = new Map<string, (typeof entries)[number]>(),
    cache = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (files.has(entry.name)) return bad('archive contains duplicate paths');
    files.set(entry.name, entry);
  }
  let used = 0;
  const load = async (name: string, optional = false): Promise<Uint8Array | undefined> => {
    signal?.throwIfAborted();
    if (!name || name.startsWith('/') || name.split(/[\\/]/).includes('..')) return bad('invalid payload path');
    const path = prefix + name;
    if (cache.has(path)) return cache.get(path)!;
    const entry = files.get(path);
    if (!entry) {
      if (optional) return;
      return bad(`missing payload ${name}`);
    }
    if (used + entry.size > maxBytes) return bad('extracted data exceeds maxBytes');
    used += entry.size;
    const data = await readZipEntry(bytes, entry, { maxEntryBytes: maxBytes - used + entry.size, signal });
    cache.set(path, data);
    return data;
  };
  const plist = (data: Uint8Array): Record<string, unknown> => {
    if (data[0] === 98 && data[1] === 118) {
      data = decodeLZFSE(data, { maxBytes: maxBytes - used, signal });
      used += data.length;
    }
    return object(parsePlist(data));
  };
  const scene = object(JSON.parse(new TextDecoder().decode(await load('scene.json')))),
    rawGroups = array(scene.groups ?? []),
    rawModels = array(scene.objects),
    nodes = new Map<string, VMAXNode>();
  if (rawGroups.length + rawModels.length > MAX_MODELS) return bad(`scene exceeds ${MAX_MODELS} nodes`);
  const node = (raw: unknown): VMAXNode => {
    const v = object(raw),
      id = v.id,
      parentId = v.pid;
    if (typeof id !== 'string' || !id || nodes.has(id) || (parentId !== undefined && typeof parentId !== 'string'))
      return bad('invalid or duplicate node id');
    const p = vector(v.t_p, [0, 0, 0]),
      r = vector(v.t_r, [0, 1, 0, 0]),
      s = vector(v.t_s, [1, 1, 1]),
      axis = Math.hypot(r[0], r[1], r[2]),
      half = r[3] * 0.5;
    if ((!axis && r[3]) || s.some((n) => n === 0)) return bad('singular node transform');
    const f = axis ? Math.sin(half) / axis : 0,
      matrix = composeMatrix(p, [r[0] * f, r[1] * f, r[2] * f, Math.cos(half)], s, new Float64Array(16)),
      result: VMAXNode = {
        id,
        ...(parentId ? { parentId: parentId as string } : {}),
        name: String(v.n ?? ''),
        hidden: v.hidden === true,
        matrix,
        worldMatrix: matrix.slice(),
        metadata: v,
      };
    nodes.set(id, result);
    return result;
  };
  const groups = rawGroups.map(node),
    models = rawModels.map(node),
    active = new Set<string>(),
    done = new Set<string>();
  const world = (n: VMAXNode, depth = 0): void => {
    if (done.has(n.id)) return;
    if (active.has(n.id) || depth > 64) return bad('cyclic or deeply nested hierarchy');
    active.add(n.id);
    if (n.parentId) {
      const p = nodes.get(n.parentId);
      if (!p || !groups.includes(p)) return bad('node parent is not a group');
      world(p, depth + 1);
      multiplyMatrices(p.worldMatrix, n.matrix, n.worldMatrix);
    }
    active.delete(n.id);
    done.add(n.id);
  };
  for (const n of nodes.values()) world(n);
  const details: Omit<VMAXModel, keyof VoxelFileModel>[] = [];
  let visited = 0;
  for (const n of models) {
    signal?.throwIfAborted();
    const meta = n.metadata,
      payload = plist((await load(String(meta.data)))!),
      version = integer(payload.v ?? 0, 0, 100),
      paletteName = String(meta.pal ?? 'palette.png'),
      png = await load(paletteName, true),
      settingsData = await load(paletteName.replace(/\.png$/i, '') + '.settings.vmaxpsb', true),
      settings = settingsData ? plist(settingsData) : undefined;
    let palette: Uint8Array;
    if (png) {
      const image = decodePNG(png, { maxPixels: 256 });
      if (image.width * image.height !== 256) return bad('palette must contain 256 RGBA colours');
      palette = image.data;
    } else if (settings?.colors !== undefined) palette = dataBytes(settings.colors);
    else return bad(`missing colour palette ${paletteName}`);
    if (palette.length !== 1024) return bad('palette must contain 1024 RGBA bytes');
    const occupied = new Map<number, [number, number, number, number, number]>(),
      put = (origin: number[], code: number, material: number, color: number) => {
        const local = morton(code),
          p = local.map((v, a) => origin[a] + v);
        if (p.some((v) => !Number.isInteger(v) || v < 0 || v >= 512)) return bad('voxel outside supported extent');
        if (!color) return;
        const c = 4 * (color - 1),
          a = palette[c + 3];
        if (a)
          occupied.set(p[0] + 512 * (p[1] + 512 * p[2]), [
            p[0],
            p[1],
            p[2],
            rgba(palette[c], palette[c + 1], palette[c + 2], a),
            material,
          ]);
      };
    if (version >= 4) {
      const latest = new Map<number, Record<string, unknown>>();
      for (const snapshot of array(payload.snapshots ?? [])) {
        const storage = object(object(snapshot).s),
          id = integer(object(storage.id).c, 0, 4095);
        latest.set(id, storage);
      }
      for (const [id, storage] of latest) {
        const data = dataBytes(storage.ds);
        if (!data.length) continue;
        const start = integer(array(object(storage.st).min)[3], 0, 32767),
          origin = morton(id).map((v) => v * 32);
        if (data.length % 2 || start + data.length / 2 > 32768) return bad('snapshot exceeds its chunk');
        visited += data.length / 2;
        if (visited > maxCells) return bad('voxel decoding exceeds maxCells');
        for (let i = 0; i < data.length; i += 2) put(origin, start + i / 2, data[i], data[i + 1]);
      }
    } else {
      const chunks = dataBytes(payload.chunks),
        voxels = array(payload.voxels),
        stride = version === 0 ? 12 : 16,
        dv = new DataView(chunks.buffer, chunks.byteOffset, chunks.byteLength);
      if (chunks.length % stride || chunks.length / stride !== voxels.length) return bad('legacy chunk count mismatch');
      for (let c = 0; c < voxels.length; c++) {
        const at = c * stride,
          origin = [0, 4, 8].map((i) => dv.getInt32(at + i, true)),
          data = dataBytes(voxels[c]),
          width = version > 0 && dv.getInt32(at + 12, true) === 1 ? 2 : 1;
        if (data.length !== 32768 * width) return bad('legacy chunk has an invalid byte count');
        visited += 32768;
        if (visited > maxCells) return bad('voxel decoding exceeds maxCells');
        for (let i = 0; i < 32768; i++) put(origin, i, width === 2 ? data[2 * i] : 0, data[width * i + width - 1]);
      }
    }
    // The scene center is expressed in the same absolute model coordinates as
    // chunk origins. Grid corner zero is the occupied minimum minus this center.
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (const p of occupied.values())
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], p[a]);
        hi[a] = Math.max(hi[a], p[a]);
      }
    if (!occupied.size) {
      lo.fill(0);
      hi.fill(0);
    }
    const size = hi.map((v, a) => v - lo[a] + 1) as unknown as Vec3,
      center = vector(meta.center, [0, 0, 0]),
      local = lo.map((v, a) => v - center[a]),
      translation = composeMatrix(local, [0, 0, 0, 1], [1, 1, 1], new Float64Array(16)),
      gridToWorld = multiplyMatrices(n.worldMatrix, translation, new Float64Array(16)),
      position: Vec3 = [gridToWorld[12], gridToWorld[13], gridToWorld[14]],
      cells = colors.add(size, position, n.name, 'VMAX'),
      slots = new Uint8Array(cells.length);
    for (const p of occupied.values()) {
      const i = cellIndex(size, p[0] - lo[0], p[1] - lo[1], p[2] - lo[2]);
      cells[i] = p[3];
      slots[i] = p[4];
    }
    details.push({ node: n, gridToWorld, materialSlots: slots, ...(settings ? { settings } : {}) });
  }
  const result = colors.finish();
  return { ...result, models: result.models.map((model, i) => ({ ...model, ...details[i] })), groups, scene };
}
