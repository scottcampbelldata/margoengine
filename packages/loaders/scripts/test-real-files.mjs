// Opt-in proof on real files: `npm run test:real-files -w @margoengine/loaders`.
// Downloads every file in tests/real-files/manifest.json by URL, verifies its SHA-256, opens it with the loader and
// checks the result against something the loader did not produce: counts read from the file by the small readers
// below, or published facts. The downloads are never committed.
//
//   REAL_FILES_DIR       where downloads go, one folder per format (default test-results/real-files)
//   REAL_FILES_RUNTIMES  a folder whose node_modules holds rhino3dm, the caller-owned hook, and laz-perf, to compare
//                        (`npm run test:real-files:runtimes -w @margoengine/loaders` fetches them: opt in, never shipped).
//                        LAZ records with. Without it the 3DM rows are reported as not run, and the exit code says so,
//                        and the LAZ rows skip that comparison.
//   REAL_FILES_ONLY      comma-separated formats or ids to run
//   REAL_FILES_RENDER    1 draws every geometry through the real engine on the GPU (real-files-render.mjs)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { referenceAMF } from './amf-reference.mjs';
import { referencePLYFacts } from './ply-reference.mjs';
import {
  LoaderError,
  flattenDAE,
  parse3MF,
  parseDAE,
  parseDXF,
  parseMTL,
  parseOBJ,
  parseOFF,
  parsePCD,
  parsePLY,
  parseSTL,
  parseTMX,
  parseUSDA,
  parseUSDZ,
  parseVTK,
  parseXYZ,
  readZipDirectory,
} from '../dist/index.js';
import { parse3DS } from '../dist/3ds.js';
import { parseTDS } from '../dist/tds.js';
import { parse3DM } from '../dist/3dm.js';
import { parse3MFMaterials } from '../dist/threemf-materials.js';
import { parseAMF } from '../dist/amf.js';
import { parseGCode } from '../dist/gcode.js';
import { parseKMZ } from '../dist/kmz.js';
import { parseLAS } from '../dist/las.js';
import { parseLottie } from '../dist/lottie.js';
import { lasWaveDescriptors, lasWaveform } from '@margoengine/points/las';
import { parseLDraw } from '../dist/ldraw.js';
import { parseLWO } from '../dist/lwo.js';
import { parseMD2 } from '../dist/md2.js';
import { parseVDB } from '../dist/vdb.js';
import { parseBVH } from '../dist/mocap.js';
import { parseNRRD } from '../dist/nrrd.js';
import { evaluateNurbsCurve, evaluateNurbsSurface } from '../dist/nurbs.js';
import { parsePDB } from '../dist/pdb.js';
import { parseSVG } from '../dist/svg.js';
import { loadTextures } from '../dist/textures.js';
import { parseTTF, textGeometry } from '../dist/font.js';
import { parseVRML, parseX3D } from '../dist/vrml.js';
import { parseVTKXML } from '../dist/vtk-xml.js';
import { parseUSDAInWorker } from '../dist/worker.js';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../../..');
const manifest = JSON.parse(await readFile(resolve(here, '../tests/real-files/manifest.json'), 'utf8'));
const inRepo = (path) => (isAbsolute(path) ? path : resolve(repository, path));
const root = inRepo(process.env.REAL_FILES_DIR ?? 'test-results/real-files');
const only = process.env.REAL_FILES_ONLY?.split(',').map((s) => s.trim());
const TIME_LIMIT = 120_000;

const text = (bytes) => new TextDecoder('latin1').decode(bytes);
const count = (string, pattern) => (string.match(pattern) ?? []).length;

async function fetchChecked(item, format) {
  const path = resolve(root, format, item.file);
  await mkdir(dirname(path), { recursive: true });
  const known = await readFile(item.repo ? resolve(repository, item.repo) : path).catch(() => null);
  const bytes = known ?? new Uint8Array(await (await download(item.url)).arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256, item.sha256, `${item.file}: SHA-256 differs from the manifest (${item.url})`);
  if (!known) await writeFile(path, bytes);
  return new Uint8Array(bytes);
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIME_LIMIT * 3) });
  if (!response.ok) throw Object.assign(new Error(`${url}: HTTP ${response.status}`), { notRun: true });
  return response;
}

/** Bounds and a NaN scan of xyz triples. */
function bounds(positions) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    assert.ok(Number.isFinite(positions[i]), `position ${i} is ${positions[i]}`);
    const a = i % 3;
    if (positions[i] < min[a]) min[a] = positions[i];
    if (positions[i] > max[a]) max[a] = positions[i];
  }
  return { min, max };
}

const round = (values) => values.map((v) => Number(v.toPrecision(5)));

/** Checks a mesh or cloud: finite, in range, not flat in every axis, with the counts the file itself gives. */
function checkGeometry(geometry, { vertices, triangles, min, max, tolerance = 1e-3 } = {}) {
  const positions = geometry.positions;
  assert.ok(positions.length > 0, 'no positions');
  assert.equal(positions.length % 3, 0);
  const box = bounds(positions);
  assert.ok(Math.hypot(...box.max.map((v, a) => v - box.min[a])) > 0, 'every position is the same point');
  if (vertices !== undefined) assert.equal(positions.length / 3, vertices, 'vertex count');
  if (geometry.indices) {
    const limit = positions.length / 3;
    for (const index of geometry.indices) assert.ok(index < limit, `index ${index} past ${limit} vertices`);
    if (triangles !== undefined) assert.equal(geometry.indices.length / 3, triangles, 'triangle count');
  } else if (triangles !== undefined) assert.equal(positions.length / 9, triangles, 'triangle count');
  for (const [name, expected, actual] of [
    ['min', min, box.min],
    ['max', max, box.max],
  ])
    if (expected)
      expected.forEach((v, a) =>
        assert.ok(
          Math.abs(v - actual[a]) <= tolerance * Math.max(1, Math.abs(v)),
          `${name}[${a}] ${actual[a]} is not ${v}`,
        ),
      );
  return `${positions.length / 3} vertices${geometry.indices ? `, ${geometry.indices.length / 3} triangles` : ''}, bounds ${round(box.min)} to ${round(box.max)}`;
}

const mesh = (geometry) => ({ kind: geometry.kind ?? 'mesh', geometry });

/** A small ZIP walk of the central directory, separate from the package's reader. */
function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'no ZIP end record');
  const files = new Map();
  let p = view.getUint32(end + 16, true);
  for (let i = 0, n = view.getUint16(end + 10, true); i < n; i++) {
    const nameLength = view.getUint16(p + 28, true),
      name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLength)),
      local = view.getUint32(p + 42, true),
      start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true),
      raw = bytes.subarray(start, start + view.getUint32(p + 20, true)),
      method = view.getUint16(p + 10, true);
    files.set(name, () => (method === 0 ? raw : new Uint8Array(inflateRawSync(raw))));
    p += 46 + nameLength + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return files;
}

/** Triangles a 3MF build should give, by walking objects, components and build items in the raw XML. */
function threeMFTriangles(files) {
  const rels = text(files.get('_rels/.rels')()),
    rootPath = rels.match(/Target="\/?([^"]+\.model)"/)[1],
    models = new Map();
  const model = (path) => {
    if (models.has(path)) return models.get(path);
    const xml = text(files.get(path)()),
      objects = new Map();
    for (const [, attributes, body] of xml.matchAll(/<object\b([^>]*?)(?:\/>|>([\s\S]*?)<\/object>)/g)) {
      const components = [...(body ?? '').matchAll(/<component\b([^>]*)\/>/g)].map(([, a]) => ({
        id: a.match(/objectid="(\d+)"/)[1],
        path: a.match(/p:path="\/?([^"]+)"/)?.[1] ?? path,
      }));
      objects.set(attributes.match(/\bid="(\d+)"/)[1], { own: count(body ?? '', /<triangle\b/g), components });
    }
    const parsed = { xml, objects };
    models.set(path, parsed);
    return parsed;
  };
  const triangles = (path, id) => {
    const object = model(path).objects.get(id);
    return object.own + object.components.reduce((sum, c) => sum + triangles(c.path, c.id), 0);
  };
  let total = 0;
  for (const [, attributes] of model(rootPath).xml.matchAll(/<item\b([^>]*?)\/?>/g)) {
    const id = attributes.match(/objectid="(\d+)"/)[1],
      path = attributes.match(/p:path="\/?([^"]+)"/)?.[1] ?? rootPath;
    total += triangles(path, id);
  }
  return total;
}

/** DXF group codes of an ASCII file: how many of each entity the ENTITIES section holds. */
function dxfEntities(string) {
  const lines = string.split(/\r?\n/),
    entities = {};
  let inside = false;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i].trim() !== '0' && !(lines[i].trim() === '2' && lines[i + 1].trim() === 'ENTITIES')) continue;
    const value = lines[i + 1].trim();
    if (value === 'ENTITIES') inside = true;
    else if (value === 'ENDSEC') inside = false;
    else if (inside && lines[i].trim() === '0' && value !== 'SECTION') entities[value] = (entities[value] ?? 0) + 1;
  }
  return entities;
}

/** Faces of an ASCII polygon list, as triangles after fanning: `n a b c ...` lines. */
const fanned = (lines) => lines.reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[0]) - 2, 0);

function plyFacts(bytes) {
  return referencePLYFacts(bytes);
}

/** Triangles of every `coordIndex` list in a VRML or X3D file, polygons ending at -1 and fanned. */
function indexedTriangles(string, pattern) {
  let triangles = 0;
  for (const [, list] of string.matchAll(pattern))
    for (const polygon of list.split(/\b-1\b|-1/)) {
      const corners = polygon
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean).length;
      if (corners >= 3) triangles += corners - 2;
    }
  return triangles;
}

/** Walks the chunks of a 3DS file for its vertex and face counts. */
function threeDSFacts(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let vertices = 0,
    triangles = 0,
    cameras = 0,
    lights = 0,
    nodes = 0,
    keys = 0;
  const walk = (start, end) => {
    for (let p = start; p + 6 <= end; ) {
      const id = view.getUint16(p, true),
        length = view.getUint32(p + 2, true);
      if (length < 6) break;
      if (id === 0x4d4d || id === 0x3d3d || id === 0x4100 || id === 0xb000 || (id >= 0xb001 && id <= 0xb007)) {
        if (id >= 0xb001 && id <= 0xb007) nodes++;
        walk(p + 6, p + length);
      } else if (id === 0x4000) {
        let q = p + 6;
        while (bytes[q]) q++;
        walk(q + 1, p + length);
      } else if (id === 0x4110) vertices += view.getUint16(p + 6, true);
      else if (id === 0x4120) triangles += view.getUint16(p + 6, true);
      else if (id === 0x4700) cameras++;
      else if (id === 0x4600) lights++;
      else if (id >= 0xb020 && id <= 0xb022) keys += view.getUint32(p + 6 + 10, true);
      p += length;
    }
  };
  walk(0, bytes.length);
  return { vertices, triangles, cameras, lights, nodes, keys };
}

/** Walks the IFF chunks of an LWO2 file: points, faces and cage polygons fanned to triangles, UV and weight map names, still images. */
function lwoFacts(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let points = 0,
    triangles = 0,
    stills = 0;
  const uvMaps = new Set(),
    weightMaps = new Set(),
    old = text(bytes.subarray(8, 12)) === 'LWOB';
  for (let p = 12; p + 8 <= bytes.length; ) {
    const id = text(bytes.subarray(p, p + 4)),
      size = view.getUint32(p + 4);
    if (id === 'PNTS') points += size / 12;
    if (id === 'VMAP' || id === 'VMAD') {
      const type = text(bytes.subarray(p + 8, p + 12));
      let q = p + 14;
      while (bytes[q]) q++;
      if (type === 'TXUV') uvMaps.add(text(bytes.subarray(p + 14, q)));
      if (type === 'WGHT') weightMaps.add(text(bytes.subarray(p + 14, q)));
    }
    if (id === 'CLIP' && text(bytes.subarray(p + 12, p + 16)) === 'STIL') stills++;
    if (id === 'POLS' && old)
      for (let q = p + 8; q < p + 8 + size; ) {
        const n = view.getUint16(q);
        if (n >= 3) triangles += n - 2;
        q += 2 + n * 2;
        // A negative surface has a count of detail polygons after it; those polygons follow in the same form.
        q += view.getInt16(q) < 0 ? 4 : 2;
      }
    if (id === 'POLS' && !old && ['FACE', 'PTCH', 'SUBD'].includes(text(bytes.subarray(p + 8, p + 12)))) {
      for (let q = p + 12; q < p + 8 + size; ) {
        const n = view.getUint16(q) & 0x3ff;
        q += 2;
        if (n >= 3) triangles += n - 2;
        for (let i = 0; i < n; i++) q += bytes[q] === 0xff ? 4 : 2;
      }
    }
    p += 8 + size + (size & 1);
  }
  return { points, triangles, stills, uvMaps: [...uvMaps].sort(), weightMaps: [...weightMaps].sort() };
}

/** A texture path as a real file wrote it reaches a folder that holds the file under its plain base name. */
async function readsTexture(path) {
  const base = path.split(/[\\/:]/).pop(),
    asked = [],
    { textures, missing } = await loadTextures([path], async (name) => {
      asked.push(name);
      if (name.toLowerCase() === base.toLowerCase()) return new Uint8Array(1);
      throw new Error('not here');
    });
  assert.equal(textures.size, 1, `${path} reached the folder: asked ${asked.join(', ')}`);
  assert.equal(missing.length, 0);
}

let runtimes;
async function loadRuntimes() {
  if (runtimes !== undefined) return runtimes;
  const folder = process.env.REAL_FILES_RUNTIMES;
  if (!folder) return (runtimes = null);
  const require = createRequire(pathToFileURL(resolve(inRepo(folder), 'package.json')));
  const rhino = await (await import(pathToFileURL(require.resolve('rhino3dm')))).default();
  const createLazPerf = (await import(pathToFileURL(require.resolve('laz-perf')))).createLazPerf;
  return (runtimes = { rhino, laz: await createLazPerf() });
}

/** The plain point records of Margo's own LAZ decoder, to compare with those of laz-perf. */
async function margoRecords({ bytes, header, pointOffset, records }) {
  const { lazChunks } = await import('../../points/dist/laz.js'),
    out = new Uint8Array(header.pointCount * header.pointRecordLength);
  let at = 0;
  for await (const chunk of lazChunks(bytes, { ...header, pointDataOffset: pointOffset }, records)) {
    out.set(chunk, at);
    at += chunk.length;
  }
  assert.equal(at, out.length, 'every point was decoded');
  return out;
}

/** The decompress hook of `parseLAS` around laz-perf, the third-party decoder used only to compare results. */
function lazDecompress(laz) {
  return ({ bytes, header }) => {
    const file = laz._malloc(bytes.length),
      reader = new laz.LASZip(),
      length = header.pointRecordLength,
      point = laz._malloc(length);
    try {
      laz.HEAPU8.set(bytes, file);
      reader.open(file, bytes.length);
      assert.equal(reader.getCount(), header.pointCount);
      assert.equal(reader.getPointLength(), length);
      const out = new Uint8Array(header.pointCount * length);
      for (let i = 0; i < header.pointCount; i++) {
        reader.getPoint(point);
        out.set(laz.HEAPU8.subarray(point, point + length), i * length);
      }
      return out;
    } finally {
      reader.delete();
      laz._free(file);
      laz._free(point);
    }
  };
}

const LOTTIE_CELLS = 16,
  LOTTIE_CELL_LEVELS = 2;

/** A stand-in canvas that keeps every call and assignment, for replay on a real canvas in a page. */
function recordedCanvas() {
  const list = [];
  let gradients = 0;
  const gradient =
    (kind) =>
    (...args) => {
      const id = gradients++;
      list.push(['gradient', id, kind, args]);
      return { id, addColorStop: (...stop) => list.push(['stop', id, stop]) };
    };
  const context = new Proxy(
    { createLinearGradient: gradient('createLinearGradient'), createRadialGradient: gradient('createRadialGradient') },
    {
      get: (target, name) => target[name] ?? ((...args) => list.push(['call', name, args])),
      set: (_, name, value) => {
        list.push(['set', name, value?.id === undefined ? value : { gradient: value.id }]);
        return true;
      },
    },
  );
  return { context, list };
}

/** Each check opens one manifest row, compares with an independent reading and returns what to report and draw. */
const checks = {
  async ply(bytes) {
    const expected = plyFacts(bytes),
      g = parsePLY(bytes);
    return { result: checkGeometry(g, expected), draw: [mesh(g)] };
  },
  async stl(bytes, item) {
    const g = parseSTL(bytes),
      binary = bytes.length === 84 + 50 * new DataView(bytes.buffer, bytes.byteOffset).getUint32(80, true);
    assert.equal(binary, item.variant === 'binary');
    const triangles = binary
      ? new DataView(bytes.buffer, bytes.byteOffset).getUint32(80, true)
      : count(text(bytes), /facet normal/g);
    return { result: checkGeometry(g, { triangles }), draw: [mesh(g)] };
  },
  async threemf(bytes) {
    const triangles = threeMFTriangles(unzip(bytes)),
      g = await parse3MF(bytes);
    return { result: checkGeometry(g, { triangles }), draw: [mesh(g)] };
  },
  async threemfMaterials(bytes) {
    const files = unzip(bytes),
      triangles = threeMFTriangles(files),
      xml = [...files]
        .filter(([n]) => n.endsWith('.model'))
        .map(([, read]) => text(read()))
        .join(''),
      g = await parse3MFMaterials(bytes);
    assert.equal(g.textures.length, count(xml, /<m:texture2d\s/g), 'texture count');
    for (const t of g.textures) assert.ok(t.data.length > 8, 'texture has bytes');
    return { result: `${checkGeometry(g, { triangles })}, ${g.textures.length} textures`, draw: [mesh(g)] };
  },
  async dxf(bytes, item) {
    const parsed = parseDXF(bytes),
      string = text(bytes),
      binary = item.variant === 'binary',
      entities = binary ? null : dxfEntities(string),
      entity = (name) => (binary ? count(string, new RegExp(`\\0${name}\\0`, 'g')) : (entities[name] ?? 0)),
      triangles = parsed.mesh.positions.length / 9,
      lines = parsed.lines.positions.length / 6;
    assert.equal(parsed.version, string.match(/AC10\d\d/)?.[0] ?? '', '$ACADVER');
    assert.ok(triangles >= entity('3DFACE'), '3DFACE');
    assert.ok(lines >= entity('LINE'), 'LINE');
    assert.equal(parsed.texts.length, entity('TEXT') + entity('MTEXT'), 'TEXT and MTEXT');
    for (const name of ['3DSOLID', 'HATCH'])
      if (entity(name))
        assert.ok(
          Object.keys(parsed.skipped).some((k) => k.startsWith(name)),
          `${name} is reported as skipped`,
        );
    const draw = [];
    if (triangles) {
      checkGeometry(parsed.mesh);
      draw.push(mesh(parsed.mesh));
    }
    if (lines) draw.push({ kind: 'lines', positions: parsed.lines.positions });
    return {
      result: `${parsed.version || 'no version'}, ${parsed.layers.length} layers, ${triangles} triangles, ${lines} lines, ${parsed.texts.length} texts, skipped ${JSON.stringify(parsed.skipped)}`,
      draw,
    };
  },
  async pcd(bytes) {
    const head = text(bytes.subarray(0, 2048)),
      points = Number(head.match(/^POINTS (\d+)/m)[1]),
      g = parsePCD(bytes, { keepInvalid: true }),
      dense = parsePCD(bytes);
    assert.equal(g.positions.length / 3, points, 'POINTS');
    return { result: `${points} points, ${checkGeometry(dense)}`, draw: [mesh(dense)] };
  },
  async off(bytes) {
    const lines = text(bytes)
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.startsWith('#')),
      [vertices, faces] = lines[1].trim().split(/\s+/).map(Number),
      triangles = fanned(lines.slice(2 + vertices, 2 + vertices + faces)),
      g = parseOFF(bytes);
    return { result: checkGeometry(g, { vertices, triangles }), draw: [mesh(g)] };
  },
  async xyz(bytes, item) {
    const source = item.extract ? unzip(bytes).get(item.extract)() : bytes,
      lines = text(source)
        .split(/\r?\n/)
        .filter((l) => /^\s*[-+]?[\d.]+\s+[-+]?[\d.]/.test(l)),
      g = parseXYZ(source),
      first = lines[0].trim().split(/\s+/).map(Number);
    assert.equal(g.positions.length / 3, lines.length, 'point lines');
    return { result: `${checkGeometry(g)}; first ${first}`, draw: [mesh(g)] };
  },
  async xyzAttributes(bytes, item) {
    const lines = text(bytes).trim().split(/\r?\n/),
      chemistry = item.variant === 'chemistry',
      rows = lines.slice(chemistry ? 2 : 1).map((line) => line.trim().split(/\s+/)),
      geometry = parseXYZ(bytes),
      coordinates = rows.flatMap((row) => row.slice(chemistry ? 1 : 0, chemistry ? 4 : 3).map(Number));
    assert.equal(rows.length, Number(lines[0]), 'declared point/atom count');
    assert.deepEqual(Array.from(geometry.positions), coordinates.map(Math.fround), 'every coordinate');
    if (!chemistry) {
      assert.ok(
        rows.every((row) => row.length === 7),
        'PTS has xyz, intensity and RGB',
      );
      assert.deepEqual(
        Array.from(geometry.attributes.intensity),
        rows.map((row) => Math.fround(Number(row[3]))),
        'every intensity',
      );
      assert.deepEqual(
        Array.from(geometry.colors),
        rows.flatMap((row) => row.slice(4).map((value) => Math.fround(Number(value) / 255))),
        'every colour channel',
      );
    }
    return {
      result: `${checkGeometry(geometry)}; every coordinate${chemistry ? '' : ', intensity and RGB'} equals the source text`,
      draw: [mesh(geometry)],
    };
  },
  async obj(bytes, item, read) {
    const source = item.extract ? unzip(bytes).get(item.extract)() : bytes,
      string = new TextDecoder().decode(source),
      vertices = count(string, /^v\s/gm),
      faces = string.match(/^f\s.*$/gm) ?? [],
      triangles = faces.reduce((sum, f) => sum + f.trim().split(/\s+/).length - 3, 0),
      g = await parseOBJ(string);
    const library = item.extractMtl
      ? unzip(bytes).get(item.extractMtl)()
      : item.companions
        ? await read(item.companions[0])
        : null;
    let materials = '';
    if (library) {
      const mtl = new TextDecoder().decode(library),
        parsed = parseMTL(mtl),
        names = count(mtl, /^newmtl\s/gm);
      const size = parsed.materials
        ? Object.keys(parsed.materials).length
        : (parsed.size ?? Object.keys(parsed).length);
      assert.equal(size, names, 'newmtl count');
      materials = `, ${names} materials`;
    }
    assert.equal(g.positions.length / 3 >= 0, true);
    const shown = { kind: 'mesh', positions: g.positions, indices: g.indices, normals: g.normals, uvs: g.uvs };
    return { result: `${checkGeometry(shown, { triangles })}, file v ${vertices}${materials}`, draw: [mesh(shown)] };
  },
  async dae(bytes, item) {
    const string = new TextDecoder().decode(bytes),
      triangles =
        [...string.matchAll(/<triangles\b[^>]*count="(\d+)"/g)].reduce((s, m) => s + Number(m[1]), 0) +
        [...string.matchAll(/<polylist\b[\s\S]*?<vcount>([^<]*)<\/vcount>/g)].reduce(
          (s, m) => s + fanned(m[1].trim().split(/\s+/)),
          0,
        ),
      dae = parseDAE(string),
      flat = flattenDAE(dae);
    const skins = dae.skins?.length ?? dae.controllers?.length ?? 0;
    // This suite file holds two geometries and instances one; flattened, only the instanced polygons are drawn.
    assert.ok(flat.positions.length > 0);
    return {
      result: `${skins} skins, file ${triangles} triangles in all, ${checkGeometry(flat, item.facts)}`,
      draw: [mesh(flat)],
    };
  },
  async tmx(bytes, item, read) {
    const string = new TextDecoder().decode(bytes),
      map = await parseTMX(string, {
        resolve: async (path) => new TextDecoder().decode(await read(item.companions.find((c) => c.file === path))),
      });
    assert.equal(map.width, Number(string.match(/<map[^>]*\swidth="(\d+)"/)[1]));
    assert.equal(map.layers.length, count(string, /<(layer|objectgroup)\b/g), 'layers');
    const objects = map.layers.reduce((sum, l) => sum + (l.objects?.length ?? 0), 0);
    assert.equal(objects, count(string, /<object\b/g), 'objects');
    return {
      result: `${map.width}x${map.height}, ${map.layers.length} layers, ${objects} objects, warnings ${map.warnings?.length ?? 0}`,
    };
  },
  async vtk(bytes) {
    const string = text(bytes.subarray(0, 512)),
      vertices = Number(string.match(/POINTS (\d+)/)[1]),
      polygons = text(bytes).match(/^POLYGONS (\d+) (\d+)/m),
      g = parseVTK(bytes),
      offsets = Number(string.match(/Version (\d)/)[1]) >= 5, // 5.x gives offsets and connectivity, older n and size.
      triangles = !polygons
        ? undefined
        : offsets
          ? Number(polygons[2]) - 2 * (Number(polygons[1]) - 1)
          : Number(polygons[2]) - 3 * Number(polygons[1]);
    return { result: checkGeometry(g, { vertices, triangles }), draw: [mesh(g)] };
  },
  async usda(bytes) {
    const string = new TextDecoder().decode(bytes),
      triangles = [...string.matchAll(/faceVertexCounts = \[([^\]]*)\]/g)].reduce(
        (s, m) => s + fanned(m[1].split(',')),
        0,
      ),
      g = parseUSDA(bytes),
      worker = await parseUSDAInWorker(bytes);
    assert.deepEqual(worker.positions, g.positions, 'the worker entry gives the same mesh');
    return { result: checkGeometry(g, { triangles }), draw: [mesh(g)] };
  },
  async usdaSubdivision(bytes) {
    assert.throws(
      () => parseUSDA(bytes),
      (error) => error instanceof LoaderError && error.code === 'unsupported',
    );
    return { result: 'subdivision surface refused with code unsupported, as documented' };
  },
  async usdz(bytes) {
    const string = new TextDecoder().decode([...unzip(bytes)].find(([n]) => n.endsWith('.usda'))[1]()),
      triangles = [...string.matchAll(/faceVertexCounts = \[([^\]]*)\]/g)].reduce(
        (s, m) => s + fanned(m[1].split(',')),
        0,
      ),
      g = await parseUSDZ(bytes);
    return { result: checkGeometry(g, { triangles }), draw: [mesh(g)] };
  },
  async usdRefused(bytes, item) {
    await assert.rejects(
      async () => (item.file.endsWith('.usdz') ? parseUSDZ(bytes) : parseUSDA(bytes)),
      (error) => error instanceof LoaderError && error.code === 'unsupported',
    );
    return { result: `refused with code unsupported: ${item.note}` };
  },
  async usdzBinary(bytes) {
    await assert.rejects(
      async () => parseUSDZ(bytes),
      (error) => error instanceof LoaderError && error.code === 'unsupported',
    );
    return { result: 'binary USDC root refused with code unsupported, as documented (@margoengine/usdz reads it)' };
  },
  async font(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset),
      tables = new Map();
    for (let i = 0, n = view.getUint16(4); i < n; i++)
      tables.set(text(bytes.subarray(12 + i * 16, 16 + i * 16)), view.getUint32(20 + i * 16));
    const unitsPerEm = view.getUint16(tables.get('head') + 18),
      glyphs = view.getUint16(tables.get('maxp') + 4),
      font = parseTTF(bytes),
      geometry = textGeometry('Margo', { font, size: 100, depth: 20 });
    assert.equal(font.unitsPerEm, unitsPerEm, 'unitsPerEm');
    const g = { kind: 'mesh', positions: geometry.positions, indices: geometry.indices };
    return { result: `${glyphs} glyphs, ${unitsPerEm} units per em, ${checkGeometry(g)}`, draw: [mesh(g)] };
  },
  async fontCff(bytes) {
    assert.throws(
      () => parseTTF(bytes),
      (error) => error instanceof LoaderError && error.code === 'unsupported',
    );
    return { result: 'CFF outlines refused with code unsupported, as documented' };
  },
  async svg(bytes) {
    const string = new TextDecoder().decode(bytes),
      drawn = count(string, /<(path|rect|circle|ellipse|line|polyline|polygon)\b/g),
      svg = parseSVG(string);
    assert.ok(svg.paths.length > 0, 'no paths');
    return {
      result: `${svg.paths.length} paths, ${drawn} drawn elements in the file, warnings ${svg.warnings.length}`,
    };
  },
  async bvh(bytes) {
    const string = text(bytes),
      joints = count(string, /^\s*(ROOT|JOINT)\s/gm),
      frames = Number(string.match(/Frames:\s*(\d+)/)[1]),
      time = Number(string.match(/Frame Time:\s*([\d.]+)/)[1]),
      bvh = parseBVH(string);
    assert.equal(bvh.bones.length, joints, 'joints');
    const keys = bvh.clip.tracks[0].keys,
      last = keys.at(-1).time;
    assert.equal(keys.length, frames, 'keys per track');
    assert.ok(Math.abs(last - (frames - 1) * time) < 1e-3, `clip ends at ${last}`);
    return {
      result: `${joints} joints, ${frames} frames at ${time} s, ${bvh.clip.tracks.length} tracks, ${last.toFixed(2)} s`,
    };
  },
  async vrml(bytes) {
    const scene = parseVRML(bytes),
      triangles = indexedTriangles(text(bytes), /coordIndex\s*\[([^\]]*)\]/g);
    return {
      result: `${checkGeometry(scene, { triangles })}, ${scene.groups?.length} shapes, left out ${scene.warnings.join(', ').slice(0, 200)}`,
      draw: [mesh(scene)],
    };
  },
  async x3d(bytes) {
    const scene = parseX3D(bytes),
      triangles = indexedTriangles(text(bytes), /coordIndex=['"]([^'"]*)['"]/g);
    return {
      result: `${checkGeometry(scene, { triangles })}, ${scene.groups?.length} shapes, left out ${scene.warnings.join(', ').slice(0, 200)}`,
      draw: [mesh(scene)],
    };
  },
  /** Each frame through `draw` on a real canvas, cell by cell against the same frame as the player drew it. */
  async lottie(bytes, item) {
    const animation = parseLottie(new TextDecoder().decode(bytes));
    assert.deepEqual(animation.unsupported, [], `${item.file}: features left out`);
    const scale = 256 / Math.max(animation.width, animation.height),
      width = Math.round(animation.width * scale),
      height = Math.round(animation.height * scale),
      { canvasGrids } = await import('./real-files-render.mjs'),
      jobs = item.frames.map(({ frame }) => {
        const calls = recordedCanvas();
        animation.draw(calls.context, frame);
        return {
          calls: calls.list,
          width,
          height,
          scale: [width / animation.width, height / animation.height],
          cells: LOTTIE_CELLS,
        };
      }),
      grids = await canvasGrids(jobs);
    let worst = 0;
    item.frames.forEach(({ frame, grid }, at) => {
      grids[at].forEach((level, n) => {
        const off = Math.abs(level - parseInt(grid.slice(n * 2, n * 2 + 2), 16));
        assert.ok(off <= LOTTIE_CELL_LEVELS, `${item.file} frame ${frame}: cell ${n} is ${off} levels from the player`);
        worst = Math.max(worst, off);
      });
    });
    return { result: `${item.frames.length} frames, worst cell ${worst} of 255 levels from the player` };
  },

  async vdb(bytes, item) {
    const file = await parseVDB(unzip(bytes).get(item.extract)());
    assert.deepEqual(file.skipped, []);
    assert.deepEqual(
      file.grids.map((grid) => grid.name),
      item.grids.map((grid) => grid.name),
    );
    for (const expected of item.grids) {
      const grid = file.grids.find(({ name }) => name === expected.name);
      assert.equal(grid.activeVoxels, expected.activeVoxels);
      assert.deepEqual(grid.box, expected.box);
      for (const [x, y, z, value, active] of expected.samples) {
        assert.equal(grid.at(x, y, z), value, `${grid.name} at ${x} ${y} ${z}`);
        assert.equal(grid.isActive(x, y, z), active, `${grid.name} active at ${x} ${y} ${z}`);
      }
    }
    return {
      result: `${file.grids.map((grid) => `${grid.name}: ${grid.activeVoxels} active, ${grid.leaves.length} leaves`).join('; ')}, equal to OpenVDB`,
    };
  },
  async gcode(bytes, item) {
    const source = unzip(bytes).get(item.extract)(),
      string = text(source),
      gcode = parseGCode(string);
    const claimed = Number(string.match(/; filament used \[mm\] = ([\d.]+)/)[1]),
      changes = count(string, /^;LAYER_CHANGE/gm);
    // The slicer's figure leaves out the hand-written start and end code, a few percent here.
    assert.ok(
      Math.abs(gcode.filament - claimed) <= claimed * 0.05,
      `filament ${gcode.filament} is not near the slicer's ${claimed}`,
    );
    const positions = Float32Array.from(gcode.layers.flatMap((l) => [...l.extrusion]));
    return {
      result: `${gcode.layers.length} layers (${changes} layer changes in the file), filament ${gcode.filament.toFixed(1)} mm (slicer says ${claimed}), bounds ${gcode.min} to ${gcode.max}, warnings ${gcode.warnings?.length}`,
      draw: [{ kind: 'lines', positions }],
    };
  },
  async nrrd(bytes, item, read) {
    const volume = await parseNRRD(bytes, {
      resolve: async (path) => read(item.companions.find((c) => c.file === path)),
    });
    let min = Infinity,
      max = -Infinity;
    for (const v of volume.data) {
      assert.ok(Number.isFinite(v));
      if (v < min) min = v;
      if (v > max) max = v;
    }
    assert.ok(max > min, 'the volume is flat');
    const head = text(bytes),
      sizes = head
        .match(/^sizes: (.*)$/m)[1]
        .split(' ')
        .map(Number),
      samples = sizes.reduce((a, b) => a * b, 1),
      encoding = head.match(/^encoding: (\w+)/m)[1];
    assert.equal(volume.data.length, samples, 'samples');
    if (!item.companions) {
      const body = bytes.subarray(head.indexOf('\n\n') + 2);
      assert.deepEqual(
        new Uint8Array(volume.data.buffer, volume.data.byteOffset, volume.data.byteLength),
        body,
        'raw body',
      );
    } else if (encoding === 'ascii') {
      const values = text(await read(item.companions[0]))
        .trim()
        .split(/\s+/)
        .map(Number);
      values.forEach((v, i) => assert.ok(Math.abs(volume.data[i] - v) < 1e-6, `sample ${i}`));
    } else {
      let at = 0;
      for (const slice of item.companions) {
        const part = await read(slice);
        const shorts = new Int16Array(part.slice().buffer);
        shorts.forEach((v, i) => assert.equal(volume.data[at + i], v, `sample ${at + i}`));
        at += shorts.length;
      }
      assert.equal(at, samples, 'every slice is in the volume');
    }
    return {
      result: `dims ${volume.dims}, ${volume.data.length} samples, range ${min} to ${max}, components ${volume.components}`,
    };
  },
  async ldraw(bytes, item) {
    const { entries, read } = await zipReader(bytes);
    const prefix = 'ldraw/';
    const file = text(await read(prefix + item.extract));
    const missing = new Set();
    const model = await parseLDraw(file, {
      resolve: async (path) => {
        const name = entries.get((prefix + path).toLowerCase());
        if (!name) {
          missing.add(path);
          throw new Error(`no ${path}`);
        }
        return text(await read(name));
      },
    });
    const references = count(file, /^\s*1\s/gm);
    return {
      result: `${references} references, ${checkGeometry(model)}, ${model.groups.length} colours, missing ${model.missing.length}`,
      draw: [mesh(model)],
    };
  },
  async ldrawMpd(bytes, item, read) {
    const [library, ...parts] = item.companions,
      archive = await zipReader(await read(library)),
      extra = new Map();
    for (const part of parts) extra.set(`parts/${part.file}`, text(await read(part)));
    const source = text(bytes),
      submodels = count(source, /^0 FILE /gm);
    assert.ok(submodels > 1, 'real MPD holds multiple embedded submodels');
    const model = await parseLDraw(source, {
      resolve: async (path) => {
        if (extra.has(path)) return extra.get(path);
        const name = archive.entries.get(`ldraw/${path}`.toLowerCase());
        assert.ok(name, `Required LDraw dependency ${path}; restore the pinned library/companions`);
        return text(await archive.read(name));
      },
    });
    assert.deepEqual(model.missing, [], 'every external part resolves');
    assert.deepEqual(model.warnings, [], 'published MPD has no parser warnings');
    return {
      result: `${submodels} embedded submodels, ${checkGeometry(model)}, ${model.groups.length} colours; zero missing parts`,
      draw: [mesh(model)],
    };
  },
  async vtkXml(bytes) {
    const string = text(bytes.subarray(0, 4096)),
      vertices = [...string.matchAll(/NumberOfPoints="(\d+)"/g)].reduce((s, m) => s + Number(m[1]), 0),
      cells = [...string.matchAll(/NumberOf(?:Polys|Cells)="(\d+)"/g)].reduce((s, m) => s + Number(m[1]), 0),
      g = await parseVTKXML(bytes);
    return { result: `${cells} cells or polygons, ${checkGeometry(g, { vertices })}`, draw: [mesh(g)] };
  },
  async threedm(bytes, item) {
    const hooks = await loadRuntimes();
    if (!hooks) return { notRun: 'REAL_FILES_RUNTIMES is not set' };
    const { rhino } = hooks,
      file = rhino.File3dm.fromByteArray(bytes),
      objects = file.objects(),
      total = objects.count;
    let curves = 0,
      worst = 0;
    for (let i = 0; i < total; i++) {
      const object = objects.get(i),
        geometry = object.geometry();
      if (geometry.toNurbsCurve) {
        const nurbs = geometry.toNurbsCurve ? geometry.toNurbsCurve() : geometry;
        if (nurbs) {
          const n = nurbs.points().count,
            knots = nurbs.knots(),
            points = [],
            weights = [];
          for (let k = 0; k < n; k++) {
            // The runtime gives a control point multiplied by its weight.
            const [x, y, z, w] = nurbs.points().get(k);
            points.push(x / w, y / w, z / w);
            weights.push(w);
          }
          const domain = nurbs.domain,
            t = domain[0] + (domain[1] - domain[0]) * 0.37,
            ours = evaluateNurbsCurve(
              {
                degree: nurbs.degree,
                knots: Array.from({ length: knots.count }, (_, k) => knots.get(k)),
                points,
                weights,
              },
              t,
            ),
            theirs = nurbs.pointAt(t);
          worst = Math.max(worst, Math.hypot(ours[0] - theirs[0], ours[1] - theirs[1], ours[2] - theirs[2]));
          curves++;
        }
      }
    }
    // Whole surfaces: Margo's evaluator against the runtime's own at points inside each one, read from the file's numbers.
    let plain = 0,
      surfaceWorst = 0;
    for (let i = 0; i < total; i++) {
      const geometry = objects.get(i).geometry(),
        brepFace = geometry.isSurface === true ? geometry.faces().get(0) : undefined;
      if (brepFace?.getMesh(rhino.MeshType.Any)) continue;
      const nurbs = brepFace ? brepFace.underlyingSurface().toNurbsSurface() : geometry.knotsU ? geometry : undefined;
      if (!nurbs) continue;
      plain++;
      const list = nurbs.points(),
        points = [],
        weights = [],
        knots = (table) => Array.from({ length: table.count }, (_, k) => table.get(k));
      for (let u = 0; u < list.countU; u++)
        for (let v = 0; v < list.countV; v++) {
          points.push(...list.getPoint(u, v));
          weights.push(list.get(u, v)[3]);
        }
      const data = {
          degreeU: nurbs.degree(0),
          degreeV: nurbs.degree(1),
          knotsU: knots(nurbs.knotsU()),
          knotsV: knots(nurbs.knotsV()),
          countU: list.countU,
          countV: list.countV,
          points,
          weights,
        },
        [u0, u1] = nurbs.domain(0),
        [v0, v1] = nurbs.domain(1);
      for (const a of [0.13, 0.5, 0.87])
        for (const b of [0.21, 0.5, 0.79]) {
          const u = u0 + (u1 - u0) * a,
            v = v0 + (v1 - v0) * b,
            ours = evaluateNurbsSurface(data, u, v).position,
            theirs = nurbs.pointAt(u, v);
          surfaceWorst = Math.max(
            surfaceWorst,
            Math.hypot(ours[0] - theirs[0], ours[1] - theirs[1], ours[2] - theirs[2]),
          );
        }
    }
    const parsed = parse3DM(rhino, bytes, { hidden: true }),
      meshes = parsed.groups.length;
    assert.equal(parsed.surfaces, plain, 'objects drawn from their surface');
    assert.ok(worst < 1e-9, `curve points match the runtime: ${worst}`);
    assert.ok(surfaceWorst < 1e-9, `surface points match the runtime: ${surfaceWorst}`);
    if (item.surfaces !== undefined) assert.equal(parsed.surfaces, item.surfaces, 'surfaces of this file');
    assert.equal(meshes + parsed.skipped, total, 'objects');
    assert.equal(parsed.layers.length, file.layers().count, 'layers');
    return {
      result: `${total} objects, ${meshes} meshes, ${parsed.surfaces} from surfaces (largest difference ${surfaceWorst.toExponential(1)}), ${parsed.skipped} skipped, ${parsed.layers.length} layers, ${meshes ? checkGeometry(parsed) : 'no saved meshes'}; ${curves} curves, largest NURBS difference from rhino3dm ${worst}`,
      // Rhino's default colour is black, which a dark picture would hide: this shows the shape.
      draw: meshes ? [mesh({ ...parsed, groups: parsed.groups.map(({ color, ...group }) => group) })] : [],
    };
  },
  async threeds(bytes, item) {
    const expected = threeDSFacts(bytes),
      g = parse3DS(bytes),
      tds = parseTDS(bytes);
    assert.deepEqual(tds.positions, g.positions, 'parseTDS is the same reader');
    assert.equal(g.cameras.length, expected.cameras, 'cameras');
    assert.equal(g.lights.length, expected.lights, 'lights');
    assert.equal(g.keyframes?.nodes.length ?? 0, expected.nodes, 'keyframer nodes');
    const tracks =
      g.keyframes?.nodes.flatMap((node) => [node.tracks.position, node.tracks.rotation, node.tracks.scale]) ?? [];
    assert.equal(
      tracks.reduce((sum, track) => sum + (track?.keys.length ?? 0), 0),
      expected.keys,
      'position, rotation and scale keys',
    );
    const texture = g.materials.find((material) => material.texture)?.texture;
    if (texture) await readsTexture(texture);
    return {
      result: `${checkGeometry(g, { triangles: expected.triangles })}, ${g.materials.length} materials, file ${expected.vertices} vertices, ${expected.cameras} cameras, ${expected.lights} lights, ${expected.nodes} nodes with ${expected.keys} keys`,
      draw: [mesh(g)],
    };
  },
  async lwo(bytes) {
    const expected = lwoFacts(bytes),
      g = parseLWO(bytes);
    assert.deepEqual(Object.keys(g.uvMaps).sort(), expected.uvMaps, 'UV maps');
    assert.deepEqual(Object.keys(g.weightMaps).sort(), expected.weightMaps, 'weight maps');
    assert.equal(g.images.length, expected.stills, 'still images');
    for (const map of Object.values(g.uvMaps))
      assert.equal(map.length / 2, g.positions.length / 3, 'one uv per vertex');
    const maps = g.surfaces.flatMap((surface) => surface.maps);
    for (const map of maps) if (map.path) await readsTexture(map.path);
    return {
      result: `${checkGeometry(g, { triangles: expected.triangles })}, file ${expected.points} points, ${expected.uvMaps.length} UV maps, ${expected.weightMaps.length} weight maps, ${g.images.length} images, ${maps.length} image maps, warnings ${g.warnings?.join('; ').slice(0, 160)}`,
      draw: [mesh(g)],
    };
  },
  async amf(bytes) {
    const zipped = bytes[0] === 0x50 && bytes[1] === 0x4b,
      entries = zipped ? unzip(bytes) : undefined,
      payload = entries && [...entries].find(([name]) => /\.amf$/i.test(name));
    if (zipped) assert.ok(payload, 'ZIP contains an AMF document');
    const string = text(payload ? payload[1]() : bytes),
      reference = referenceAMF(string),
      g = await parseAMF(bytes),
      { min, max } = bounds(reference.positions),
      triangles = reference.indices.length / 3;
    assert.deepEqual(Array.from(g.indices), reference.indices, 'every placed triangle');
    assert.equal(g.positions.length, reference.positions.length, 'every placed vertex');
    reference.positions.forEach((value, index) =>
      assert.ok(Math.abs(g.positions[index] - value) <= 1e-6, `placed coordinate ${index}`),
    );
    return {
      result: `${checkGeometry(g, { triangles, min, max, tolerance: 1e-6 })}, unit ${g.unit}, warnings ${g.warnings?.join('; ').slice(0, 160)}`,
      draw: [mesh(g)],
    };
  },
  async md2(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    assert.equal(text(bytes.subarray(0, 4)), 'IDP2');
    const triangles = view.getInt32(32, true),
      frames = view.getInt32(40, true),
      g = parseMD2(bytes);
    assert.equal(g.frames.length, frames, 'frames');
    for (const skin of g.skins) await readsTexture(skin);
    return {
      result: `${checkGeometry(g, { triangles })}, ${frames} frames, clips ${Object.keys(g.clips ?? {}).length || g.clips?.length}`,
      draw: [mesh(g)],
    };
  },
  async pcx(bytes, item) {
    const { parsePCX } = await import('@margoengine/decoders/pcx'),
      { width, height, data } = parsePCX(bytes),
      pixels = createHash('sha256').update(data).digest('hex');
    assert.deepEqual([width, height], item.facts.size, 'size');
    assert.equal(pixels, item.facts.pixels, 'RGBA pixels equal the reference decoder');
    return { result: `${width} x ${height}, every pixel equals ${item.facts.reference}`, draw: [] };
  },
  async pdb(bytes, item) {
    const string = text(bytes).split(/^ENDMDL/m)[0],
      lines = string.match(/^(ATOM  |HETATM).*$/gm),
      kept = lines.filter((l) => l[16] === ' ' || l[16] === 'A').length,
      molecule = parsePDB(string);
    assert.equal(molecule.positions.length / 3, kept, 'atom rows');
    if (item.facts?.atoms) assert.equal(kept, item.facts.atoms, 'published atom count');
    return {
      result: `${kept} atoms, ${molecule.bonds.length / 2} bonds, ${checkGeometry(molecule)}`,
      draw: [mesh(molecule)],
    };
  },
  async kmz(bytes) {
    const files = unzip(bytes),
      kml = [...files]
        .filter(([n]) => n.endsWith('.kml'))
        .map(([, read]) => text(read()))
        .join(''),
      models = count(kml, /<Model\b/g),
      latitude = Number(kml.match(/<Location>[\s\S]*?<latitude>([-\d.]+)/)?.[1]),
      result = await parseKMZ(bytes, { origin: 'first' });
    assert.equal(result.models.length, models, 'Model elements');
    const first = result.models[0];
    assert.equal(first.location?.latitude, latitude, 'latitude');
    assert.ok(Math.hypot(...first.matrix.slice(12, 15)) < 1e-6, 'the first model sits at the origin');
    return {
      result: `${models} model, ${checkGeometry(first.mesh ?? first.geometry ?? first)}, at ${JSON.stringify(first.location)}`,
      draw: [mesh(first.mesh ?? first.geometry ?? first)],
    };
  },
  async las(bytes, item) {
    const cloud = await parseLAS(bytes),
      view = new DataView(bytes.buffer, bytes.byteOffset),
      version = bytes[25],
      legacy = view.getUint32(107, true),
      total = version >= 4 && legacy === 0 ? Number(view.getBigUint64(247, true)) : legacy;
    const stored = [179, 187, 195, 203, 211, 219].map((o) => view.getFloat64(o, true)); // max x, min x, max y, min y, max z, min z
    // A writer that stored its box as raw integers: turned to world units here by the scale and offset of the file.
    const header = item.rawHeaderBox
      ? stored.map((v, i) => v * view.getFloat64(131 + 8 * (i >> 1), true) + view.getFloat64(155 + 8 * (i >> 1), true))
      : stored;
    assert.equal(cloud.positions.length / 3, total, 'point count');
    if (total > 1) checkGeometry(cloud);
    const box = bounds(cloud.positions);
    [0, 1, 2].forEach((a) => {
      const low = box.min[a] + cloud.origin[a],
        high = box.max[a] + cloud.origin[a];
      assert.ok(
        Math.abs(low - header[a * 2 + 1]) < 0.02 && Math.abs(high - header[a * 2]) < 0.02,
        `axis ${a} bounds ${low} to ${high} differ from the header ${header[a * 2 + 1]} to ${header[a * 2]}`,
      );
    });
    return {
      result: `1.${version} format ${cloud.header.pointFormat}, ${total} points, bounds equal the header`,
      draw: total > 1 ? [mesh(cloud)] : [],
    }; // One point is too small to judge in a picture.
  },
  async lazRefused(bytes, item) {
    await assert.rejects(
      async () => parseLAS(bytes),
      (error) => error.code === 'unsupported',
    );
    return { result: `refused with code unsupported: ${item.note}` };
  },
  async laz(bytes, item, read) {
    const cloud = await parseLAS(bytes),
      version = bytes[25],
      format = bytes[104] & 63;
    const facts = [`1.${version} format ${format}, ${cloud.positions.length / 3} points with no hook`];
    checkGeometry(cloud);
    if (item.companions) {
      const pair = await parseLAS(await read(item.companions[0]));
      assert.deepEqual(cloud.positions, pair.positions, 'the LAZ and LAS files give the same positions');
      assert.deepEqual(cloud.intensity, pair.intensity, 'intensity');
      assert.deepEqual(cloud.classification, pair.classification, 'classification');
      assert.deepEqual(cloud.gpsTime, pair.gpsTime, 'GPS time');
      facts.push(`the same cloud as ${item.companions[0].file}`);
    }
    const hooks = await loadRuntimes();
    if (hooks) {
      let ours, theirs;
      await parseLAS(bytes, { decompress: async (s) => (ours = await margoRecords(s)) });
      await parseLAS(bytes, { decompress: (s) => (theirs = lazDecompress(hooks.laz)(s)) });
      assert.equal(Buffer.compare(ours, theirs), 0, 'the built-in decoder and laz-perf give the same records');
      facts.push('records byte for byte equal to laz-perf');
    }
    return { result: facts.join(', '), draw: [mesh(cloud)] };
  },
  /** A waveform file: every packet reads from the `.wdp` beside it, and the strongest sample sits where the point says. */
  async lazWaves(bytes, item, read) {
    const cloud = await parseLAS(bytes),
      { wavePackets } = cloud.points,
      source = await read(item.companions[0]),
      descriptors = lasWaveDescriptors(cloud.records);
    let waves = 0,
      located = 0;
    checkGeometry(cloud);
    for (let i = 0; i < wavePackets.descriptor.length; i++) {
      const wave = lasWaveform(cloud.points, i, source);
      if (!wave) continue;
      assert.equal(wave.raw.length, descriptors.get(wavePackets.descriptor[i]).samples, 'samples per wave');
      waves++;
      let peak = 0;
      for (let k = 1; k < wave.raw.length; k++) if (wave.raw[k] > wave.raw[peak]) peak = k;
      if (Math.abs(peak - wavePackets.location[i] / wave.spacing) <= 3) located++;
    }
    assert.ok(waves > 0, 'the file has waves');
    // Later returns of a pulse share its wave, so their location is not the strongest sample.
    assert.ok(located * 2 > waves, `the peak sits at the point's location in ${located} of ${waves} waves`);
    return {
      result: `1.${bytes[25]} format ${cloud.header.pointFormat}, ${waves} waves read from ${item.companions[0].file}, the peak at the point's location in ${located}`,
      draw: [mesh(cloud)],
    };
  },
};

/** The package's own ZIP reader over a big archive: names lower-cased to their stored spelling. */
async function zipReader(bytes) {
  const directory = readZipDirectory(bytes, { maxEntries: 100_000 });
  const list = Array.isArray(directory) ? directory : (directory.entries ?? [...directory.values()]);
  const entries = new Map(list.map((e) => [e.name.toLowerCase(), e.name]));
  const { readZipEntry } = await import('../dist/index.js');
  const byName = new Map(list.map((e) => [e.name, e]));
  return { entries, read: (name) => readZipEntry(bytes, byName.get(name)) };
}

const report = [];
const drawings = [];
for (const item of manifest.files) {
  if (only && !only.includes(item.format) && !only.includes(item.id)) continue;
  const row = { id: item.id, format: item.format, file: item.file };
  try {
    const bytes = await fetchChecked(item, item.format);
    const read = (companion) => fetchChecked(companion, item.format);
    const outcome = await checks[item.check](bytes, item, read);
    if (outcome.notRun) {
      row.status = 'NOT RUN';
      row.result = outcome.notRun;
    } else {
      row.status = 'PASS';
      row.result = outcome.result;
      for (const d of outcome.draw ?? []) {
        drawings.push({ ...d, id: item.id });
        // Files with vertex colours are drawn a second time through the /render entry.
        if (d.geometry?.colors && d.geometry.indices) drawings.push({ ...d, id: item.id, pbr: true });
      }
    }
  } catch (error) {
    row.status = error.notRun ? 'NOT RUN' : 'FAIL';
    row.result = `${error.code ?? error.name}: ${error.message}`.slice(0, 400);
    if (process.env.REAL_FILES_TRACE) console.error(error);
  }
  report.push(row);
  console.log(`${row.status.padEnd(7)} ${row.id}: ${row.result}`);
}
await mkdir(root, { recursive: true });
await writeFile(resolve(root, 'report.json'), JSON.stringify(report, null, 2));
if (process.env.REAL_FILES_RENDER === '1') {
  const { renderAll } = await import('./real-files-render.mjs');
  await renderAll(drawings, resolve(root, 'pictures'), report);
}
const failed = report.filter((r) => r.status === 'FAIL'),
  notRun = report.filter((r) => r.status === 'NOT RUN');
console.log(
  `${report.length} files: ${report.length - failed.length - notRun.length} passed, ${failed.length} failed, ${notRun.length} not run`,
);
if (failed.length) process.exitCode = 1;
else if (notRun.length) process.exitCode = 2;
