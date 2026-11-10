import { rangeError } from '../../shared/errors.js';

/** FITS keyword values. Repeated commentary cards remain in the HDU's cards array. */
export type FITSHeader = Readonly<Record<string, string | number | boolean>>;
/** Greisen and Calabretta pixel, intermediate and world coordinate pipeline. */
export interface FITSWCS {
  readonly types: readonly string[];
  readonly units: readonly string[];
  readonly referencePixel: readonly number[];
  readonly referenceValue: readonly number[];
  readonly matrix: readonly (readonly number[])[];
  /** Zero based pixel centres; FITS CRPIX itself is one based. */
  world(pixel: readonly number[]): number[];
}
/** Builds primary or alternate WCS axes. Supports linear and common zenithal celestial projections. */
export function fitsWCS(header: FITSHeader, dimensions: number, alternate = ''): FITSWCS {
  if (!/^([A-Z])?$/.test(alternate)) throw rangeError('FITS alternate WCS must be A..Z or empty', 'sciviz');
  const h = header,
    key = (s: string) => s + alternate,
    num = (s: string, d: number) => Number(h[key(s)] ?? d),
    n = num('WCSAXES', dimensions);
  if (!Number.isInteger(n) || n < 0 || n > 99) throw rangeError('FITS WCS axis count is invalid', 'sciviz');
  const types = Array.from({ length: n }, (_, i) => String(h[key(`CTYPE${i + 1}`)] ?? 'LINEAR')),
    units = Array.from({ length: n }, (_, i) => String(h[key(`CUNIT${i + 1}`)] ?? '')),
    referencePixel = Array.from({ length: n }, (_, i) => num(`CRPIX${i + 1}`, 0)),
    referenceValue = Array.from({ length: n }, (_, i) => num(`CRVAL${i + 1}`, 0));
  const hasCD = Object.keys(h).some((k) => new RegExp(`^CD[0-9]+_[0-9]+${alternate}$`).test(k));
  const matrix = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      hasCD ? num(`CD${i + 1}_${j + 1}`, 0) : num(`CDELT${i + 1}`, 1) * num(`PC${i + 1}_${j + 1}`, i === j ? 1 : 0),
    ),
  );
  if (!hasCD && h[key('CROTA2')] !== undefined && n >= 2) {
    const a = (num('CROTA2', 0) * Math.PI) / 180,
      c = Math.cos(a),
      s = Math.sin(a);
    matrix[0][0] = num('CDELT1', 1) * c;
    matrix[0][1] = -num('CDELT2', 1) * s;
    matrix[1][0] = num('CDELT1', 1) * s;
    matrix[1][1] = num('CDELT2', 1) * c;
  }
  const lon = types.findIndex((t) => /^(RA--|GLON|ELON|HLON|SLON)/.test(t)),
    lat = types.findIndex((t) => /^(DEC-|GLAT|ELAT|HLAT|SLAT)/.test(t)),
    rad = Math.PI / 180;
  const angularUnit = (unit: string): number => {
    if (!unit || unit === 'deg') return rad;
    if (unit === 'rad') return 1;
    if (unit === 'arcmin') return rad / 60;
    if (unit === 'arcsec') return rad / 3600;
    throw rangeError(`FITS celestial unit ${unit} is unsupported; use deg, rad, arcmin or arcsec`, 'sciviz');
  };
  return {
    types,
    units,
    referencePixel,
    referenceValue,
    matrix,
    world(pixel) {
      if (pixel.length < dimensions || pixel.some((v) => !Number.isFinite(v)))
        throw rangeError('FITS WCS pixel is incomplete or nonfinite', 'sciviz');
      const delta = referencePixel.map((v, i) => (pixel[i] ?? 0) + 1 - v);
      // SIP is a published pre-linear pixel distortion; inverse keywords are not needed for pixel-to-world.
      for (let axis = 0; axis < Math.min(2, n); axis++) {
        const prefix = axis === 0 ? 'A' : 'B',
          order = num(`${prefix}_ORDER`, 0);
        if (!Number.isInteger(order) || order < 0 || order > 20)
          throw rangeError('FITS SIP order is invalid', 'sciviz');
        let correction = 0;
        const u = (pixel[0] ?? 0) + 1 - referencePixel[0],
          v = (pixel[1] ?? 0) + 1 - referencePixel[1];
        for (let i = 0; i <= order; i++)
          for (let j = 0; j <= order - i; j++) correction += num(`${prefix}_${i}_${j}`, 0) * u ** i * v ** j;
        delta[axis] += correction;
      }
      const intermediate = matrix.map((row) => row.reduce((s, v, j) => s + v * delta[j], 0)),
        out = intermediate.map((v, i) => v + referenceValue[i]);
      if (lon < 0 || lat < 0) return out;
      const projection = types[lon].slice(5, 8),
        lu = angularUnit(units[lon]),
        bu = angularUnit(units[lat]),
        circle = (2 * Math.PI) / lu,
        x = intermediate[lon] * lu,
        y = intermediate[lat] * bu,
        r = Math.hypot(x, y),
        a = referenceValue[lon] * lu,
        d = referenceValue[lat] * bu;
      let c: number;
      if (projection === 'TAN') c = Math.atan(r);
      else if (projection === 'SIN') c = r <= 1 ? Math.asin(r) : NaN;
      else if (projection === 'ARC') c = r;
      else if (projection === 'STG') c = 2 * Math.atan(r / 2);
      else if (projection === 'ZEA') c = r <= 2 ? 2 * Math.asin(r / 2) : NaN;
      else
        throw rangeError(
          `FITS WCS projection ${projection} needs a supported projection; linear metadata is retained`,
          'sciviz',
        );
      if (h[key('LONPOLE')] !== undefined && num('LONPOLE', 180) !== 180)
        throw rangeError('FITS non-default celestial pole rotation is not supported', 'sciviz');
      const sin = Math.sin(c),
        cos = Math.cos(c);
      out[lon] =
        ((((r ? a + Math.atan2(x * sin, r * Math.cos(d) * cos - y * Math.sin(d) * sin) : a) / lu) % circle) + circle) %
        circle;
      out[lat] = (r ? Math.asin(cos * Math.sin(d) + (y * sin * Math.cos(d)) / r) : d) / bu;
      return out;
    },
  };
}
