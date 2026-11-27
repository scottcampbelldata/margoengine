// Samples the colour of a 3MF volume data resource (volumetric extension section 5.2.1,
// https://github.com/3MFConsortium/spec_volumetric) onto the triangles of its shape. The function is read at each
// vertex in object coordinates, its channels clipped to 0..1 as linear sRGB, and a triangle the file gives a surface
// property keeps that property, which the specification puts above the volume's. Triangles are split at the middle of
// every side longer than the sample spacing; whether a side splits depends on the side alone, so the triangles on both
// sides decide alike and no crack opens (Fisher and others, "DiagSplit", ACM Transactions on Graphics 28(5), 2009,
// https://graphics.stanford.edu/~mdfisher/Data/DiagSplit.pdf; patterns of Boubekeur and Schlick, "Generic adaptive mesh
// refinement", GPU Gems 3 chapter 5, 2007).
import { LinearToSRGB } from '@margoengine/math/color';
import { cornerProperty, type ThreeMFMesh, type ThreeMFModel, type ThreeMFObject } from './threemf.js';
import { compileField, type FieldScope } from './threemf-functions.js';
import type { ThreeMFSampledField } from './threemf-volumetric.js';
import { LoaderError } from './types.js';
import { floats, uints } from './util.js';

const F = '3MF';
const NONE = 0xffffffff;
/** The most samples along the longest side of a shape. */
export const MAX_COLOUR_SAMPLES = 512;

type Color = [number, number, number, number];
type Weights = [number, number, number];

/** A colour function over a solid: `field.transform` takes the mesh's coordinates to the function's. */
export interface VolumeFill {
  scope: FieldScope;
  field: ThreeMFSampledField;
}

/**
 * The mesh with its volume colour: a new mesh of the same surface, split until no side is longer than the spacing
 * (the longest side of the bounding box over `resolution`, or half of the smallest `minfeaturesize` of its fills).
 */
export function colourMesh(
  model: ThreeMFModel,
  object: ThreeMFObject,
  mesh: ThreeMFMesh,
  { resolution, maxTriangles }: { resolution: number; maxTriangles: number },
): { mesh: ThreeMFMesh; spacing: number; coarse: boolean } {
  const source = mesh.vertices.array,
    count = mesh.vertices.length / 3,
    triangleCount = mesh.triangles.length / 3,
    points = Array.from(source.subarray(0, count * 3)),
    low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i++) {
    low[i % 3] = Math.min(low[i % 3], points[i]);
    high[i % 3] = Math.max(high[i % 3], points[i]);
  }
  const longest = Math.max(0, ...high.map((v, k) => v - low[k])),
    fills = mesh.fills ?? [mesh.fill],
    minFeatureSize = fills.reduce((least, fill) => {
      const size = fill?.field.minFeatureSize ?? 0;
      return size > 0 && (!least || size < least) ? size : least;
    }, 0),
    spacing = Math.max(
      longest / MAX_COLOUR_SAMPLES,
      Math.min(longest / resolution, minFeatureSize > 0 ? minFeatureSize / 2 : Infinity),
    );

  const middles = new Map<string, number>();
  const middle = (a: number, b: number): number => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    let id = middles.get(key);
    if (id === undefined) {
      id = points.length / 3;
      for (let k = 0; k < 3; k++) points.push((points[a * 3 + k] + points[b * 3 + k]) / 2);
      middles.set(key, id);
    }
    return id;
  };
  const length = (a: number, b: number): number =>
    Math.hypot(
      points[a * 3] - points[b * 3],
      points[a * 3 + 1] - points[b * 3 + 1],
      points[a * 3 + 2] - points[b * 3 + 2],
    );

  /** Each fill's compiled function and the colours it has given, a property group of the mesh once used. */
  const samplers = new Map<VolumeFill, { colours: Color[]; group: number; at(v: number): Color }>();
  const sampler = (fill: VolumeFill) => {
    const found = samplers.get(fill);
    if (found) return found;
    const { functionId, channel: name, fallback, transform: m = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] } = fill.field,
      pos = new Float64Array(3),
      program = compileField(fill.scope, functionId, new Map([['pos', pos]])),
      output = program.outputs.get(name) as Float64Array,
      colours: Color[] = [],
      made = {
        colours,
        group: -1,
        at(v: number): Color {
          let colour = colours[v];
          if (!colour) {
            const x = points[v * 3],
              y = points[v * 3 + 1],
              z = points[v * 3 + 2];
            for (let k = 0; k < 3; k++) pos[k] = x * m[k] + y * m[3 + k] + z * m[6 + k] + m[9 + k];
            program.run();
            const channel = (i: number): number =>
              LinearToSRGB(Math.min(1, Math.max(0, Number.isFinite(output[i]) ? output[i] : fallback)));
            colours[v] = colour = [channel(0), channel(1), channel(2), 1];
          }
          return colour;
        },
      };
    samplers.set(fill, made);
    return made;
  };

  const vertices = floats(),
    triangles = uints(),
    pids = uints(),
    properties = uints(),
    flat: (Color | undefined)[] = [],
    between: Color[] = [];
  let betweenGroup = -1;
  /** Adds a property group of colours to the model and returns its place. */
  const group = (colours: Color[], name: string): number => {
    const at = model.propertyIds.length,
      id = `\0${name} ${at} ${object.id}`;
    model.propertyIds.push(id);
    model.properties.set(id, colours);
    return at;
  };
  const alike = (a: Color, b: Color): boolean => String(a) === String(b);

  const emit = (t: number, ids: number[], weights: Weights[], surface: (Color | undefined)[]): void => {
    if (triangles.length / 3 >= maxTriangles)
      throw new LoaderError(
        F,
        'limit',
        `the colour samples of object ${object.id.slice(0, 32)} exceed ${maxTriangles} triangles; lower colorResolution or raise maxTriangles`,
      );
    triangles.push3(ids[0], ids[1], ids[2]);
    const [a, b, c] = surface;
    if (a && b && c) {
      flat.push(mesh.flat ? mesh.flat[t] : a);
      if (alike(a, b) && alike(a, c)) {
        const p = mesh.p.array[t * 3];
        pids.push(mesh.pid.array[t] ?? NONE);
        properties.push3(p, p, p);
        return;
      }
      if (betweenGroup < 0) betweenGroup = group(between, 'surface colour');
      pids.push(betweenGroup);
      for (const w of weights) between.push([0, 1, 2, 3].map((i) => w[0] * a[i] + w[1] * b[i] + w[2] * c[i]) as Color);
      properties.push3(between.length - 3, between.length - 2, between.length - 1);
      return;
    }
    const fill = mesh.fills ? mesh.fills[t] : mesh.fill;
    if (!fill) {
      // No property and no volume colour here: the triangle stays as it was.
      flat.push(mesh.flat?.[t] ?? a);
      pids.push(mesh.pid.array[t] ?? NONE);
      const p = mesh.p.array[t * 3];
      properties.push3(p, p, p);
      return;
    }
    const from = sampler(fill),
      colours = ids.map((v) => from.at(v));
    // A triangle of one colour names it for its group; one that changes colour is drawn by its corners.
    flat.push(alike(colours[0], colours[1]) && alike(colours[0], colours[2]) ? colours[0] : undefined);
    if (from.group < 0) from.group = group(from.colours, 'volume colour');
    pids.push(from.group);
    properties.push3(ids[0], ids[1], ids[2]);
  };

  for (let t = 0; t < triangleCount; t++) {
    const corners = [0, 1, 2].map((k) => mesh.triangles.array[t * 3 + k]);
    if (corners.some((v) => v >= count))
      throw new LoaderError(F, 'range', `a triangle index of object ${object.id} is outside 0..${count - 1}`);
    const surface = [0, 1, 2].map((k) => {
      const property = cornerProperty(model, object, mesh, t, k);
      return property && model.properties.get(property.id)?.[property.index];
    });
    const stack: [number[], Weights[]][] = [
      [
        corners,
        [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
      ],
    ];
    while (stack.length) {
      let [ids, weights] = stack.pop()!;
      let split = ids.map((a, k) => length(a, ids[(k + 1) % 3]) > spacing * (1 + 1e-9));
      const parts = split.filter(Boolean).length;
      if (!parts) {
        emit(t, ids, weights, surface);
        continue;
      }
      // Turn the triangle so that AB is split and, with two splits, CA is not.
      const first = parts === 3 ? 0 : [0, 1, 2].find((k) => split[k] && (parts === 1 || !split[(k + 2) % 3]))!,
        turn = <T>(list: T[]): T[] => [...list.slice(first), ...list.slice(0, first)];
      ids = turn(ids);
      weights = turn(weights);
      split = turn(split);
      const [a, b, c] = ids,
        [wa, wb, wc] = weights,
        half = (p: Weights, q: Weights): Weights => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2],
        ab = middle(a, b),
        wab = half(wa, wb);
      if (parts === 1)
        stack.push(
          [
            [a, ab, c],
            [wa, wab, wc],
          ],
          [
            [ab, b, c],
            [wab, wb, wc],
          ],
        );
      else {
        const bc = middle(b, c),
          wbc = half(wb, wc);
        stack.push([
          [ab, b, bc],
          [wab, wb, wbc],
        ]);
        if (parts === 3) {
          const ca = middle(c, a),
            wca = half(wc, wa);
          stack.push(
            [
              [a, ab, ca],
              [wa, wab, wca],
            ],
            [
              [ca, bc, c],
              [wca, wbc, wc],
            ],
            [
              [ab, bc, ca],
              [wab, wbc, wca],
            ],
          );
        } else if (length(a, bc) <= length(ab, c))
          stack.push(
            [
              [a, ab, bc],
              [wa, wab, wbc],
            ],
            [
              [a, bc, c],
              [wa, wbc, wc],
            ],
          );
        else
          stack.push(
            [
              [a, ab, c],
              [wa, wab, wc],
            ],
            [
              [ab, bc, c],
              [wab, wbc, wc],
            ],
          );
      }
    }
  }
  for (let i = 0; i < points.length; i += 3) vertices.push3(points[i], points[i + 1], points[i + 2]);
  // Property indices are vertex numbers: every place up to the last holds a colour.
  for (const { colours } of samplers.values()) for (let v = 0; v < colours.length; v++) colours[v] ??= [1, 1, 1, 1];
  return {
    mesh: { vertices, triangles, pid: pids, p: properties, flat },
    spacing,
    coarse: minFeatureSize > 0 && spacing > minFeatureSize / 2,
  };
}
