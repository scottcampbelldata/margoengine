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
 * -1 or 1, `along` runs 0 to 1 up the blade and `slot` maps the blade number onto -1 to 1. The tip is a pair too, which
 * the GPU draws as one point until the pixel floor gives it a pixel's width (see {@link grassPoseCode}). The boxes these
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
      for (let i = 0; i <= segments; i++)
        for (const side of [-1, 1]) positions.push(side * r, (i / segments) * s.height, s.blades > 1 ? z : side * r);
      for (let i = 0; i < segments; i++) {
        const a = base + i * 2;
        indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
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
 *
 * Pixel floor: no part of a blade is drawn narrower than the camera's pixel at its distance (`pixel`, the footprint
 * per metre), so a far blade is a connected line, never the broken runs and lone pixels a sub-pixel strip leaves
 * without multisampling (the phone-wire floor of Persson, "Phone-wire AA", 2012). The floor adds area, so each blade
 * is kept with the chance its own area over the floored area, by a hash of the blade: the field keeps its coverage and
 * colour while far blades thin out, as in stochastic simplification (Cook, Halstead, Planck and Ryu, "Stochastic
 * Simplification of Aggregate Detail", SIGGRAPH 2007). A blade of root width w tapering to a point, floored at a
 * pixel p, keeps w^2 / (w^2 + p^2) of its blades while w > p, and w / 2p below it.
 *
 * A stage with `coverDeclaration` (a ring `GrassScatter` draws by coverage) keeps every blade instead, draws it the
 * filter's radius wider on each side across its screen axis and hands the fragment its pixel distance across and true
 * half width for the tent filter of `coverCode`, so a blade adds its true share of each pixel, and a hash of the blade
 * as the coverage above which its coverage-depth stage writes depth (`coverCode` with `depth`). A stage with
 * `splitDeclaration` alone draws the blade's opaque core, the filter's radius in from each edge, writing depth.
 */
export function grassPoseCode(code: string, shape: GrassShape = {}): string {
  const s = grassShape(shape),
    r = reach(s),
    cover = code.includes('var<private> scatterCover'),
    split = code.includes('const scatterSplit'),
    head = 'fn scatterPose(p:vec3f,n:vec3f,position:vec4f,';
  if (code.split(head).length !== 2) throw typeError('grassPoseCode takes a scatter vertex stage', 'scatter');
  // In grassVertex, pix is the pixel in the blade's own units, foot the floor of an opaque ring (1.5 pixels) and view
  // the eye's direction in them. A strip seen at an angle shows seen of its width, so the floor is foot / seen across
  // it (seen at least 0.25, so a blade seen edge on is not widened without bound; one still under a pixel there is
  // left out, as orientation culling does, Jahrmann and Wimmer 2017). A blade the floor leaves out shrinks to its root
  // over a band of the hash centred on keep (no pop as the camera moves; at most 0.05 wide and inside 0 to 1), so the
  // field keeps keep of its blade area on average, and every blade stays whole while keep is 1. scatterPose widens x
  // and z by wide, so `at` divides the spine and root out and only the width grows (across too). In scatterPose, view
  // is the eye's direction turned back by the instance's yaw into the clump's own axes (scatterTurn's yaw, inverted).
  return (
    code.replace(head, 'fn scatterPoseBase(p:vec3f,n:vec3f,position:vec4f,') +
    `
struct GrassVertex {p:vec3f,n:vec3f}
fn grassHash(value:u32)->f32 {var x=value;x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;x=x^(x>>16u);return f32(x)/4294967296.0;}
fn grassVertex(p:vec3f,position:vec4f,wide:f32,pix:f32,view:vec3f)->GrassVertex {
 let side=p.x/${f(r)};let along=p.y/${f(s.height)};let k=u32(round((p.z/${f(r)}+1.0)*0.5*${f(s.blades - 1)}));
 let seed=(bitcast<u32>(position.x)*0x9e3779b9u)^(bitcast<u32>(position.z)*0x85ebca6bu)^((k+1u)*0xc2b2ae35u);
 let a=grassHash(seed)*6.2831853;let d=${f(s.radius)}*sqrt(grassHash(seed^0x68e31da4u));
 let heading=grassHash(seed^0xb5297a4du)*6.2831853;let dir=vec3f(cos(heading),0.0,sin(heading));let right=vec3f(-dir.z,0.0,dir.x);
 let foot=1.5*pix;let w=${f(s.width)};let face=sqrt(max(1.0-dot(view,right)*dot(view,right),0.0));let seen=max(face,0.25);let wp=w*face;
${
  cover || split
    ? ` let grow=1.0;let t=along;
`
    : ` var keep=select(select(wp*wp/(wp*wp+foot*foot),wp/(2.0*foot),wp<foot),1.0,foot<=0.0);
 keep=select(keep,0.0,face<0.25&&wp<foot);
 let t=along;
 let band=max(min(0.05,2.0*min(keep,1.0-keep)),1e-6);
 let grow=select(clamp((keep-grassHash(seed^0x2c1b3c6du))/band+0.5,0.0,1.0),1.0,keep>=1.0);
 if(grow<=0.0){return GrassVertex(vec3f(0.0),vec3f(0.0,1.0,0.0));}
`
} let height=grow*${f(s.height)}*(1.0-${f(s.heightVariance)}*grassHash(seed^0x1b56c4e9u));
 let lean=${f(s.lean)}*(0.25+0.75*grassHash(seed^0x7f4a7c15u));
 // Root (0,0,0), control point straight above at the blade's height, tip leaning along dir at the same length.
 let ctrl=vec3f(0.0,height,0.0);let tip=vec3f(0.0,height*sqrt(1.0-lean*lean),0.0)+dir*(height*lean);
 let spine=2.0*t*(1.0-t)*ctrl+t*t*tip;let tangent=2.0*(1.0-t)*ctrl+2.0*t*(tip-ctrl);
 let root=vec3f(cos(a)*d,0.0,sin(a)*d);
 let wt=w*(1.0-t);${
   cover || split
     ? // Coverage measures across the blade as the screen shows it: perp is perpendicular to the spine and the eye's
       // direction (turned to the side of right), rp how much of the blade's width shows along it and h the true half
       // width in pixels. A blade under 8 pixels tall turns to the two-pixel filter over 4 pixels (far, the weight of cover.ts)
       // and fr is the radius drawn, the larger filter's while it has any weight.
       ` var perp=cross(tangent,view);perp=select(right,perp/length(perp),dot(perp,perp)>1e-12);
 perp=select(perp,-perp,dot(perp,right)<0.0);let rp=dot(right,perp);let h=0.5*wt*rp/max(pix,1e-30);
 let far=clamp((8.0-height/max(pix,1e-30))/4.0,0.0,1.0);let fr=select(1.0,2.0,far>0.0);
${
  cover
    ? // Covered: the true strip plus the filter's radius each side, with the pixel distance from the centre line
      // and the true half width in pixels; w, the blade's hashed depth threshold (`coverCode` depth), so a blade
      // writes depth with the chance of its coverage and the pattern holds still on the blade.
      ` let across=select(right*(side*0.5*wt),right*(side*0.5*wt)+perp*(side*fr*pix),pix>0.0);
 scatterCover=select(vec4f(0.0,65536.0,0.0,0.5),vec4f(side*(h+fr),h,far,grassHash(seed^0x3c6ef372u)),pix>0.0);
`
    : // The opaque core of a split ring: the strip less the filter's radius each side, which the covered stage
      // covers fully.
      ` let across=right*(side*select(0.5*wt,max(h-fr,0.0)*pix/max(rp,1e-3),pix>0.0));
`
}`
     : ` let drawn=max(wt,foot/seen);let across=right*(side*0.5*drawn);
`
 } let at=vec3f((root.x+spine.x)/wide,spine.y,(root.z+spine.z)/wide)+vec3f(across.x,across.y*wide,across.z);
 let normal=normalize(cross(right,tangent));
 return GrassVertex(at,normalize(normal+right*(side*${f(s.round)})));
}
fn scatterPose(p:vec3f,n:vec3f,position:vec4f,rotation:vec4f,ground:vec4f,blade:vec4f,eye:vec3f,wind:vec4f,pixel:f32)->ScatterPose {
 let d=distance(position.xyz,eye);let wide=1.0+d*blade.y;let c=cos(rotation.x);let s=sin(rotation.x);
 let look=(position.xyz-eye)/max(d,1e-6);let view=vec3f(c*look.x-s*look.z,look.y,s*look.x+c*look.z);
 let g=grassVertex(p,position,wide,d*pixel/(wide*position.w),view);
 return scatterPoseBase(g.p,g.n,position,rotation,ground,blade,eye,wind,pixel);
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
  /**
   * The middle and far rings are drawn by coverage (`Scatter.coverRing`): every blade is tent-filtered into the pixels
   * it touches as alpha instead of a hashed keep, so the far field blends into the ground at its mean colour with no
   * lone pixels. The near ring is split: each blade's core is opaque and writes depth, and the whole blade is then
   * blended over it by coverage, so its edges and its tip are soft rather than stepped.
   */
  protected override coverRing(ring: number): 'cover' | 'split' {
    return ring > 0 ? 'cover' : 'split';
  }
  protected override poseCode(code: string, group: number, binding: number): string {
    return grassPoseCode(super.poseCode(code, group, binding), this.grass);
  }
}
