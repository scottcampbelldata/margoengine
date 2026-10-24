import { extrudeGeometry } from '@margoengine/geometry/shapes';
import type { GeometryData } from '@margoengine/geometry/utils';
import { OutlineFont, type TextShapeOptions } from './outline-font.js';

export { OutlineFont } from './outline-font.js';
export type { OutlineFontSource, OutlineGlyph, TextShapeOptions } from './outline-font.js';
export type { OutlineCommand, OutlineFillRule } from './outline.js';
export { parseTTF } from './ttf.js';
export type { TTFParseOptions } from './ttf.js';

/** Options of `textGeometry`. Lengths are in `size` units. */
export interface TextGeometryOptions extends TextShapeOptions {
  /** The font, from `parseTTF`. */
  font: OutlineFont;
  /** One em. Default 100. */
  size?: number;
  /** Extrusion depth along +z. Default 50. */
  depth?: number;
  /** Points per curve segment of each glyph outline. Default 12. */
  curveSegments?: number;
  /** Rounded bevel on the front and back edges. Default false. */
  bevelEnabled?: boolean;
  /** How deep the bevel goes into the text. Default 10. */
  bevelThickness?: number;
  /** How far the bevel extends from the outline. Default 8. */
  bevelSize?: number;
  /** Where the bevel starts, relative to the outline. Default 0. */
  bevelOffset?: number;
  /** Bevel layers. Default 3. */
  bevelSegments?: number;
  /** Subdivisions along the depth. Default 1. */
  steps?: number;
}

/**
 * Extruded 3D text: `font.generateShapes(text, size, options)` through geometry's
 * `extrudeGeometry`. The first baseline lies on y = 0 and the text runs from z = 0 to z = `depth` (a bevel adds
 * `bevelThickness` beyond both). Groups follow `extrudeGeometry`: material 0 for the front and back caps, 1 for the
 * sides, per glyph shape. Use the result with materials `createMesh`, or geometry's `toGeometry` for a core mesh.
 */
export function textGeometry(text: string, options: TextGeometryOptions): GeometryData {
  if (!options || !(options.font instanceof OutlineFont))
    throw new TypeError('textGeometry font is not an OutlineFont; pass {font: parseTTF(bytes)}');
  const shapes = options.font.generateShapes(text, options.size ?? 100, options);
  return extrudeGeometry(shapes, {
    depth: options.depth ?? 50,
    curveSegments: options.curveSegments ?? 12,
    bevelEnabled: options.bevelEnabled ?? false,
    bevelThickness: options.bevelThickness ?? 10,
    bevelSize: options.bevelSize ?? 8,
    bevelOffset: options.bevelOffset ?? 0,
    bevelSegments: options.bevelSegments ?? 3,
    steps: options.steps ?? 1,
  });
}
