// GeoTIFF georeference and no-data reading (entry `@margoengine/decoders/geotiff`, GAP-FILM-GEOTIFF) over the directory
// that `openTIFF` reads: the raster-to-model transform from ModelPixelScale (33550) with ModelTiepoint (33922), or
// ModelTransformation (34264); the GeoKey directory (34735) with its double (34736) and ASCII (34737) parameters; and the
// GDAL_NODATA text (42113). Sources: OGC GeoTIFF Standard 1.1, OGC 19-008r4, section 7 (raster space, PixelIsArea and
// PixelIsPoint, the tie point and transformation tags) and annex B (the GeoKey ids and values), https://docs.ogc.org/is/19-008r4/19-008r4.html;
// GDAL, "GDAL GeoTIFF driver" (the GDAL_NODATA TIFF tag as text, `nan` allowed), https://gdal.org/drivers/raster/gtiff.html.
// Our own code from those descriptions; no part of a GeoTIFF library is read.
import { decodeFailed } from './errors.js';
import type { TIFFPage } from './tiff.js';

/** What a page says about where its pixels lie on the earth (or in a projected plane). */
export interface GeoTIFFInfo {
  /** Pixels across. */
  readonly width: number;
  /** Pixels down. */
  readonly height: number;
  /** `'area'` (PixelIsArea, the default when the file says nothing) or `'point'` (PixelIsPoint). */
  readonly raster: 'area' | 'point';
  /**
   * The coordinate system the model coordinates are in: `model` is the GTModelType key (`'projected'`, `'geographic'`,
   * `'geocentric'`, or `'unknown'`), `epsg` the ProjectedCSType (3072) or GeographicType (2048) code, or null when the
   * file leaves it unset or user-defined (32767), and `citation` the file's own name for it (`'WGS 84'`), or null.
   */
  readonly crs: { readonly model: 'projected' | 'geographic' | 'geocentric' | 'unknown'; readonly epsg: number | null; readonly citation: string | null };
  /** Unit of the heights, from VerticalUnits (4099): metre 9001, foot 9002, US survey foot 9003; null when unset. */
  readonly verticalUnits: 'metre' | 'foot' | 'us-foot' | null;
  /**
   * Model coordinates of raster point (i, j) as x = a i + b j + c, y = d i + e j + f, in raster space (the top-left
   * corner of the top-left pixel is (0, 0) for `'area'`, its centre for `'point'`). Null without a georeference.
   */
  readonly transform: readonly [number, number, number, number, number, number] | null;
  /** Pixel size in model units, [along a row, down a column], both positive; null without a georeference. */
  readonly pixel: readonly [number, number] | null;
  /** Whether the transform turns or shears the raster (a north-up raster is not rotated). */
  readonly rotated: boolean;
  /**
   * [minX, minY, maxX, maxY] of the raster's pixel cells' outer edges in model coordinates (for a rotated raster, the
   * bounding box of the four corners). Null without a georeference.
   */
  readonly box: readonly [number, number, number, number] | null;
  /** [minX, minY, maxX, maxY] of the first and last sample centres: the box a grid of point samples spans. Null without a georeference. */
  readonly sampleBox: readonly [number, number, number, number] | null;
  /** The GDAL_NODATA value (NaN for `nan`), or null when the page has none. Compare as float32 for a float32 page. */
  readonly noData: number | null;
  /** Every tie point as [i, j, k, x, y, z] when the file gives more than the one the transform used; empty otherwise. */
  readonly tiepoints: readonly (readonly number[])[];
}

const bad = (problem: string): Error =>
  decodeFailed(`GeoTIFF ${problem}; pass a page of a valid GeoTIFF file (the GeoTIFF tags of a TIFF written by GDAL or a GIS)`);

const VERTICAL = new Map<number, 'metre' | 'foot' | 'us-foot'>([
  [9001, 'metre'],
  [9002, 'foot'],
  [9003, 'us-foot'],
]);

/** Reads the GeoKey directory (tag 34735) into key id to short value, double values and strings. */
function geoKeys(page: TIFFPage): Map<number, number | string> {
  const keys = new Map<number, number | string>(),
    directory = page.tags.get(34735);
  if (!directory) return keys;
  if (directory.length < 4 || directory[0] !== 1) throw bad('GeoKeyDirectory header is invalid');
  const count = directory[3];
  if (!Number.isInteger(count) || count < 0 || directory.length < 4 + count * 4) throw bad('GeoKeyDirectory is shorter than its key count');
  const doubles = page.tags.get(34736),
    text = page.ascii.get(34737);
  for (let k = 0; k < count; k++) {
    const [id, location, n, value] = directory.slice(4 + k * 4, 8 + k * 4);
    if (location === 0) keys.set(id, value);
    else if (location === 34736) {
      if (!doubles || value + n > doubles.length) throw bad('GeoKey double parameters are out of range');
      keys.set(id, doubles[value]);
    } else if (location === 34737) {
      if (text === undefined || value + n > text.length) throw bad('GeoKey ASCII parameters are out of range');
      // The string is n characters from `value`, ended by a `|`.
      keys.set(id, text.slice(value, value + n).replace(/[|\0]+$/, ''));
    }
  }
  return keys;
}

/**
 * Reads the georeference, coordinate system and no-data value of one TIFF page (`openTIFF(bytes).read(0)`). A page with
 * no georeference tags still answers its `noData`, with `transform`, `pixel`, `box` and `sampleBox` null.
 * @example
 * const info = readGeoTIFF(openTIFF(bytes).read(0));
 * if (info.box) console.log(info.crs.epsg, info.box, info.pixel, info.noData);
 * @throws MargoError with code 'failed' when a GeoTIFF tag is the wrong length or points outside its parameters.
 */
export function readGeoTIFF(page: TIFFPage): GeoTIFFInfo {
  const keys = geoKeys(page),
    modelType = keys.get(1024),
    model = modelType === 1 ? 'projected' : modelType === 2 ? 'geographic' : modelType === 3 ? 'geocentric' : 'unknown',
    code = model === 'projected' ? keys.get(3072) : model === 'geographic' ? keys.get(2048) : undefined,
    epsg = typeof code === 'number' && code > 0 && code < 32767 ? code : null,
    named = [3073, 2049, 1026].map((id) => keys.get(id)).find((v) => typeof v === 'string'),
    raster = keys.get(1025) === 2 ? 'point' : 'area',
    vertical = VERTICAL.get(keys.get(4099) as number) ?? null;
  const scale = page.tags.get(33550),
    ties = page.tags.get(33922),
    matrix = page.tags.get(34264);
  let transform: GeoTIFFInfo['transform'] = null,
    tiepoints: number[][] = [];
  if (matrix) {
    if (matrix.length !== 16 || !matrix.every(Number.isFinite)) throw bad('ModelTransformation needs 16 numbers');
    transform = [matrix[0], matrix[1], matrix[3], matrix[4], matrix[5], matrix[7]];
  } else if (scale && ties) {
    if (scale.length !== 3 || !scale.every(Number.isFinite)) throw bad('ModelPixelScale needs 3 numbers');
    if (ties.length < 6 || ties.length % 6 || !ties.every(Number.isFinite)) throw bad('ModelTiepoint needs a multiple of 6 numbers');
    const [i, j, , x, y] = ties;
    // Raster rows run down, model y runs up: y = tieY + (j - row) * scaleY.
    transform = [scale[0], 0, x - i * scale[0], 0, -scale[1], y + j * scale[1]];
    for (let t = 6; t < ties.length; t += 6) tiepoints.push(ties.slice(t, t + 6));
  } else if (ties && ties.length > 6) {
    // Several tie points and no scale or matrix is a ground control point list, which this reader does not interpolate.
    tiepoints = Array.from({ length: ties.length / 6 }, (_, n) => ties.slice(n * 6, n * 6 + 6));
  }
  const noText = page.ascii.get(42113)?.trim();
  let noData: number | null = null;
  if (noText !== undefined && noText !== '') {
    noData = /^[+-]?nan$/i.test(noText) ? NaN : Number(noText);
    if (Number.isNaN(noData) && !/^[+-]?nan$/i.test(noText)) throw bad(`GDAL_NODATA "${noText}" is not a number`);
  }
  let pixel: GeoTIFFInfo['pixel'] = null,
    box: GeoTIFFInfo['box'] = null,
    sampleBox: GeoTIFFInfo['sampleBox'] = null,
    rotated = false;
  if (transform) {
    const [a, b, c, d, e, f] = transform;
    if (![a, b, c, d, e, f].every(Number.isFinite)) throw bad('the raster transform is not finite');
    rotated = b !== 0 || d !== 0;
    pixel = [Math.hypot(a, d), Math.hypot(b, e)];
    const hull = (i0: number, j0: number, i1: number, j1: number): [number, number, number, number] => {
      const xs = [a * i0 + b * j0 + c, a * i1 + b * j0 + c, a * i0 + b * j1 + c, a * i1 + b * j1 + c],
        ys = [d * i0 + e * j0 + f, d * i1 + e * j0 + f, d * i0 + e * j1 + f, d * i1 + e * j1 + f];
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    };
    // Area: cell edges at 0 and the size, centres at 0.5 and size - 0.5. Point: centres at 0 and size - 1, edges half out.
    const edge = raster === 'area' ? 0 : -0.5,
      first = raster === 'area' ? 0.5 : 0;
    box = hull(edge, edge, edge + page.width, edge + page.height);
    sampleBox = hull(first, first, first + page.width - 1, first + page.height - 1);
  }
  return {
    width: page.width,
    height: page.height,
    raster,
    crs: { model, epsg, citation: typeof named === 'string' ? named : null },
    verticalUnits: vertical,
    transform,
    pixel,
    rotated,
    box,
    sampleBox,
    noData,
    tiepoints,
  };
}
