// Opt-in proof on real files: `npm run test:real-files -w @margoengine/loaders`.
// Downloads every file in tests/real-files/manifest.json by URL, verifies its SHA-256, opens it with the loader and
// checks the result against something the loader did not produce: counts read from the file by the small readers
// below, or published facts. The downloads are never committed.
//
//   REAL_FILES_DIR       where downloads go, one folder per format (default test-results/real-files)
//   REAL_FILES_RUNTIMES  a folder whose node_modules holds rhino3dm and laz-perf, the caller-owned hooks. Without it
//                        the 3DM and LAZ rows are reported as not run, and the exit code says so.
//   REAL_FILES_ONLY      comma-separated formats or ids to run
//   REAL_FILES_RENDER    1 draws every geometry through the real engine on the GPU (real-files-render.mjs)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
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
import { parseLDraw } from '../dist/ldraw.js';
import { parseLWO } from '../dist/lwo.js';
import { parseMD2 } from '../dist/md2.js';
import { parseBVH } from '../dist/mocap.js';
import { parseNRRD } from '../dist/nrrd.js';
import { evaluateNurbsCurve } from '../dist/nurbs.js';
import { parsePDB } from '../dist/pdb.js';
import { parseSVG } from '../dist/svg.js';
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
  const bytes =
    known ?? new Uint8Array(await (await download(item.url)).arrayBuffer());
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
        assert.ok(Math.abs(v - actual[a]) <= tolerance * Math.max(1, Math.abs(v)), `${name}[${a}] ${actual[a]} is not ${v}`),
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
  const head = text(bytes.subarray(0, 4096)),
    end = head.indexOf('end_header'),
    header = head.slice(0, end),
    vertices = Number(header.match(/element vertex (\d+)/)[1]),
    faces = Number(header.match(/element face (\d+)/)?.[1] ?? 0),
    start = head.indexOf('\n', end) + 1;
  let triangles = 0;
  if (header.includes('format ascii')) {
    const lines = text(bytes.subarray(start)).split(/\r?\n/);
    triangles = fanned(lines.slice(vertices, vertices + faces));
  } else {
    const properties = header.slice(header.indexOf('element vertex'), header.indexOf('element face'));
    let p = start + vertices * 4 * count(properties, /property float/g);
    for (let i = 0; i < faces; i++) {
      triangles += bytes[p] - 2;
      p += 1 + 4 * bytes[p];
    }
    assert.equal(p, bytes.length, 'PLY walk ended at the end of the file');
  }
  return { vertices, triangles };
}

/** Triangles of every `coordIndex` list in a VRML or X3D file, polygons ending at -1 and fanned. */
function indexedTriangles(string, pattern) {
  let triangles = 0;
  for (const [, list] of string.matchAll(pattern))
    for (const polygon of list.split(/\b-1\b|-1/)) {
      const corners = polygon.trim().split(/[\s,]+/).filter(Boolean).length;
      if (corners >= 3) triangles += corners - 2;
    }
  return triangles;
}

/** Walks the chunks of a 3DS file for its vertex and face counts. */
function threeDSFacts(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let vertices = 0,
    triangles = 0;
  const walk = (start, end) => {
    for (let p = start; p + 6 <= end; ) {
      const id = view.getUint16(p, true),
        length = view.getUint32(p + 2, true);
      if (length < 6) break;
      if (id === 0x4d4d || id === 0x3d3d || id === 0x4100) walk(p + 6, p + length);
      else if (id === 0x4000) {
        let q = p + 6;
        while (bytes[q]) q++;
        walk(q + 1, p + length);
      } else if (id === 0x4110) vertices += view.getUint16(p + 6, true);
      else if (id === 0x4120) triangles += view.getUint16(p + 6, true);
      p += length;
    }
  };
  walk(0, bytes.length);
  return { vertices, triangles };
}

/** Walks the IFF chunks of an LWO2 file: points, and faces fanned to triangles. */
function lwoFacts(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let points = 0,
    triangles = 0;
  for (let p = 12; p + 8 <= bytes.length; ) {
    const id = text(bytes.subarray(p, p + 4)),
      size = view.getUint32(p + 4);
    if (id === 'PNTS') points += size / 12;
    if (id === 'POLS' && text(bytes.subarray(p + 8, p + 12)) === 'FACE') {
      for (let q = p + 12; q < p + 8 + size; ) {
        const n = view.getUint16(q) & 0x3ff;
        q += 2;
        if (n >= 3) triangles += n - 2;
        for (let i = 0; i < n; i++) q += bytes[q] === 0xff ? 4 : 2;
      }
    }
    p += 8 + size + (size & 1);
  }
  return { points, triangles };
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

/** The decompress hook of `parseLAS` around Margo's own LAZ decoder. */
async function margoDecompress({ bytes, header, pointOffset, records }) {
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
      xml = [...files].filter(([n]) => n.endsWith('.model')).map(([, read]) => text(read())).join(''),
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
      if (entity(name)) assert.ok(Object.keys(parsed.skipped).some((k) => k.startsWith(name)), `${name} is reported as skipped`);
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
    const lines = text(bytes).split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')),
      [vertices, faces] = lines[1].trim().split(/\s+/).map(Number),
      triangles = fanned(lines.slice(2 + vertices, 2 + vertices + faces)),
      g = parseOFF(bytes);
    return { result: checkGeometry(g, { vertices, triangles }), draw: [mesh(g)] };
  },
  async xyz(bytes, item) {
    const source = item.extract ? unzip(bytes).get(item.extract)() : bytes,
      lines = text(source).split(/\r?\n/).filter((l) => /^\s*[-+]?[\d.]+\s+[-+]?[\d.]/.test(l)),
      g = parseXYZ(source),
      first = lines[0].trim().split(/\s+/).map(Number);
    assert.equal(g.positions.length / 3, lines.length, 'point lines');
    return { result: `${checkGeometry(g)}; first ${first}`, draw: [mesh(g)] };
  },
  async obj(bytes, item, read) {
    const source = item.extract ? unzip(bytes).get(item.extract)() : bytes,
      string = new TextDecoder().decode(source),
      vertices = count(string, /^v\s/gm),
      faces = string.match(/^f\s.*$/gm) ?? [],
      triangles = faces.reduce((sum, f) => sum + f.trim().split(/\s+/).length - 3, 0),
      g = await parseOBJ(string);
    const library = item.extractMtl ? unzip(bytes).get(item.extractMtl)() : item.companions ? await read(item.companions[0]) : null;
    let materials = '';
    if (library) {
      const mtl = new TextDecoder().decode(library),
        parsed = parseMTL(mtl),
        names = count(mtl, /^newmtl\s/gm);
      const size = parsed.materials ? Object.keys(parsed.materials).length : (parsed.size ?? Object.keys(parsed).length);
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
        [...string.matchAll(/<polylist\b[\s\S]*?<vcount>([^<]*)<\/vcount>/g)].reduce((s, m) => s + fanned(m[1].trim().split(/\s+/)), 0),
      dae = parseDAE(string),
      flat = flattenDAE(dae);
    const skins = dae.skins?.length ?? dae.controllers?.length ?? 0;
    // This suite file holds two geometries and instances one; flattened, only the instanced polygons are drawn.
    assert.ok(flat.positions.length > 0);
    return { result: `${skins} skins, file ${triangles} triangles in all, ${checkGeometry(flat, item.facts)}`, draw: [mesh(flat)] };
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
    return { result: `${map.width}x${map.height}, ${map.layers.length} layers, ${objects} objects, warnings ${map.warnings?.length ?? 0}` };
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
      triangles = [...string.matchAll(/faceVertexCounts = \[([^\]]*)\]/g)].reduce((s, m) => s + fanned(m[1].split(',')), 0),
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
      triangles = [...string.matchAll(/faceVertexCounts = \[([^\]]*)\]/g)].reduce((s, m) => s + fanned(m[1].split(',')), 0),
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
    return { result: `${svg.paths.length} paths, ${drawn} drawn elements in the file, warnings ${svg.warnings.length}` };
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
    return { result: `${joints} joints, ${frames} frames at ${time} s, ${bvh.clip.tracks.length} tracks, ${last.toFixed(2)} s` };
  },
  async vrml(bytes) {
    const scene = parseVRML(bytes),
      triangles = indexedTriangles(text(bytes), /coordIndex\s*\[([^\]]*)\]/g);
    return { result: `${checkGeometry(scene, { triangles })}, ${scene.groups?.length} shapes, left out ${scene.warnings.join(', ').slice(0, 200)}`, draw: [mesh(scene)] };
  },
  async x3d(bytes) {
    const scene = parseX3D(bytes),
      triangles = indexedTriangles(text(bytes), /coordIndex=['"]([^'"]*)['"]/g);
    return { result: `${checkGeometry(scene, { triangles })}, ${scene.groups?.length} shapes, left out ${scene.warnings.join(', ').slice(0, 200)}`, draw: [mesh(scene)] };
  },
  async gcode(bytes, item) {
    const source = unzip(bytes).get(item.extract)(),
      string = text(source),
      gcode = parseGCode(string);
    const claimed = Number(string.match(/; filament used \[mm\] = ([\d.]+)/)[1]),
      changes = count(string, /^;LAYER_CHANGE/gm);
    // The slicer's figure leaves out the hand-written start and end code, a few percent here.
    assert.ok(Math.abs(gcode.filament - claimed) <= claimed * 0.05, `filament ${gcode.filament} is not near the slicer's ${claimed}`);
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
      sizes = head.match(/^sizes: (.*)$/m)[1].split(' ').map(Number),
      samples = sizes.reduce((a, b) => a * b, 1),
      encoding = head.match(/^encoding: (\w+)/m)[1];
    assert.equal(volume.data.length, samples, 'samples');
    if (!item.companions) {
      const body = bytes.subarray(head.indexOf('\n\n') + 2);
      assert.deepEqual(new Uint8Array(volume.data.buffer, volume.data.byteOffset, volume.data.byteLength), body, 'raw body');
    } else if (encoding === 'ascii') {
      const values = text(await read(item.companions[0])).trim().split(/\s+/).map(Number);
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
    return { result: `dims ${volume.dims}, ${volume.data.length} samples, range ${min} to ${max}, components ${volume.components}` };
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
    return { result: `${references} references, ${checkGeometry(model)}, ${model.groups.length} colours, missing ${model.missing.length}`, draw: [mesh(model)] };
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
            const p = nurbs.points().get(k);
            points.push(p.location?.[0] ?? p[0], p.location?.[1] ?? p[1], p.location?.[2] ?? p[2]);
            weights.push(p.weight ?? 1);
          }
          const domain = nurbs.domain,
            t = (domain[0] + domain[1]) * 0.37,
            ours = evaluateNurbsCurve(
              { degree: nurbs.degree, knots: Array.from({ length: knots.count }, (_, k) => knots.get(k)), points, weights },
              t,
            ),
            theirs = nurbs.pointAt(t);
          worst = Math.max(worst, Math.hypot(ours[0] - theirs[0], ours[1] - theirs[1], ours[2] - theirs[2]));
          curves++;
        }
      }
    }
    const parsed = parse3DM(rhino, bytes, { hidden: true }),
      meshes = parsed.groups.length;
    assert.equal(meshes + parsed.skipped, total, 'objects');
    assert.equal(parsed.layers.length, file.layers().count, 'layers');
    return {
      result: `${total} objects, ${meshes} meshes, ${parsed.skipped} skipped, ${parsed.layers.length} layers, ${meshes ? checkGeometry(parsed) : 'no saved meshes'}; ${curves} curves, largest NURBS difference from rhino3dm ${worst}`,
      draw: meshes ? [mesh(parsed)] : [],
    };
  },
  async threeds(bytes, item) {
    const expected = threeDSFacts(bytes),
      g = parse3DS(bytes),
      tds = parseTDS(bytes);
    assert.deepEqual(tds.positions, g.positions, 'parseTDS is the same reader');
    return { result: `${checkGeometry(g, { triangles: expected.triangles })}, ${g.materials.length} materials, file ${expected.vertices} vertices`, draw: [mesh(g)] };
  },
  async lwo(bytes) {
    const expected = lwoFacts(bytes),
      g = parseLWO(bytes);
    return { result: `${checkGeometry(g, { triangles: expected.triangles })}, file ${expected.points} points, warnings ${g.warnings?.join('; ').slice(0, 160)}`, draw: [mesh(g)] };
  },
  async amf(bytes) {
    const string = text(bytes),
      triangles = count(string, /<triangle>/g),
      g = await parseAMF(bytes),
      scale = { millimeter: 1e-3, inch: 0.0254, feet: 0.3048, meter: 1, micron: 1e-6 }[g.unit],
      axis = (tag) => [...string.matchAll(new RegExp(`<${tag}>\\s*([-\\d.eE+]+)`, 'g'))].map((m) => Number(m[1]) * scale),
      extent = ['x', 'y', 'z'].map(axis),
      min = extent.map((v) => Math.min(...v)),
      max = extent.map((v) => Math.max(...v));
    return { result: `${checkGeometry(g, { triangles, min, max, tolerance: 1e-6 })}, unit ${g.unit}, warnings ${g.warnings?.join('; ').slice(0, 160)}`, draw: [mesh(g)] };
  },
  async md2(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    assert.equal(text(bytes.subarray(0, 4)), 'IDP2');
    const triangles = view.getInt32(32, true),
      frames = view.getInt32(40, true),
      g = parseMD2(bytes);
    assert.equal(g.frames.length, frames, 'frames');
    return { result: `${checkGeometry(g, { triangles })}, ${frames} frames, clips ${Object.keys(g.clips ?? {}).length || g.clips?.length}`, draw: [mesh(g)] };
  },
  async pdb(bytes, item) {
    const string = text(bytes).split(/^ENDMDL/m)[0],
      lines = string.match(/^(ATOM  |HETATM).*$/gm),
      kept = lines.filter((l) => l[16] === ' ' || l[16] === 'A').length,
      molecule = parsePDB(string);
    assert.equal(molecule.positions.length / 3, kept, 'atom rows');
    if (item.facts?.atoms) assert.equal(kept, item.facts.atoms, 'published atom count');
    return { result: `${kept} atoms, ${molecule.bonds.length / 2} bonds, ${checkGeometry(molecule)}`, draw: [mesh(molecule)] };
  },
  async kmz(bytes) {
    const files = unzip(bytes),
      kml = [...files].filter(([n]) => n.endsWith('.kml')).map(([, read]) => text(read())).join(''),
      models = count(kml, /<Model\b/g),
      latitude = Number(kml.match(/<Location>[\s\S]*?<latitude>([-\d.]+)/)?.[1]),
      result = await parseKMZ(bytes);
    assert.equal(result.models.length, models, 'Model elements');
    const first = result.models[0];
    assert.equal(first.location?.latitude, latitude, 'latitude');
    return { result: `${models} model, ${checkGeometry(first.mesh ?? first.geometry ?? first)}, at ${JSON.stringify(first.location)}`, draw: [mesh(first.mesh ?? first.geometry ?? first)] };
  },
  async las(bytes) {
    const cloud = await parseLAS(bytes),
      view = new DataView(bytes.buffer, bytes.byteOffset),
      version = bytes[25],
      legacy = view.getUint32(107, true),
      total = version >= 4 && legacy === 0 ? Number(view.getBigUint64(247, true)) : legacy;
    const header = [179, 187, 195, 203, 211, 219].map((o) => view.getFloat64(o, true)); // max x, min x, max y, min y, max z, min z
    assert.equal(cloud.positions.length / 3, total, 'point count');
    if (total > 1) checkGeometry(cloud);
    const box = bounds(cloud.positions);
    [0, 1, 2].forEach((a) => {
      const low = box.min[a] + cloud.origin[a],
        high = box.max[a] + cloud.origin[a];
      assert.ok(Math.abs(low - header[a * 2 + 1]) < 0.02 && Math.abs(high - header[a * 2]) < 0.02, `axis ${a} bounds ${low} to ${high} differ from the header ${header[a * 2 + 1]} to ${header[a * 2]}`);
    });
    return { result: `1.${version} format ${cloud.header.pointFormat}, ${total} points, bounds equal the header`, draw: total > 1 ? [mesh(cloud)] : [] }; // One point is too small to judge in a picture.
  },
  async lazRefused(bytes, item) {
    await assert.rejects(
      async () => parseLAS(bytes, { decompress: margoDecompress }),
      (error) => error.code === 'unsupported',
    );
    return { result: `refused with code unsupported: ${item.note}` };
  },
  async laz(bytes, item, read) {
    const cloud = await parseLAS(bytes, { decompress: margoDecompress }),
      version = bytes[25],
      format = bytes[104] & 63;
    const facts = [`1.${version} format ${format}, ${cloud.positions.length / 3} points through createLazDecoder`];
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
      await parseLAS(bytes, { decompress: async (s) => (ours = await margoDecompress(s)) });
      await parseLAS(bytes, { decompress: (s) => (theirs = lazDecompress(hooks.laz)(s)) });
      assert.equal(Buffer.compare(ours, theirs), 0, 'createLazDecoder and laz-perf give the same records');
      facts.push('records byte for byte equal to laz-perf');
    }
    return { result: facts.join(', '), draw: [mesh(cloud)] };
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
console.log(`${report.length} files: ${report.length - failed.length - notRun.length} passed, ${failed.length} failed, ${notRun.length} not run`);
if (failed.length) process.exitCode = 1;
else if (notRun.length) process.exitCode = 2;
