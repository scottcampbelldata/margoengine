// Many instances flowing along curves: each instance of one instanced draw picks its curve and its own place on it, and
// the vertex shader bends it there (the bend of `/curve-flow`). Every curve's frames sit in one 32-bit float texture,
// four rows a curve; the w of the first column holds the curve's length, segments and whether it wraps, and each
// instance's curve and offsets are rows of `/instance-attributes`. Moving instances uploads only the rows that changed.
//
// Sources: the layout, per-instance animation choice and phase read in the vertex shader from a texture of frames, is
// B. Dudash, "Animated Crowd Rendering" (GPU Gems 3, chapter 2, 2007,
// https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-2-animated-crowd-rendering), with curve frames
// in place of bone frames. The deformation, its normals and the frames: A. H. Barr (SIGGRAPH 1984,
// https://doi.org/10.1145/800031.808573), W. Wang et al., "Computation of Rotation Minimizing Frames" (ACM TOG 27(1),
// 2008, https://doi.org/10.1145/1330511.1330513) and J. Bloomenthal (Graphics Gems, 1990), as in curve-flow.ts.
import { materialPlugin, type MaterialPlugin } from './plugins.js';
import { instanceAttributes, type InstanceAttributes } from './instance-attributes.js';
import { Texture } from './texture.js';
import { bendWgsl, curveFlowHelp, curveFlowLayouts, finite, frameTableOf, MAX_FRAMES } from './curve-flow-bend.js';
import type { CurveFlowAxis, CurveFlowFrames } from './curve-flow.js';

/** `instancedCurveFlow()` options. */
export interface InstancedCurveFlowOptions {
  /** Plugin name, for its uniforms and attributes in your own WGSL. Default `'curveflow'`. */
  name?: string;
  /** Local axis that runs along the curves, fixed at creation. Default `'x'`. */
  axis?: CurveFlowAxis;
  /** Distance added to every instance; live as `plugin.uniforms.offset`. Default 0. */
  offset?: number;
  /** Fraction of its own curve added to every instance (1 is once along it); live as `plugin.uniforms.progress`. Default 0. */
  progress?: number;
  /** Stretch along the curves; live as `plugin.uniforms.scale`. Default 1. */
  scale?: number;
  /** The mesh's extent along `axis` as `[low, high]`: maps it onto each instance's whole curve. Default none. */
  fit?: readonly [number, number];
  /** Distances wrap on every curve, open ones too. Default false: a curve wraps when its `CurveFlow` is closed. */
  wrap?: boolean;
}

/** What each instance holds: its curve's index, a distance along it and a fraction of it. All start at 0. */
export type InstancedCurveFlowAttributes = { curve: 'f32'; offset: 'f32'; progress: 'f32' };

/** What `instancedCurveFlow()` returns: a material plugin with live uniforms, per-instance places and swappable curves. */
export interface InstancedCurveFlowPlugin
  extends MaterialPlugin<{ offset: number; progress: number; scale: number }> {
  /** The curve, offset and progress of every instance, for bulk and in-place edits (`array()` with `update()`). */
  readonly instanceAttributes: InstanceAttributes<InstancedCurveFlowAttributes>;
  /** Curves held, fixed at creation. */
  readonly curveCount: number;
  /** Puts instance `index` on curve `curve`; its offset and progress stay. */
  setCurve(index: number, curve: number): void;
  /** Distance of instance `index` along its curve. */
  setOffset(index: number, offset: number): void;
  /** Fraction of its curve that instance `index` has covered, whatever the curve's length. */
  setProgress(index: number, progress: number): void;
  /** Length of curve `curve`. */
  curveLength(curve: number): number;
  /** Replaces curve `curve` (or takes its changed points) from the next frame. */
  setFlow(curve: number, flow: CurveFlowFrames): void;
  /** Frees the frame texture and the instance values; drop the plugin from its materials first. */
  dispose(): void;
}

const caller = 'instancedCurveFlow',
  // Four texture rows a curve inside WebGPU's guaranteed maxTextureDimension2D.
  MAX_CURVES = MAX_FRAMES / 4;

/**
 * A material plugin that bends each instance of an instanced mesh along one of several curves on the GPU, in the colour
 * pass and every depth pass. The instance's own matrix applies after the bend.
 *
 * @param flows - 1 to 2,048 `CurveFlow`s of `@margoengine/geometry/flow` (or anything with their `frameTable()`).
 * @param capacity - Instances that hold their own values (1 to 1,000,000); draw with `createInstancedMesh`.
 * @param options - See {@link InstancedCurveFlowOptions}.
 * @throws TypeError when a flow is not a CurveFlow or the axis is unknown; RangeError for a non-finite option, a zero
 *   scale, an empty fit, too many curves, frames or instances.
 */
export function instancedCurveFlow(
  flows: readonly CurveFlowFrames[],
  capacity: number,
  options: InstancedCurveFlowOptions = {},
): InstancedCurveFlowPlugin {
  const { name = 'curveflow', axis = 'x', fit, wrap = false } = options,
    order = curveFlowLayouts[axis];
  if (!order) throw new TypeError(`${caller} axis ${String(axis)} is invalid; pass 'x', 'y' or 'z'${curveFlowHelp}`);
  if (!Array.isArray(flows) || flows.length < 1 || flows.length > MAX_CURVES)
    throw new RangeError(`${caller} takes an array of 1 to ${MAX_CURVES} curves; pass them${curveFlowHelp}`);
  const offset = finite(`${caller} offset`, options.offset ?? 0),
    progress = finite(`${caller} progress`, options.progress ?? 0),
    scale = finite(`${caller} scale`, options.scale ?? 1);
  if (scale === 0)
    throw new RangeError(`${caller} scale 0 flattens the mesh; pass a finite number other than 0${curveFlowHelp}`);
  let low = 0,
    span = 0;
  if (fit) {
    low = finite(`${caller} fit low`, fit[0]);
    span = finite(`${caller} fit high`, fit[1]) - low;
    if (!(span > 0))
      throw new RangeError(`${caller} fit [${low}, ${fit[1]}] has no extent; pass [low, high] with high > low${curveFlowHelp}`);
  }

  const count = flows.length,
    tables = flows.map((flow) => frameTableOf(flow, caller)),
    lengths = flows.map((flow) => flow.length);
  /** Writes curve `c` into `data` (`width` texels a row). */
  const write = (data: Float32Array, width: number, c: number, flow: CurveFlowFrames, from: Float32Array) => {
    const frames = from.length / 16;
    for (let row = 0; row < 4; row++) {
      const at = (c * 4 + row) * width * 4;
      for (let i = 0; i < frames; i++) data.set(from.subarray(i * 16 + row * 4, i * 16 + row * 4 + 3), at + i * 4);
    }
    // The w of column 0, rows 0 to 2: length, segments, wraps.
    data[c * 16 * width + 3] = flow.length;
    data[(c * 4 + 1) * width * 4 + 3] = frames - 1;
    data[(c * 4 + 2) * width * 4 + 3] = wrap || flow.closed ? 1 : 0;
  };
  const make = (data: Float32Array, width: number) =>
    new Texture(
      { data, width, height: count * 4, format: 'rgba32float' },
      { mipmaps: false, colorSpace: 'linear' },
    );
  let width = Math.max(...tables.map((t) => t.count)),
    data = new Float32Array(width * count * 16);
  tables.forEach((t, c) => write(data, width, c, flows[c], t.table));

  const instances = instanceAttributes(capacity, { curve: 'f32', offset: 'f32', progress: 'f32' });
  let frames = make(data, width);
  const n = name,
    declarations = `
var<private> ${n}Base:i32;
fn ${n}Frame(i:i32,row:i32)->vec3f{return textureLoad(${n}_frames,vec2i(i,${n}Base+row),0).xyz;}
fn ${n}Curve(row:i32)->f32{return textureLoad(${n}_frames,vec2i(0,${n}Base+row),0).w;}`,
    // A progress that keeps growing is folded into one turn of a wrapping curve before it is scaled to a distance.
    vertex = bendWgsl(
      n,
      order,
      `${n}Base=4*clamp(i32(floor(${n}_curve+0.5)),0,${count - 1});
let fl=${n}Curve(0);let seg=${n}Curve(1);let loops=${n}Curve(2)>0.5;
let turn=${n}.progress+${n}_progress;
let stretch=${fit ? `${n}.scale*fl/f32(${span})` : `${n}.scale`};
var at=${fit ? `(position.${order[0]}-f32(${low}))` : `position.${order[0]}`}*stretch+${n}.offset+${n}_offset+select(turn,fract(turn),loops)*fl;
`,
    );
  const plugin = materialPlugin({
    name,
    uniforms: { offset, progress, scale },
    textures: { frames },
    instanceAttributes: instances,
    declarations,
    vertex,
  }) as unknown as InstancedCurveFlowPlugin & { curveCount: number };
  const curveAt = (curve: number): number => {
    if (!Number.isInteger(curve) || curve < 0 || curve >= count)
      throw new RangeError(`${caller} curve ${String(curve)} is invalid; pass 0 to ${count - 1}${curveFlowHelp}`);
    return curve;
  };
  plugin.curveCount = count;
  plugin.setCurve = (index, curve) => void instances.set('curve', index, curveAt(curve));
  plugin.setOffset = (index, value) => void instances.set('offset', index, value);
  plugin.setProgress = (index, value) => void instances.set('progress', index, value);
  plugin.curveLength = (curve) => lengths[curveAt(curve)];
  plugin.setFlow = (curve, flow) => {
    curveAt(curve);
    const next = frameTableOf(flow, caller);
    if (next.count <= width) {
      write(data, width, curve, flow, next.table);
      frames.update();
    } else {
      const wider = new Float32Array(next.count * count * 16);
      for (let row = 0; row < count * 4; row++)
        wider.set(data.subarray(row * width * 4, (row + 1) * width * 4), row * next.count * 4);
      width = next.count;
      data = wider;
      write(data, width, curve, flow, next.table);
      const old = frames;
      plugin.textures.frames = frames = make(data, width);
      old.dispose();
    }
    lengths[curve] = flow.length;
  };
  plugin.dispose = () => {
    frames.dispose();
    instances.dispose();
  };
  return plugin;
}
