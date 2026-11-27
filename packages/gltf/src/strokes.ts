// Wide points and lines for gltf/pbr: POINTS and LINES primitives that ask for a width (stroke-width.ts) go to
// @margoengine/points and @margoengine/lines, whose instanced screen-space quads draw any width on WebGPU and the WebGL2
// layer (one quad a point or segment, expanded in the vertex shader: Rye Terrell, "Instanced Line Rendering", 2019,
// https://wwwtyro.net/2019/11/18/instanced-lines.html; Matt DesLauriers, "Drawing Lines is Hard", 2015,
// https://mattdesl.svbtle.com/drawing-lines-is-hard). This entry and those packages load only for a file that asks for
// a width; without them a point or line is the 1 px glTF 2.0 section 3.7.2.1 recommends.
import type { Engine } from '@margoengine/core/extension';
import { margoError } from '../../shared/errors.js';
import { captureScene } from '../../shared/scene-scope.js';
import type { GLTFStrokeItem, GLTFStrokeReader } from './asset.js';

/**
 * The key on the plugins this reader adds: scene writers of @margoengine/exporters skip them, as the model writes these
 * points and lines itself, with their widths.
 */
export const strokesKey = Symbol.for('margoengine.gltf-strokes.v1');
const LINES = 'gltf-lines',
  POINTS = 'gltf-points';

/** A module of @margoengine/lines or @margoengine/points, which a file with wide points or lines needs. */
const needs = <T>(name: string, load: Promise<T>): Promise<T> =>
  load.catch((error) => {
    throw margoError(
      'unsupported',
      `Wide glTF points and lines need ${name} (${error instanceof Error ? error.message : error}): install it, or pass decoders: {strokes: false} to draw them 1 px wide`,
    );
  });

interface Plugged {
  readonly name: string;
  remove(item: unknown): void;
}

/** This scene's plugin `name`, made by `make` when the scene has none; marked so exporters skip it. */
function plugin<T extends Plugged>(
  engine: Engine,
  name: string,
  make: () => T,
  kind: abstract new (...a: never[]) => T,
) {
  const found = engine.plugins.get(name);
  if (found) {
    if (!(found instanceof kind))
      throw margoError('state', `A plugin named "${name}" is not gltf/pbr's; remove it before loading wide glTF lines`);
    return found as T;
  }
  const made = make();
  Object.defineProperty(made, strokesKey, { value: true });
  engine.use(made as never);
  return made;
}

/** Positions (3 floats) and colours (4 floats) of the vertices `order` names, from packed 20-float vertices. */
function gather(vertices: Float32Array, order: ArrayLike<number>, alpha: boolean) {
  const n = order.length,
    positions = new Float32Array(n * 3),
    colors = new Float32Array(n * 4);
  let coloured = false;
  for (let i = 0; i < n; i++) {
    const o = order[i] * 20;
    positions[i * 3] = vertices[o];
    positions[i * 3 + 1] = vertices[o + 1];
    positions[i * 3 + 2] = vertices[o + 2];
    for (let k = 0; k < 4; k++) {
      // OPAQUE and MASK ignore alpha (glTF 2.0 section 3.9.4), the vertex colour's included.
      const v = k === 3 && !alpha ? 1 : vertices[o + 16 + k];
      colors[i * 4 + k] = v;
      if (v !== 1) coloured = true;
    }
  }
  return { positions, colors: coloured ? colors : null };
}

/**
 * A line list's index pairs as one polyline when each pair starts where the last ended, as gltf/pbr decodes LINE_STRIP
 * and LINE_LOOP and @margoengine/exporters writes a strip or loop as LINES: the joins then draw, and a translucent line
 * blends once where segments meet. A closed run is the plugin's own `'loop'`. Any other list stays segments.
 */
function chain(indices: Uint32Array): { order: ArrayLike<number>; mode: 'segments' | 'strip' | 'loop' } {
  if (indices.length < 4) return { order: indices, mode: 'segments' };
  const order = [indices[0]];
  for (let i = 1; i < indices.length; i += 2) {
    if (i > 1 && indices[i - 1] !== indices[i - 2]) return { order: indices, mode: 'segments' };
    order.push(indices[i]);
  }
  if (order.length > 3 && order[order.length - 1] === order[0]) {
    order.pop();
    return { order, mode: 'loop' };
  }
  return { order, mode: 'strip' };
}

/** Per-vertex `_WIDTH` multipliers in `order`, or undefined when there are none or all are 1. */
function multipliers(widths: Float32Array | undefined, order: ArrayLike<number>): Float32Array | undefined {
  if (!widths) return undefined;
  const out = Float32Array.from(order, (i) => widths[i]);
  if (out.some((v) => !Number.isFinite(v) || v < 0))
    throw new RangeError('Invalid glTF _WIDTH values; each must be finite and non-negative, re-export the file');
  return out.every((v) => v === 1) ? undefined : out;
}

/**
 * The reader `loadGLTF` and `parseGLTFAsync` import when a file asks for a point or line width: each item drawn by a
 * scene-wide `gltf-lines` or `gltf-points` plugin, following its node's world matrix and visibility.
 */
export const wideStrokes: GLTFStrokeReader = {
  async attach(engine, items, signal) {
    const scope = captureScene(engine),
      wantsLines = items.some((item) => item.width.kind === 'lines'),
      wantsPoints = items.some((item) => item.width.kind === 'points'),
      [lines, stroke, points] = await Promise.all([
        wantsLines ? needs('@margoengine/lines', import('@margoengine/lines')) : undefined,
        wantsLines ? needs('@margoengine/lines', import('@margoengine/lines/stroke')) : undefined,
        wantsPoints ? needs('@margoengine/points', import('@margoengine/points')) : undefined,
      ]);
    signal?.throwIfAborted();
    const made: { owner: Plugged; item: unknown }[] = [],
      dispose = () => {
        for (const { owner, item } of made.splice(0)) {
          owner.remove(item);
          const left = owner as unknown as { lines?: ReadonlySet<unknown>; pointClouds?: ReadonlySet<unknown> };
          if (!(left.lines ?? left.pointClouds)?.size && engine.plugins.get(owner.name) === (owner as never))
            engine.removePlugin(owner.name);
        }
      };
    try {
      scope.run(() => {
        for (const item of items) made.push(...draw(engine, item, lines, stroke, points));
      });
    } catch (error) {
      dispose();
      throw error;
    }
    return { dispose };
  },
};

function draw(
  engine: Engine,
  item: GLTFStrokeItem,
  lines: typeof import('@margoengine/lines') | undefined,
  stroke: typeof import('@margoengine/lines/stroke') | undefined,
  points: typeof import('@margoengine/points') | undefined,
): { owner: Plugged; item: unknown }[] {
  const { width, vertices, indices, material, node } = item,
    alpha = material.alphaMode === 'BLEND',
    color: [number, number, number] = [material.base[0], material.base[1], material.base[2]],
    opacity = alpha ? material.base[3] : 1;
  if (width.kind === 'lines') {
    const owner = plugin(engine, LINES, () => new lines!.Lines({ name: LINES }), lines!.Lines),
      { order, mode } = chain(indices),
      { positions, colors } = gather(vertices, order, alpha),
      widths = multipliers(item.widths, order);
    if (order.length < 2) return [];
    const options = {
        positions,
        colors,
        mode,
        mesh: node,
        color,
        opacity,
        width: width.size,
        worldUnits: width.units === 'world',
      },
      line = widths ? new stroke!.Stroke({ ...options, widths }) : new lines!.Line(options);
    return [{ owner, item: owner.add(line) }];
  }
  const owner = plugin(
      engine,
      POINTS,
      () => {
        const made = new points!.PointsPlugin({ name: POINTS });
        // The file's pixel sizes are CSS pixels; the plugin's own are pixels of the target.
        made.pixelScale = (context) => {
          const canvas = engine.canvas as { clientWidth?: number };
          return canvas.clientWidth ? context.width / canvas.clientWidth : 1;
        };
        return made;
      },
      points!.PointsPlugin,
    ),
    { positions, colors } = gather(vertices, indices, alpha),
    sizes = multipliers(item.widths, indices),
    lit = !(material.extensions && 'KHR_materials_unlit' in material.extensions);
  if (!indices.length) return [];
  const cloud = new points!.PointCloud({
    positions,
    colors: colors ?? undefined,
    colorFormat: 'float',
    colorSpace: 'linear',
    sizes,
    material: {
      color,
      opacity,
      size: width.size,
      sizeUnits: width.units,
      // A lit point material is the sphere impostor @margoengine/exporters writes lit; the Bentley style is a disc.
      shape: width.bentley ? 'round' : undefined,
      shading: lit ? 'sphere' : 'flat',
      transparent: alpha,
    },
  });
  cloud.attach(node);
  return [{ owner, item: owner.add(cloud) }];
}

export { strokeWidth, type StrokeWidth } from './stroke-width.js';
