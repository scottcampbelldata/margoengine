import { createFallbackFigure } from '@margoengine/sciviz/fallback';
import * as compat from '@margoengine/webgl2-compat';

export function openCompatibility(canvas, options) {
  return createFallbackFigure(canvas, { ...options, compat });
}
