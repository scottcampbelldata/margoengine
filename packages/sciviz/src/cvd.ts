import { LinearToSRGB, SRGBToLinear } from '@margoengine/math/color';
import { rangeError, typeError } from '../../shared/errors.js';
import { CVD_MATRICES } from './cvd-data.js';
import type { SRGB } from './colormaps.js';

/** Cone deficiency in Machado, Oliveira and Fernandes (2009). */
export type CVDType = 'protan' | 'deutan' | 'tritan';

/** Row-major linear-light RGB simulation matrix. Severity defaults to 1; intermediate author tables interpolate. */
export function cvdMatrix(type: CVDType, severity = 1): readonly number[] {
  const rows = CVD_MATRICES[type];
  if (!rows) throw typeError('Unknown CVD type; choose protan, deutan or tritan', 'sciviz');
  if (!Number.isFinite(severity) || severity < 0 || severity > 1)
    throw rangeError('CVD severity must be finite in [0,1]; correct severity', 'sciviz');
  const x = severity * 10,
    i = Math.min(9, Math.floor(x)),
    f = x - i;
  return rows[i].map((v, k) => v * (1 - f) + rows[i + 1][k] * f);
}

/** Simulate an sRGB colour, transforming linear light then clipping and encoding sRGB. Default full severity. */
export function simulateCVD(rgb: SRGB, type: CVDType, severity = 1): SRGB {
  if (rgb?.length !== 3 || !rgb.every((v) => Number.isFinite(v) && v >= 0 && v <= 1))
    throw rangeError('CVD input needs three sRGB channels in [0,1]; correct rgb', 'sciviz');
  const matrix = cvdMatrix(type, severity),
    linear = rgb.map(SRGBToLinear);
  return [0, 1, 2].map((i) =>
    LinearToSRGB(
      Math.min(
        1,
        Math.max(0, matrix[i * 3] * linear[0] + matrix[i * 3 + 1] * linear[1] + matrix[i * 3 + 2] * linear[2]),
      ),
    ),
  ) as unknown as SRGB;
}
