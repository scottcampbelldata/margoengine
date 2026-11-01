// RepRap G-code toolpaths: G0 and G1 moves with E, grouped by Z into layers of line segments.
import { LoaderError, type ParseLimits } from './types.js';
import { type BinaryInput, floats, limits, toText } from './util.js';

const F = 'G-code';

/** One layer of {@link GCode.layers}. Both arrays hold two xyz points per segment: `mode: 'segments'` of `Line`. */
export interface GCodeLayer {
  /** The Z of the layer's extruding moves, in millimetres. */
  z: number;
  /** Moves that lay down material. */
  extrusion: Float32Array;
  /** Moves without material that lead into this layer. */
  travel: Float32Array;
}

/** What {@link parseGCode} returns. Coordinates are the machine's, in millimetres, Z up. */
export interface GCode {
  /** Layers by rising Z. */
  layers: GCodeLayer[];
  /** Filament pushed in, the sum of positive E moves, in millimetres. */
  filament: number;
  /** Bounds of every segment; zeros when there are none. */
  min: [number, number, number];
  max: [number, number, number];
  /** Things the parser moved past without drawing, each listed once: arcs (G2, G3). */
  warnings: string[];
}

/**
 * Parses RepRap-flavoured G-code: G0 and G1 with X, Y, Z, E; G90, G91, M82 and M83 for absolute and relative axes; G92
 * to set a position; G20 and G21 for units; G28 to home. Other commands are skipped. An arc moves the position without
 * drawing and adds a warning. `maxVertices` counts two per segment.
 *
 * @param input The file's bytes or text.
 * @param options The shared size limits.
 * @returns The layers, filament use and bounds.
 * @throws LoaderError with code `syntax` for a bad number or `limit` past `maxVertices`.
 *
 * @example
 * ```ts
 * import { parseGCode } from '@margoengine/loaders/gcode';
 *
 * const { layers, filament } = parseGCode('G1 Z0.2\nG1 X10 E1\n');
 * console.log(layers[0].z, layers[0].extrusion.length, filament);
 * ```
 */
export function parseGCode(input: BinaryInput | string, options: ParseLimits = {}): GCode {
  const text = toText(input, F),
    { maxVertices } = limits(options, F);
  const byZ = new Map<number, ReturnType<typeof makeLayer>>(),
    warnings: string[] = [],
    position = [0, 0, 0, 0],
    min: [number, number, number] = [Infinity, Infinity, Infinity],
    max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let pending = floats(),
    relative = false,
    relativeE = false,
    unit = 1,
    filament = 0,
    vertices = 0,
    current: ReturnType<typeof makeLayer> | undefined,
    lineNumber = 0;
  const axes = 'XYZE';
  // No exponents: G-code has none, and in G1X1E2 the E is the extruder.
  const word = /([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+))?/g;

  for (let start = 0; start < text.length; ) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).replace(/\(.*?\)/g, '');
    start = end + 1;
    lineNumber++;
    const semicolon = line.indexOf(';');
    let body = semicolon >= 0 ? line.slice(0, semicolon) : line;
    const star = body.indexOf('*');
    if (star >= 0) body = body.slice(0, star);
    let command = '';
    const values: (number | undefined)[] = [undefined, undefined, undefined, undefined];
    word.lastIndex = 0;
    for (let match = word.exec(body); match; match = word.exec(body)) {
      const letter = match[1].toUpperCase();
      if (letter === 'N' && !command) continue;
      if (!command) {
        if (match[2] === undefined)
          throw new LoaderError(F, 'syntax', `command without a number on line ${lineNumber}`);
        command = letter + Number(match[2]);
        continue;
      }
      const axis = axes.indexOf(letter);
      if (axis < 0) continue;
      if (match[2] === undefined) {
        if (command === 'G28') values[axis] = 0;
        else if (command !== 'G92') throw new LoaderError(F, 'syntax', `${letter} has no number on line ${lineNumber}`);
        else values[axis] = 0;
      } else values[axis] = Number(match[2]) * unit;
    }
    switch (command) {
      case 'G90':
        relative = relativeE = false;
        break;
      case 'G91':
        relative = relativeE = true;
        break;
      case 'M82':
        relativeE = false;
        break;
      case 'M83':
        relativeE = true;
        break;
      case 'G20':
        unit = 25.4;
        break;
      case 'G21':
        unit = 1;
        break;
      case 'G92':
        for (let a = 0; a < 4; a++) position[a] = values[a] ?? (values.every((v) => v === undefined) ? 0 : position[a]);
        break;
      case 'G28':
        for (let a = 0; a < 3; a++)
          if (values[a] !== undefined || values.every((v) => v === undefined)) position[a] = 0;
        break;
      case 'G2':
      case 'G3':
        for (let a = 0; a < 4; a++)
          if (values[a] !== undefined)
            position[a] = (a === 3 ? relativeE : relative)
              ? position[a] + (values[a] as number)
              : (values[a] as number);
        if (!warnings.length) warnings.push('G2 and G3 arcs move the position but are not drawn');
        break;
      case 'G0':
      case 'G1': {
        const from = position.slice();
        for (let a = 0; a < 4; a++) {
          const value = values[a];
          if (value !== undefined) position[a] = (a === 3 ? relativeE : relative) ? position[a] + value : value;
        }
        const pushed = position[3] - from[3];
        if (pushed > 0) filament += pushed;
        if (position[0] === from[0] && position[1] === from[1] && position[2] === from[2]) break;
        if ((vertices += 2) > maxVertices)
          throw new LoaderError(F, 'limit', `vertex count exceeds the limit of ${maxVertices}`);
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a], from[a], position[a]);
          max[a] = Math.max(max[a], from[a], position[a]);
        }
        const extruding = pushed > 0;
        if (extruding) {
          current = byZ.get(position[2]);
          if (!current) byZ.set(position[2], (current = makeLayer(position[2])));
          // Travel seen since the last extrusion leads into this layer.
          current.travel.reserve(pending.length);
          current.travel.array.set(pending.array.subarray(0, pending.length), current.travel.length);
          current.travel.length += pending.length;
          pending = floats();
        }
        const target = extruding && current ? current.extrusion : pending;
        target.reserve(6);
        target.array.set([from[0], from[1], from[2], position[0], position[1], position[2]], target.length);
        target.length += 6;
        break;
      }
      default:
    }
  }
  if (pending.length) {
    const last = current ?? makeLayer(position[2]);
    if (!current) byZ.set(position[2], last);
    last.travel.reserve(pending.length);
    last.travel.array.set(pending.array.subarray(0, pending.length), last.travel.length);
    last.travel.length += pending.length;
  }
  const layers = [...byZ.values()]
    .sort((a, b) => a.z - b.z)
    .map((layer) => ({
      z: layer.z,
      extrusion: layer.extrusion.array.slice(0, layer.extrusion.length),
      travel: layer.travel.array.slice(0, layer.travel.length),
    }));
  if (!vertices) {
    min.fill(0);
    max.fill(0);
  }
  return { layers, filament, min, max, warnings };
}

function makeLayer(z: number) {
  return { z, extrusion: floats(), travel: floats() };
}
