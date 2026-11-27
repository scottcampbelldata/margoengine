// The width a glTF POINTS or LINES primitive asks for. glTF 2.0 section 3.7.2.1 gives a point or line no size, so two
// sources are read: the primitive `extras` that @margoengine/exporters writes (`lineWidth` with `lineWidthUnits`,
// `pointSize` with `pointSizeUnits`, `'pixels'` meaning CSS pixels or `'world'`), and the Bentley vendor material
// extensions CesiumJS reads (`BENTLEY_materials_line_style.width`, `BENTLEY_materials_point_style.diameter`, CSS pixels;
// CesiumGS/glTF pull requests 89 and 91). Internal: not a package entry.
import type { GLTFDocument, GLTFPrimitive } from '../../shared/gltf.js';

/** A point diameter or line width and its units. */
export interface StrokeWidth {
  readonly kind: 'points' | 'lines';
  readonly size: number;
  readonly units: 'pixels' | 'world';
  /** From a Bentley material style, which draws a point as a disc; false for the primitive's extras. */
  readonly bentley: boolean;
}

const LINE = 'BENTLEY_materials_line_style',
  POINT = 'BENTLEY_materials_point_style';

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * The width primitive `p` of `doc` asks for, or undefined for a triangle primitive or one that asks for none. Extras
 * come first, being the file's own value; a value that is not a positive finite number, or units other than `'pixels'`
 * and `'world'` (absent means pixels), is not this convention's and is not read, as extras are application-specific
 * (glTF 2.0 section 3.12).
 */
export function strokeWidth(doc: GLTFDocument, p: GLTFPrimitive | undefined): StrokeWidth | undefined {
  const mode = p?.mode ?? 4;
  if (mode > 3) return undefined;
  const kind = mode === 0 ? 'points' : 'lines',
    extras = p!.extras as Record<string, unknown> | undefined,
    size = extras?.[kind === 'points' ? 'pointSize' : 'lineWidth'],
    units = extras?.[kind === 'points' ? 'pointSizeUnits' : 'lineWidthUnits'] ?? 'pixels';
  if (positive(size) && (units === 'pixels' || units === 'world')) return { kind, size, units, bentley: false };
  const material = p!.material === undefined ? undefined : doc.materials?.[p!.material],
    style = material?.extensions?.[kind === 'points' ? POINT : LINE] as Record<string, unknown> | undefined,
    value = style?.[kind === 'points' ? 'diameter' : 'width'];
  return positive(value) ? { kind, size: value, units: 'pixels', bentley: true } : undefined;
}

/** True when some primitive of `doc` asks for a width: the strokes reader then loads. */
export const hasStrokes = (doc: GLTFDocument): boolean =>
  !!doc.meshes?.some((mesh) => mesh?.primitives?.some((p) => strokeWidth(doc, p) !== undefined));
