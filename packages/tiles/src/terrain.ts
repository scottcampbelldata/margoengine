// @margoengine/tiles/terrain: quantized-mesh terrain with draped map imagery, so a globe works without a
// photogrammetry dataset. `terrain(layerUrl, options)` gives a tileset URL and a fetch for `TilesRenderer.load`: the
// layer's two geographic root tiles become a 3D Tiles tileset with implicit quadtrees over regions, and each terrain
// tile is turned, on request, into b3dm content (a glTF mesh with skirts, RTC-centred in float64, its imagery as the
// texture), so selection, streaming, the budget and the floating origin are the tileset's own. Written from the
// quantized-mesh-1.0 specification (CesiumGS/quantized-mesh README: header, zig-zag deltas, high-water-mark indices,
// edge lists, extensions), the layer.json manifest it describes, the OSGeo Tile Map Service and the Web Mercator
// (EPSG:3857) tiling, and 3D Tiles 1.1 implicit tiling.
import { MargoError } from '@margoengine/math/errors';
import { GLB_BIN, GLB_JSON, GLB_MAGIC } from '../../shared/glb.js';
import { type TileMatrix, Z_UP_TO_Y_UP, invert, multiply } from './matrix.js';
import { cartographicToEcef, eastNorthUpToEcef, WGS84_A } from './wgs84.js';

/** A decoded quantized-mesh-1.0 tile. */
export interface QuantizedMesh {
  /** Tile centre, ECEF metres (float64). */
  readonly center: readonly [number, number, number];
  readonly minimumHeight: number;
  readonly maximumHeight: number;
  readonly boundingSphere: readonly [number, number, number, number];
  readonly horizonOcclusionPoint: readonly [number, number, number];
  /** 0..32767 west to east, south to north, and 0..32767 from minimumHeight to maximumHeight, per vertex. */
  readonly u: Uint16Array;
  readonly v: Uint16Array;
  readonly height: Uint16Array;
  /** Triangles, counter-clockwise. */
  readonly indices: Uint16Array | Uint32Array;
  readonly west: Uint16Array | Uint32Array;
  readonly south: Uint16Array | Uint32Array;
  readonly east: Uint16Array | Uint32Array;
  readonly north: Uint16Array | Uint32Array;
  /** Oct-encoded normals (extension 1), two bytes per vertex. */
  readonly normals?: Uint8Array;
  /** Water mask (extension 2): one byte, or 256 x 256. */
  readonly waterMask?: Uint8Array;
  /** Metadata JSON (extension 4). */
  readonly metadata?: unknown;
}

const bad = (why: string) =>
  new RangeError(`Invalid quantized-mesh tile: ${why}; the file is cut or not quantized-mesh-1.0`);

/** Decodes a quantized-mesh-1.0 tile (not gzipped). Throws RangeError when it is cut short or inconsistent. */
export function parseQuantizedMesh(bytes: Uint8Array): QuantizedMesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const need = (n: number, what: string) => {
    if (at + n > bytes.byteLength) throw bad(`${what} runs past the end (${bytes.byteLength} bytes)`);
  };
  const f64 = () => ((at += 8), view.getFloat64(at - 8, true));
  need(88, 'the header');
  const center = [f64(), f64(), f64()] as [number, number, number];
  const minimumHeight = view.getFloat32(at, true),
    maximumHeight = view.getFloat32(at + 4, true);
  at += 8;
  const boundingSphere = [f64(), f64(), f64(), f64()] as [number, number, number, number],
    horizonOcclusionPoint = [f64(), f64(), f64()] as [number, number, number];
  need(4, 'vertexCount');
  const count = view.getUint32(at, true);
  at += 4;
  need(count * 6, 'the vertex data');
  const decode = () => {
    const out = new Uint16Array(count);
    let value = 0;
    for (let i = 0; i < count; i++) {
      const z = view.getUint16(at + i * 2, true);
      // zig-zag: 0, -1, 1, -2, 2 ... as 0, 1, 2, 3, 4 ...
      value += (z >> 1) ^ -(z & 1);
      if (value < 0 || value > 32767) throw bad(`a vertex coordinate decodes to ${value}, outside 0..32767`);
      out[i] = value;
    }
    at += count * 2;
    return out;
  };
  const u = decode(),
    v = decode(),
    height = decode();
  const wide = count > 65536,
    size = wide ? 4 : 2;
  if (at % size) at += size - (at % size);
  const list = (n: number, what: string): Uint16Array | Uint32Array => {
    need(n * size, what);
    const out = wide ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) out[i] = wide ? view.getUint32(at + i * 4, true) : view.getUint16(at + i * 2, true);
    at += n * size;
    return out;
  };
  need(4, 'triangleCount');
  const triangles = view.getUint32(at, true);
  at += 4;
  const indices = list(triangles * 3, 'the triangle indices');
  // High-water-mark decoding: each code is the distance below the highest index so far; 0 introduces a new vertex.
  let highest = 0;
  for (let i = 0; i < indices.length; i++) {
    const code = indices[i];
    indices[i] = highest - code;
    if (highest - code < 0 || highest - code >= count) throw bad(`triangle index ${highest - code} is not a vertex`);
    if (code === 0) highest++;
  }
  const edge = (what: string) => {
    need(4, what);
    const n = view.getUint32(at, true);
    at += 4;
    const out = list(n, what);
    for (const index of out) if (index >= count) throw bad(`${what} index ${index} is not a vertex`);
    return out;
  };
  const west = edge('the west edge'),
    south = edge('the south edge'),
    east = edge('the east edge'),
    north = edge('the north edge');
  let normals: Uint8Array | undefined, waterMask: Uint8Array | undefined, metadata: unknown;
  while (at < bytes.byteLength) {
    need(5, 'an extension header');
    const id = view.getUint8(at),
      length = view.getUint32(at + 1, true);
    at += 5;
    need(length, `extension ${id}`);
    const data = bytes.subarray(at, at + length);
    if (id === 1) {
      if (length !== count * 2) throw bad(`the normals extension holds ${length} bytes for ${count} vertices`);
      normals = data;
    } else if (id === 2) waterMask = data;
    else if (id === 4) {
      const json = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (length < 4 || json.getUint32(0, true) + 4 > length) throw bad('the metadata extension is cut');
      metadata = JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + json.getUint32(0, true))));
    }
    // Unknown extensions are skipped by their length, as the specification allows.
    at += length;
  }
  return {
    center,
    minimumHeight,
    maximumHeight,
    boundingSphere,
    horizonOcclusionPoint,
    u,
    v,
    height,
    indices,
    west,
    south,
    east,
    north,
    normals,
    waterMask,
    metadata,
  };
}

/** A geographic rectangle, radians: west, south, east, north. */
export type Rectangle = readonly [number, number, number, number];

/** The rectangle of TMS geographic (EPSG:4326) tile (z, x, y): two root tiles, y numbered from the south. */
export function geographicTileRectangle(z: number, x: number, y: number): Rectangle {
  const size = Math.PI / 2 ** z;
  return [-Math.PI + x * size, -Math.PI / 2 + y * size, -Math.PI + (x + 1) * size, -Math.PI / 2 + (y + 1) * size];
}

/** Decodes an oct-encoded unit vector from two bytes (Cigolle et al. 2014). */
function octDecode(x: number, y: number): [number, number, number] {
  let nx = (x / 255) * 2 - 1,
    ny = (y / 255) * 2 - 1;
  const nz = 1 - Math.abs(nx) - Math.abs(ny);
  if (nz < 0) {
    const ox = nx;
    nx = (1 - Math.abs(ny)) * Math.sign(ox || 1);
    ny = (1 - Math.abs(ox)) * Math.sign(ny || 1);
  }
  const l = Math.hypot(nx, ny, nz);
  return [nx / l, ny / l, nz / l];
}

/** Imagery to drape: a URL template of map tiles, and how they are laid out. */
export interface TerrainImagery {
  /** A URL template with `{z}`, `{x}` and `{y}`, such as an XYZ (slippy map) tile server's. Relative to the page. */
  url: string;
  /** `'EPSG:3857'` (default): Web Mercator, one root tile, as XYZ servers use; `'EPSG:4326'`: geographic, two roots. */
  projection?: 'EPSG:3857' | 'EPSG:4326';
  /** `'xyz'` (default for 3857): y from the north; `'tms'` (default for 4326): y from the south. */
  scheme?: 'xyz' | 'tms';
  /** Deepest level the server has. Default 19. */
  maximumLevel?: number;
  /** Image MIME type of the tiles. Default from the URL's extension, else `image/png`. */
  mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
}

/** Options of `terrain`. */
export interface TerrainOptions {
  /** Imagery draped over the terrain. Without it the terrain draws lit in grey. */
  imagery?: TerrainImagery;
  /** Fetch for the terrain and imagery requests (auth headers, tests). Default `globalThis.fetch`. */
  fetch?: (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;
  /** Skirt depth as a share of a tile's geometric error, hiding cracks between levels. Default 2. */
  skirt?: number;
  /** Subtree levels of the implicit tileset. Default 4. */
  subtreeLevels?: number;
}

interface Layer {
  tiles: string[];
  version?: string;
  scheme?: string;
  projection?: string;
  extensions?: string[];
  maxzoom?: number;
  available?: { startX: number; startY: number; endX: number; endY: number }[][];
}

/** Geometric error of a level-0 tile: its width at the equator over the 64 spans of a typical 65-sample tile. */
export const LEVEL_ZERO_ERROR = (Math.PI * WGS84_A) / 64;
/** Heights every tile's region covers, metres: the lowest and highest ground on earth with room to spare. */
const LOW = -500,
  HIGH = 9000;

const failed = (url: string, status: number) =>
  new MargoError('failed', `Terrain request ${url} answered ${status}; check the layer URL and its access`);

/** What `terrain` returns: pass both to `TilesRenderer.load(engine, url, { fetch })`. */
export interface TerrainSource {
  /** The URL of the generated tileset. */
  readonly url: string;
  /** Serves the generated tileset, subtrees and b3dm tiles, and passes anything else on. */
  readonly fetch: (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  /** The deepest terrain level. */
  readonly maximumLevel: number;
}

/**
 * Reads a quantized-mesh layer (its `layer.json`) and returns a tileset URL and fetch for `TilesRenderer.load`. Only
 * the `EPSG:4326` projection and the `tms` scheme are read, the layout terrain servers use.
 */
export async function terrain(layerUrl: string | URL, options: TerrainOptions = {}): Promise<TerrainSource> {
  const base = new URL(String(layerUrl), globalThis.location?.href).href,
    outer = options.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await outer(base);
  if (!response.ok) throw failed(base, response.status);
  const layer = (await response.json()) as Layer;
  if (!Array.isArray(layer.tiles) || typeof layer.tiles[0] !== 'string')
    throw new TypeError(`Invalid terrain layer ${base}: tiles is missing; give a URL template in "tiles"`);
  if ((layer.projection ?? 'EPSG:4326') !== 'EPSG:4326' || (layer.scheme ?? 'tms') !== 'tms')
    throw new MargoError(
      'unsupported',
      `Terrain layer ${base} is ${layer.projection ?? 'EPSG:4326'} ${layer.scheme ?? 'tms'}; only EPSG:4326 tms layers are read`,
    );
  const maximumLevel = layer.available?.length ? layer.available.length - 1 : (layer.maxzoom ?? 19),
    subtreeLevels = options.subtreeLevels ?? 4,
    extensions = (layer.extensions ?? []).filter((e) => e === 'octvertexnormals' || e === 'watermask'),
    accept = `application/vnd.quantized-mesh${extensions.length ? `;extensions=${extensions.join('-')}` : ''},application/octet-stream;q=0.9`,
    skirt = options.skirt ?? 2;
  const available = (z: number, x: number, y: number) => {
    if (z > maximumLevel || x < 0 || y < 0 || x >= 2 ** (z + 1) || y >= 2 ** z) return false;
    const ranges = layer.available?.[z];
    if (!layer.available) return true;
    return !!ranges?.some((r) => x >= r.startX && x <= r.endX && y >= r.startY && y <= r.endY);
  };
  const tileUrl = (z: number, x: number, y: number) =>
    new URL(
      layer.tiles[0]
        .replace(/\{z\}/g, String(z))
        .replace(/\{x\}/g, String(x))
        .replace(/\{y\}/g, String(y))
        .replace(/\{version\}/g, layer.version ?? '1.0.0'),
      base,
    ).href;
  const root = 'margo-terrain:/',
    json = {
      asset: { version: '1.1' },
      geometricError: LEVEL_ZERO_ERROR * 2,
      root: {
        boundingVolume: { region: [-Math.PI, -Math.PI / 2, Math.PI, Math.PI / 2, LOW, HIGH] },
        geometricError: LEVEL_ZERO_ERROR * 2,
        refine: 'REPLACE',
        children: [0, 1].map((x) => ({
          boundingVolume: { region: [...geographicTileRectangle(0, x, 0), LOW, HIGH] },
          geometricError: LEVEL_ZERO_ERROR,
          refine: 'REPLACE',
          content: { uri: `${x}/{level}/{x}/{y}.b3dm` },
          implicitTiling: {
            subdivisionScheme: 'QUADTREE',
            subtreeLevels,
            availableLevels: maximumLevel + 1,
            subtrees: { uri: `${x}/{level}/{x}/{y}.subtree` },
          },
        })),
      },
    };
  const encoder = new TextEncoder();
  const serve = async (path: string, signal?: AbortSignal): Promise<Uint8Array> => {
    if (path === 'tileset.json') return encoder.encode(JSON.stringify(json));
    const match = /^([01])\/(\d+)\/(\d+)\/(\d+)\.(subtree|b3dm)$/.exec(path);
    if (!match)
      throw new TypeError(`Unknown terrain path ${path}; request only the URLs of the tileset terrain() made`);
    const [, r, l, ix, iy, kind] = match,
      level = Number(l),
      // Implicit tile (level, x, y) under root r is terrain tile (level, r * 2^level + x, y).
      x = Number(r) * 2 ** level + Number(ix),
      y = Number(iy);
    if (kind === 'subtree') return subtreeFile(level, x, y, subtreeLevels, available);
    const terrainUrl = tileUrl(level, x, y),
      answer = await outer(terrainUrl, { signal, headers: { Accept: accept } });
    if (!answer.ok) throw failed(terrainUrl, answer.status);
    const mesh = parseQuantizedMesh(new Uint8Array(await answer.arrayBuffer())),
      rectangle = geographicTileRectangle(level, x, y),
      image = options.imagery ? await imageryFor(options.imagery, rectangle, level, outer, signal) : undefined;
    return meshB3dm(mesh, rectangle, image, (LEVEL_ZERO_ERROR / 2 ** level) * skirt);
  };
  return {
    url: `${root}tileset.json`,
    maximumLevel,
    fetch: async (input, init) => {
      const url = String(input);
      if (!url.startsWith(root)) return outer(url, init);
      const body = await serve(url.slice(root.length), init?.signal);
      return new Response(body as Uint8Array<ArrayBuffer>, { status: 200 });
    },
  };
}

/** The availability subtree (binary) of terrain levels `level` .. `level + levels - 1` below terrain tile (x, y). */
function subtreeFile(
  level: number,
  x: number,
  y: number,
  levels: number,
  available: (z: number, x: number, y: number) => boolean,
): Uint8Array {
  const tiles: boolean[] = [];
  for (let l = 0; l < levels; l++)
    for (let m = 0; m < 4 ** l; m++) {
      let dx = 0,
        dy = 0;
      for (let b = 0; b < l; b++) {
        dx |= ((m >> (2 * b)) & 1) << b;
        dy |= ((m >> (2 * b + 1)) & 1) << b;
      }
      tiles.push(available(level + l, x * 2 ** l + dx, y * 2 ** l + dy));
    }
  const children: boolean[] = [];
  for (let m = 0; m < 4 ** levels; m++) {
    let dx = 0,
      dy = 0;
    for (let b = 0; b < levels; b++) {
      dx |= ((m >> (2 * b)) & 1) << b;
      dy |= ((m >> (2 * b + 1)) & 1) << b;
    }
    children.push(available(level + levels, x * 2 ** levels + dx, y * 2 ** levels + dy));
  }
  const bits = (list: boolean[]) => {
    const out = new Uint8Array(Math.ceil(list.length / 8));
    list.forEach((b, i) => {
      if (b) out[i >> 3] |= 1 << (i & 7);
    });
    return out;
  };
  const views: { buffer: 0; byteOffset: number; byteLength: number }[] = [],
    chunks: Uint8Array[] = [];
  let offset = 0;
  const stream = (list: boolean[]) => {
    if (list.every((b) => b)) return { constant: 1 };
    if (!list.some((b) => b)) return { constant: 0 };
    const data = bits(list);
    views.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength });
    chunks.push(data);
    offset += Math.ceil(data.byteLength / 8) * 8;
    return { bitstream: views.length - 1 };
  };
  const tileAvailability = stream(tiles),
    body: Record<string, unknown> = {
      tileAvailability,
      contentAvailability: [tileAvailability],
      childSubtreeAvailability: stream(children),
    };
  if (offset) {
    body.buffers = [{ byteLength: offset }];
    body.bufferViews = views;
  }
  const jsonBytes = padded(new TextEncoder().encode(JSON.stringify(body)), 0x20),
    binary = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) {
    binary.set(chunk, at);
    at += Math.ceil(chunk.byteLength / 8) * 8;
  }
  const out = new Uint8Array(24 + jsonBytes.byteLength + binary.byteLength),
    view = new DataView(out.buffer);
  view.setUint32(0, 0x74627573, true); // "subt"
  view.setUint32(4, 1, true);
  view.setBigUint64(8, BigInt(jsonBytes.byteLength), true);
  view.setBigUint64(16, BigInt(binary.byteLength), true);
  out.set(jsonBytes, 24);
  out.set(binary, 24 + jsonBytes.byteLength);
  return out;
}

/** `bytes` padded with `fill` to a multiple of 8. */
function padded(bytes: Uint8Array, fill: number): Uint8Array {
  const out = new Uint8Array(Math.ceil(bytes.byteLength / 8) * 8).fill(fill);
  out.set(bytes);
  return out;
}

const MAX_MERCATOR = Math.atan(Math.sinh(Math.PI));

/** The imagery tile covering `rectangle` and how lon/lat map into it. */
interface Drape {
  bytes: Uint8Array;
  mimeType: string;
  /** Texture coordinates of a longitude and latitude (radians). */
  uv(longitude: number, latitude: number): [number, number];
}

/**
 * Fetches the deepest imagery tile (at most one level below the terrain's, and at most `maximumLevel`) that holds the
 * whole terrain tile, so one texture drapes it.
 */
async function imageryFor(
  imagery: TerrainImagery,
  [west, south, east, north]: Rectangle,
  level: number,
  fetcher: NonNullable<TerrainOptions['fetch']>,
  signal?: AbortSignal,
): Promise<Drape> {
  const projection = imagery.projection ?? 'EPSG:3857',
    mercator = projection === 'EPSG:3857',
    scheme = imagery.scheme ?? (mercator ? 'xyz' : 'tms'),
    top = imagery.maximumLevel ?? 19;
  // Fraction across the projected world, x from the west, y from the north, 0..1.
  const fx = (longitude: number) => (longitude + Math.PI) / (2 * Math.PI);
  const fy = (latitude: number) => {
    if (!mercator) return (Math.PI / 2 - latitude) / Math.PI;
    const clamped = Math.max(-MAX_MERCATOR, Math.min(MAX_MERCATOR, latitude));
    return (1 - Math.log(Math.tan(Math.PI / 4 + clamped / 2)) / Math.PI) / 2;
  };
  const columns = (z: number) => (mercator ? 2 ** z : 2 ** (z + 1)),
    rows = (z: number) => 2 ** z;
  const inset = 1e-9;
  let z = Math.min(top, level + 1);
  let tx = 0,
    ty = 0;
  for (; z >= 0; z--) {
    const a = Math.floor((fx(west) + inset) * columns(z)),
      b = Math.floor((fx(east) - inset) * columns(z)),
      c = Math.floor((fy(north) + inset) * rows(z)),
      d = Math.floor((fy(south) - inset) * rows(z));
    if (a === b && c === d) {
      tx = a;
      ty = c;
      break;
    }
  }
  if (z < 0) z = 0;
  const y = scheme === 'xyz' ? ty : rows(z) - 1 - ty,
    url = imagery.url.replace(/\{z\}/g, String(z)).replace(/\{x\}/g, String(tx)).replace(/\{y\}/g, String(y)),
    answer = await fetcher(url, { signal });
  if (!answer.ok) throw failed(url, answer.status);
  const mimeType =
    imagery.mimeType ??
    (/\.jpe?g(\?|$)/i.test(url) ? 'image/jpeg' : /\.webp(\?|$)/i.test(url) ? 'image/webp' : 'image/png');
  return {
    bytes: new Uint8Array(await answer.arrayBuffer()),
    mimeType,
    uv: (longitude, latitude) => [fx(longitude) * columns(z) - tx, fy(latitude) * rows(z) - ty],
  };
}

/**
 * The terrain tile as b3dm: a glTF mesh in y-up metres relative to its RTC_CENTER (the tile's centre, float64), with
 * skirts `skirt` metres deep along its four edges, normals from the tile or from its triangles, and the imagery as an
 * unlit base colour texture.
 */
export function meshB3dm(
  mesh: QuantizedMesh,
  rectangle: Rectangle,
  drape: Drape | undefined,
  skirt: number,
): Uint8Array {
  const [west, south, east, north] = rectangle,
    count = mesh.u.length,
    edges = [mesh.west, mesh.south, mesh.east, mesh.north],
    extra = edges.reduce((n, e) => n + e.length, 0),
    total = count + extra,
    positions = new Float32Array(total * 3),
    normals = new Float32Array(total * 3),
    uvs = new Float32Array(total * 2),
    c = mesh.center,
    lonlat = new Float64Array(count * 2),
    range = mesh.maximumHeight - mesh.minimumHeight;
  const put = (i: number, longitude: number, latitude: number, height: number) => {
    const p = cartographicToEcef(longitude, latitude, height);
    // glTF is y-up: (x, y, z) of the tileset's z-up becomes (x, z, -y).
    positions[i * 3] = p[0] - c[0];
    positions[i * 3 + 1] = p[2] - c[2];
    positions[i * 3 + 2] = -(p[1] - c[1]);
    if (drape) {
      const [s, t] = drape.uv(longitude, latitude);
      uvs[i * 2] = s;
      uvs[i * 2 + 1] = t;
    }
  };
  for (let i = 0; i < count; i++) {
    const longitude = west + (mesh.u[i] / 32767) * (east - west),
      // quantized-mesh 1.0: v interpolates linearly between the tile's south and north latitudes for
      // EPSG:4326 and EPSG:3857 tilings alike; the projection only sets the tile rectangle.
      latitude = south + (mesh.v[i] / 32767) * (north - south);
    lonlat[i * 2] = longitude;
    lonlat[i * 2 + 1] = latitude;
    put(i, longitude, latitude, mesh.minimumHeight + (mesh.height[i] / 32767) * range);
  }
  // Normals: the tile's own (ECEF, oct-encoded), else area-weighted triangle normals.
  if (mesh.normals)
    for (let i = 0; i < count; i++) {
      const [x, y, z] = octDecode(mesh.normals[i * 2], mesh.normals[i * 2 + 1]);
      normals.set([x, z, -y], i * 3);
    }
  else {
    const t = mesh.indices;
    for (let k = 0; k < t.length; k += 3) {
      const a = t[k] * 3,
        b = t[k + 1] * 3,
        d = t[k + 2] * 3;
      const e1 = [0, 1, 2].map((j) => positions[b + j] - positions[a + j]),
        e2 = [0, 1, 2].map((j) => positions[d + j] - positions[a + j]),
        n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      for (const v of [a, b, d]) for (let j = 0; j < 3; j++) normals[v + j] += n[j];
    }
    for (let i = 0; i < count; i++) {
      const l = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]) || 1;
      for (let j = 0; j < 3; j++) normals[i * 3 + j] /= l;
    }
  }
  // Skirts: each edge vertex again, `skirt` metres lower, joined to its neighbour along the edge.
  const skirtTriangles: number[] = [];
  let next = count;
  edges.forEach((edge, side) => {
    // Order the edge along it: west and east by v, south and north by u.
    const along = side % 2 === 0 ? mesh.v : mesh.u,
      sorted = Array.from(edge).sort((p, q) => along[p] - along[q]),
      first = next;
    for (const i of sorted) {
      put(next, lonlat[i * 2], lonlat[i * 2 + 1], mesh.minimumHeight + (mesh.height[i] / 32767) * range - skirt);
      normals.set(normals.subarray(i * 3, i * 3 + 3), next * 3);
      next++;
    }
    for (let k = 0; k + 1 < sorted.length; k++) {
      const a = sorted[k],
        b = sorted[k + 1],
        a2 = first + k,
        b2 = first + k + 1;
      // Both windings: a skirt is seen from outside the tile, which side that is depends on the edge.
      skirtTriangles.push(a, a2, b, b, a2, b2, a, b, a2, b, b2, a2);
    }
  });
  const indexCount = mesh.indices.length + skirtTriangles.length,
    indices = total > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  indices.set(mesh.indices);
  indices.set(skirtTriangles, mesh.indices.length);
  return b3dm(glb(positions, normals, drape ? uvs : undefined, indices, drape), mesh.center);
}

/** A one-mesh GLB: positions, normals, optional uvs and texture (unlit), indices. */
function glb(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array | undefined,
  indices: Uint16Array | Uint32Array,
  drape: Drape | undefined,
): Uint8Array {
  const parts: Uint8Array[] = [],
    views: { buffer: 0; byteOffset: number; byteLength: number; target?: number }[] = [];
  let length = 0;
  const add = (data: ArrayBufferView, target?: number) => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    parts.push(bytes);
    length += bytes.byteLength;
    const pad = (4 - (length % 4)) % 4;
    if (pad) {
      parts.push(new Uint8Array(pad));
      length += pad;
    }
    return views.length - 1;
  };
  const count = positions.length / 3,
    low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++)
    for (let k = 0; k < 3; k++) {
      low[k] = Math.min(low[k], positions[i * 3 + k]);
      high[k] = Math.max(high[k], positions[i * 3 + k]);
    }
  const accessors: object[] = [
    { bufferView: add(positions, 34962), componentType: 5126, count, type: 'VEC3', min: low, max: high },
    { bufferView: add(normals, 34962), componentType: 5126, count, type: 'VEC3' },
    {
      bufferView: add(indices, 34963),
      componentType: indices instanceof Uint32Array ? 5125 : 5123,
      count: indices.length,
      type: 'SCALAR',
    },
  ];
  const attributes: Record<string, number> = { POSITION: 0, NORMAL: 1 };
  const doc: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'margoengine tiles/terrain' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    accessors,
    bufferViews: views,
  };
  let material: Record<string, unknown> = {
    pbrMetallicRoughness: { baseColorFactor: [0.6, 0.6, 0.58, 1], metallicFactor: 0, roughnessFactor: 1 },
  };
  if (drape && uvs) {
    accessors.push({ bufferView: add(uvs, 34962), componentType: 5126, count, type: 'VEC2' });
    attributes.TEXCOORD_0 = 3;
    doc.images = [{ bufferView: add(drape.bytes), mimeType: drape.mimeType }];
    doc.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }];
    doc.textures = [{ source: 0, sampler: 0 }];
    material = {
      pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 },
      extensions: { KHR_materials_unlit: {} },
    };
    doc.extensionsUsed = ['KHR_materials_unlit'];
  }
  doc.materials = [material];
  doc.meshes = [{ primitives: [{ attributes, indices: 2, material: 0 }] }];
  doc.buffers = [{ byteLength: length }];
  const json = new TextEncoder().encode(JSON.stringify(doc)),
    jsonLength = Math.ceil(json.byteLength / 4) * 4,
    out = new Uint8Array(12 + 8 + jsonLength + 8 + length),
    view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, GLB_JSON, true);
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(json, 20);
  view.setUint32(20 + jsonLength, length, true);
  view.setUint32(24 + jsonLength, GLB_BIN, true);
  let at = 28 + jsonLength;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** b3dm around a GLB with an RTC_CENTER feature table (float64 in JSON). */
function b3dm(model: Uint8Array, center: readonly number[]): Uint8Array {
  const table = new TextEncoder().encode(JSON.stringify({ BATCH_LENGTH: 0, RTC_CENTER: [...center] })),
    tableLength = Math.ceil((28 + table.byteLength) / 8) * 8 - 28,
    out = new Uint8Array(28 + tableLength + model.byteLength),
    view = new DataView(out.buffer);
  out.set([0x62, 0x33, 0x64, 0x6d]); // "b3dm"
  view.setUint32(4, 1, true);
  view.setUint32(8, out.byteLength, true);
  view.setUint32(12, tableLength, true);
  out.fill(0x20, 28, 28 + tableLength);
  out.set(table, 28);
  out.set(model, 28 + tableLength);
  return out;
}

/**
 * A `frame` for `TilesRenderer.load` that puts the east-north-up frame at a longitude and latitude (degrees) and height
 * at the world origin, x east, y up, -z north: a whole-globe terrain tileset's own centre is the earth's.
 */
export function terrainFrame(longitude: number, latitude: number, height = 0): TileMatrix {
  const p = cartographicToEcef((longitude * Math.PI) / 180, (latitude * Math.PI) / 180, height);
  return multiply(Z_UP_TO_Y_UP, invert(eastNorthUpToEcef(p[0], p[1], p[2])));
}
