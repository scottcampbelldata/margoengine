// Procedural grass blades (`@margoengine/scatter/grass`): a `Scatter` that takes no mesh. Each instance is a clump of
// blades the vertex stage builds on the GPU: a blade is a quadratic Bezier spine from its root (Jahrmann and Wimmer,
// Responsive Real-Time Grass Rendering for General 3D Scenes, I3D 2017) widened into a tapering strip, with its root
// offset, facing, height and lean drawn from a hash of the instance's world root and the blade's number, and its normal
// rounded across the width (after Wohllaib, Procedural Grass in Ghost of Tsushima, GDC 2021). The rings' vertex
// buffers hold only (side, along, blade number), so every LOD ring is the same clump with fewer segments.
import { Geometry, type EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { Scatter, type ScatterOptions } from '@margoengine/scatter';
import { rangeError, typeError } from '../../shared/errors.js';

/** The blades of every clump. All lengths are in instance units: `ScatterOptions.scale` scales the whole clump. */
export interface GrassShape {
  /** Tallest blade, above 0 (default 0.6). */
  height?: number;
  /** Fraction of `height` a blade may lose at random, 0 to 0.95 (default 0.4). */
  heightVariance?: number;
  /** Blade width at the root, above 0 (default 0.04); blades taper to a point. */
  width?: number;
  /** Blades a clump draws, an integer 1 to 64 (default 8). */
  blades?: number;
  /** Radius of the disc the blade roots of a clump fall in, 0 or more (default 0.15). */
  radius?: number;
  /** Largest sideways lean of a blade tip, as a fraction of its height, 0 to 0.95 (default 0.35). */
  lean?: number;
  /** How far the normal turns across the width so a flat blade shades round, 0 to 1 (default 0.3). */
  round?: number;
  /** Segments along a blade in rings 0, 1 and 2, integers 1 to 16 and not increasing (default [5, 3, 1]). */
  segments?: readonly [number, number, number];
}
/** Options of `new GrassScatter(options)`: a Scatter's, with `blades` shading on by default, plus the blade shape. */
export interface GrassScatterOptions extends ScatterOptions {
  grass?: GrassShape;
}

const DEFAULTS = {
  height: 0.6,
  heightVariance: 0.4,
  width: 0.04,
  blades: 8,
  radius: 0.15,
  lean: 0.35,
  round: 0.3,
  segments: [5, 3, 1] as const,
};
type Shape = typeof DEFAULTS & { segments: readonly [number, number, number] };

/** Checks a shape and fills in its defaults. */
export function grassShape(shape: GrassShape = {}): Shape {
  if (!shape || typeof shape !== 'object')
    throw typeError(
      'GrassScatter grass must be a shape object such as { height: 0.6, blades: 8 }; omit it for the defaults',
      'scatter',
    );
  const s = { ...DEFAULTS, ...shape } as Shape;
  const { height, heightVariance, width, blades, radius, lean, round, segments } = s;
  const within = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;
  if (
    !(within(height, 1e-4, 1e4) && within(width, 1e-5, 1e3) && within(radius, 0, 1e4)) ||
    !within(heightVariance, 0, 0.95) ||
    !within(lean, 0, 0.95) ||
    !within(round, 0, 1) ||
    !Number.isInteger(blades) ||
    !within(blades, 1, 64) ||
    !Array.isArray(segments) ||
    segments.length !== 3 ||
    !segments.every((v, i) => Number.isInteger(v) && within(v, 1, 16) && (!i || v <= segments[i - 1]))
  )
    throw rangeError(
      'GrassScatter grass needs height 0.0001-10000, width 0.00001-1000, radius 0-10000, heightVariance, lean 0-0.95, round 0-1, blades an integer 1-64 and three non-increasing integer segments 1-16',
      'scatter',
    );
  return s;
}

/** Horizontal reach of a clump from its root: the root disc, the widest lean and half a blade width. */
const reach = (s: Shape) => s.radius + s.lean * s.height + s.width / 2;

/**
 * The three ring meshes of a grass clump. Each vertex holds `(side * reach, along * height, slot * reach)`: `side` is
 * -1, 0 (the tip) or 1, `along` runs 0 to 1 up the blade and `slot` maps the blade number onto -1 to 1. The boxes these
 * positions span hold every blade the GPU builds, so culling by the mesh bounds stays conservative (a one-blade clump
 * puts its sides at `slot = side` for that).
 */
export function grassRings(shape: GrassShape = {}): [Geometry, Geometry, Geometry] {
  const s = grassShape(shape),
    r = reach(s);
  return s.segments.map((segments) => {
    const positions: number[] = [],
      normals: number[] = [],
      indices: number[] = [];
    for (let k = 0; k < s.blades; k++) {
      const z = (s.blades > 1 ? (k / (s.blades - 1)) * 2 - 1 : 0) * r,
        base = positions.length / 3;
      // One blade decodes as blade 0 whatever its z, so its sides take z = side * reach: the box must span the
      // reach in z too, as the GPU turns the blade to any heading.
      for (let i = 0; i < segments; i++)
        for (const side of [-1, 1]) positions.push(side * r, (i / segments) * s.height, s.blades > 1 ? z : side * r);
      positions.push(0, s.height, z);
      for (let i = 0; i < segments - 1; i++) {
        const a = base + i * 2;
        indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
      const last = base + (segments - 1) * 2;
      indices.push(last, last + 1, last + 2);
    }
    for (let i = 0; i < positions.length; i += 3) normals.push(0, 0, 1);
    return new Geometry(positions, normals, indices);
  }) as [Geometry, Geometry, Geometry];
}

const f = (v: number) => (Number.isInteger(v) ? `${v}.0` : `${v}`);

/**
 * WGSL that turns a ring vertex of {@link grassRings} into a blade vertex for the instance at `position`, wrapping
 * `scatterPose`: the shape's numbers are compiled in. Blades widen with distance like `ScatterOptions.blades` meshes,
 * but only across their own width: clumps do not spread.
 */
export function grassPoseCode(code: string, shape: GrassShape = {}): string {
  const s = grassShape(shape),
    r = reach(s),
    head = 'fn scatterPose(p:vec3f,n:vec3f,position:vec4f,';
  if (code.split(head).length !== 2) throw typeError('grassPoseCode takes a scatter vertex stage', 'scatter');
  return (
    code.replace(head, 'fn scatterPoseBase(p:vec3f,n:vec3f,position:vec4f,') +
    `
struct GrassVertex {p:vec3f,n:vec3f}
fn grassHash(value:u32)->f32 {var x=value;x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;x=x^(x>>16u);return f32(x)/4294967296.0;}
fn grassVertex(p:vec3f,position:vec4f,wide:f32)->GrassVertex {
 let side=p.x/${f(r)};let t=p.y/${f(s.height)};let k=u32(round((p.z/${f(r)}+1.0)*0.5*${f(s.blades - 1)}));
 let seed=(bitcast<u32>(position.x)*0x9e3779b9u)^(bitcast<u32>(position.z)*0x85ebca6bu)^((k+1u)*0xc2b2ae35u);
 let a=grassHash(seed)*6.2831853;let d=${f(s.radius)}*sqrt(grassHash(seed^0x68e31da4u));
 let face=grassHash(seed^0xb5297a4du)*6.2831853;let dir=vec3f(cos(face),0.0,sin(face));let right=vec3f(-dir.z,0.0,dir.x);
 let height=${f(s.height)}*(1.0-${f(s.heightVariance)}*grassHash(seed^0x1b56c4e9u));
 let lean=${f(s.lean)}*(0.25+0.75*grassHash(seed^0x7f4a7c15u));
 // Root (0,0,0), control point straight above at the blade's height, tip leaning along dir at the same length.
 let ctrl=vec3f(0.0,height,0.0);let tip=vec3f(0.0,height*sqrt(1.0-lean*lean),0.0)+dir*(height*lean);
 let spine=2.0*t*(1.0-t)*ctrl+t*t*tip;let tangent=2.0*(1.0-t)*ctrl+2.0*t*(tip-ctrl);
 let root=vec3f(cos(a)*d,0.0,sin(a)*d);let across=right*(side*0.5*${f(s.width)}*(1.0-t));
 // scatterPose widens x and z by wide: divide the spine and root out so only the width grows.
 let at=vec3f((root.x+spine.x)/wide,spine.y,(root.z+spine.z)/wide)+across;
 let normal=normalize(cross(right,tangent));
 return GrassVertex(at,normalize(normal+right*(side*${f(s.round)})));
}
fn scatterPose(p:vec3f,n:vec3f,position:vec4f,rotation:vec4f,ground:vec4f,blade:vec4f,eye:vec3f,wind:vec4f)->ScatterPose {
 let wide=1.0+distance(position.xyz,eye)*blade.y;let g=grassVertex(p,position,wide);
 return scatterPoseBase(g.p,g.n,position,rotation,ground,blade,eye,wind);
}
`
  );
}

/**
 * A grass `Scatter` with no mesh input: every instance is a clump of GPU-built blades (see {@link GrassShape}).
 * `blades` shading is on unless `options.blades` says otherwise; the shape is fixed for the scatter's life.
 * @throws as `Scatter`, and RangeError or TypeError for a bad `grass` shape.
 */
export class GrassScatter extends Scatter {
  readonly grass: Readonly<Shape>;
  constructor(options: GrassScatterOptions = {}) {
    if (!options || typeof options !== 'object')
      throw typeError('GrassScatter takes an options object; omit it for the defaults', 'scatter');
    const { grass, ...rest } = options;
    const shape = grassShape(grass);
    super(grassRings(shape), { color: [0.18, 0.42, 0.08], blades: {}, ...rest });
    this.grass = Object.freeze({ ...shape, segments: Object.freeze([...shape.segments]) as Shape['segments'] });
  }
  /**
   * Makes a grass scatter and adds it to `engine`: `GrassScatter.attach(engine, options)`. The parameter also admits
   * meshes only so the class can stand in for a `Scatter`; passing them throws, since the blades are built on the GPU.
   */
  static override attach(
    engine: EngineKernel,
    options?: GrassScatterOptions | Geometry | readonly [Geometry, Geometry, Geometry],
  ): GrassScatter {
    if (options instanceof Geometry || Array.isArray(options))
      throw typeError(
        'GrassScatter builds its own blades; call GrassScatter.attach(engine, options) without meshes',
        'scatter',
      );
    const scatter = new GrassScatter(options as GrassScatterOptions | undefined);
    engineRuntime(engine).use(scatter);
    return scatter;
  }
  protected override poseCode(code: string, group: number, binding: number): string {
    return grassPoseCode(super.poseCode(code, group, binding), this.grass);
  }
}
