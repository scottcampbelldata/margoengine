// Bending meshes along a curve in the vertex shader. `@margoengine/geometry/flow` samples frames (position, tangent, up,
// side) at equal distances along a curve; this entry uploads that table to a 32-bit float texture once and a material
// plugin moves each vertex: a local point (along, up, side) goes to C(s) + up * U(s) + side * S(s), with s the distance
// along the curve, exactly the interpolation of `CurveFlow.deform` on the CPU. Normals take the inverse transpose of
// the bend's Jacobian (by cofactors), so they stay perpendicular to the bent surface however tight the bend. Sliding a
// mesh along the curve is one uniform write: no geometry is rebuilt or uploaded.
//
// Sources: A. H. Barr, "Global and Local Deformations of Solid Primitives" (SIGGRAPH 1984, Computer Graphics 18(3),
// https://doi.org/10.1145/800031.808573): a deformation of space maps a point through a function and its normals
// through the inverse transpose of that function's Jacobian; W. Wang, B. Juttler, D. Zheng and Y. Liu, "Computation of
// Rotation Minimizing Frames" (ACM TOG 27(1), 2008, https://doi.org/10.1145/1330511.1330513), the double-reflection
// frames the CPU sampler transports; J. Bloomenthal, "Calculation of Reference Frames along a Space Curve" (Graphics
// Gems, 1990): frames tabulated by arc length and interpolated between samples. Frames are fetched with `textureLoad`,
// so the 32-bit table needs no float filtering (WebGPU, "float32-filterable" is not required for loads).
import { materialPlugin, type MaterialPlugin } from './plugins.js';
import { Texture } from './texture.js';
import { bendWgsl, curveFlowHelp, curveFlowLayouts, finite, frameTableOf } from './curve-flow-bend.js';

/** What `curveFlow()` reads of a `CurveFlow` (`@margoengine/geometry/flow`), told by shape so materials does not import geometry. */
export interface CurveFlowFrames {
  /** Length of the curve. */
  readonly length: number;
  /** Whether distances wrap around. */
  readonly closed: boolean;
  /** Frames sampled (segments + 1). */
  readonly frameCount: number;
  /** 16 floats per frame: position, tangent, up, side, each padded to 4. */
  frameTable(): Float32Array;
}

/** Which local axis runs along the curve. Up is +y, or +z when `y` runs along the curve. */
export type CurveFlowAxis = 'x' | 'y' | 'z';

/** `curveFlow()` options. */
export interface CurveFlowPluginOptions {
  /** Plugin name, for its uniforms in your own WGSL and to put two flows on one material. Default `'curveflow'`. */
  name?: string;
  /** Local axis that runs along the curve, fixed at creation. Default `'x'`. */
  axis?: CurveFlowAxis;
  /** Distance along the curve of local coordinate 0; live as `plugin.uniforms.offset`. Default 0. */
  offset?: number;
  /** Stretch along the curve; live as `plugin.uniforms.scale`. Default 1. */
  scale?: number;
  /**
   * The mesh's extent along `axis` as `[low, high]`: maps it onto the whole curve (`CurveFlow.deform`'s `fit`), with
   * `offset` and `scale` on top. Default none.
   */
  fit?: readonly [number, number];
}

/** What `curveFlow()` returns: a material plugin with live `offset` and `scale`, and the curve swappable. */
export interface CurveFlowPlugin
  extends MaterialPlugin<{ offset: number; scale: number; length: number; segments: number; closed: number }> {
  /** Bends along another curve (or the same one after its points changed) from the next frame; the axis stays. */
  setFlow(flow: CurveFlowFrames): void;
  /** Frees the frame texture; drop the plugin from its materials first. */
  dispose(): void;
}

/** The frame table of `flow` as a 4-row float texture source: positions, tangents, ups, sides. */
function source(flow: CurveFlowFrames): { data: Float32Array; width: number; height: number; format: 'rgba32float' } {
  const { count, table } = frameTableOf(flow, 'curveFlow');
  const data = new Float32Array(count * 16);
  for (let i = 0; i < count; i++)
    for (let row = 0; row < 4; row++)
      data.set(table.subarray(i * 16 + row * 4, i * 16 + row * 4 + 4), (row * count + i) * 4);
  return { data, width: count, height: 4, format: 'rgba32float' };
}

/**
 * A material plugin that bends a mesh along a curve on the GPU, in the colour pass and every depth pass (shadows,
 * picking, TAA velocity). Animate `plugin.uniforms.offset` to slide the mesh along the curve with no upload.
 *
 * @param flow - A `CurveFlow` of `@margoengine/geometry/flow` (or anything with its `frameTable()`).
 * @param options - See {@link CurveFlowPluginOptions}.
 * @throws TypeError when `flow` is not a CurveFlow or the axis is unknown; RangeError for a non-finite option, a zero
 *   scale, an empty fit or more than 8,192 frames.
 */
export function curveFlow(flow: CurveFlowFrames, options: CurveFlowPluginOptions = {}): CurveFlowPlugin {
  const { name = 'curveflow', axis = 'x', fit } = options,
    order = curveFlowLayouts[axis];
  if (!order) throw new TypeError(`curveFlow axis ${String(axis)} is invalid; pass 'x', 'y' or 'z'${curveFlowHelp}`);
  let offset = finite('curveFlow offset', options.offset ?? 0),
    scale = finite('curveFlow scale', options.scale ?? 1);
  if (scale === 0)
    throw new RangeError(`curveFlow scale 0 flattens the mesh; pass a finite number other than 0${curveFlowHelp}`);
  const image = source(flow);
  if (fit) {
    const [low, high] = [finite('curveFlow fit low', fit[0]), finite('curveFlow fit high', fit[1])];
    if (!(high > low))
      throw new RangeError(
        `curveFlow fit [${low}, ${high}] has no extent; pass [low, high] with high > low${curveFlowHelp}`,
      );
    const stretch = flow.length / (high - low);
    offset += -low * stretch * scale;
    scale *= stretch;
  }
  let frames = new Texture(image, { mipmaps: false, colorSpace: 'linear' });
  const n = name,
    declarations = `
fn ${n}Frame(i:i32,row:i32)->vec3f{return textureLoad(${n}_frames,vec2i(i,row),0).xyz;}`,
    vertex = bendWgsl(
      n,
      order,
      `let fl=${n}.length;let seg=${n}.segments;let loops=${n}.closed>0.5;let stretch=${n}.scale;
var at=position.${order[0]}*${n}.scale+${n}.offset;`,
    );
  const plugin = materialPlugin({
    name,
    uniforms: { offset, scale, length: flow.length, segments: image.width - 1, closed: flow.closed ? 1 : 0 },
    textures: { frames },
    declarations,
    vertex,
  }) as CurveFlowPlugin;
  plugin.setFlow = (next: CurveFlowFrames) => {
    const made = source(next);
    if (made.width === frames.width) {
      (frames.source as { data: Float32Array }).data.set(made.data);
      frames.update();
    } else {
      const old = frames;
      plugin.textures.frames = frames = new Texture(made, { mipmaps: false, colorSpace: 'linear' });
      old.dispose();
    }
    plugin.uniforms.length = next.length;
    plugin.uniforms.segments = made.width - 1;
    plugin.uniforms.closed = next.closed ? 1 : 0;
  };
  plugin.dispose = () => frames.dispose();
  return plugin;
}
