/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph, type Vec3 } from '@margoengine/core/extension';
import { finiteVector } from '@margoengine/math/validate';
import { MargoError } from '@margoengine/math/errors';
import type { Clustered, ClusteredShapes } from './index.js';
import { ltcSize, ltcTable } from './ltc.js';
import { ltcPolygonWgsl } from './ltc-wgsl.js';
declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number };
/** Colour and brightness shared by every shaped light. */
interface ShapeLightBase {
  /** Linear RGB; a channel may be negative (Display P3) while the luminance is 0 or more. Default [1, 1, 1]. */
  color?: Vec3;
  /**
   * Radiance multiplier of the emitting surface, 0 or more (the same unit as a rectangle area light's). Default 1.
   * {@link radianceFromPower} turns a luminous or radiant power into it.
   */
  intensity?: number;
}
/** A glowing ball, such as a bulb: every point of its surface emits evenly in every direction. */
export interface SphereLight extends ShapeLightBase {
  shape: 'sphere';
  /** World centre. */
  position: Vec3;
  /** Radius in metres, positive. */
  radius: number;
}
/** A flat round emitter, such as a downlight or a spot fixture's lens, lit on the side its `direction` faces. */
export interface DiscLight extends ShapeLightBase {
  shape: 'disc';
  /** World centre. */
  position: Vec3;
  /** World direction the lit face points along (nonzero). */
  direction: Vec3;
  /** Radius in metres, positive. */
  radius: number;
  /** Emit from both faces. Default false. */
  twoSided?: boolean;
}
/** A capsule, such as a fluorescent tube: a cylinder of `radius` from `start` to `end` with round ends. */
export interface TubeLight extends ShapeLightBase {
  shape: 'tube';
  /** World centre of one end. */
  start: Vec3;
  /** World centre of the other end (may equal `start`: a sphere). */
  end: Vec3;
  /** Radius in metres, positive. */
  radius: number;
}
/** A light for {@link ShapeLights.setLights}. */
export type ShapedLight = SphereLight | DiscLight | TubeLight;
/** Options of {@link ShapeLights}. */
export interface ShapeLightOptions {
  /** The clustered lighting whose light loop also evaluates the shaped lights (core meshes and every `lights.add()` receiver). */
  lights: Clustered;
}
/** Shaped lights per {@link ShapeLights.setLights} call. */
export const MAX_SHAPE_LIGHTS = 64;
const LIGHT_FLOATS = 12,
  HEADER = 4,
  BINDING = 150,
  LUT_OFFSET = (HEADER + MAX_SHAPE_LIGHTS * LIGHT_FLOATS) * 4,
  // Rim edges of a disc that crosses the horizon, and arc steps around each end of a tube.
  SEGMENTS = 6,
  ARC_SEGMENTS = 4;

/**
 * The emitting surface area in square metres: 4 pi r^2 (sphere), pi r^2 (disc, one face; twice that two-sided) and
 * 2 pi r L + 4 pi r^2 (tube of length L).
 */
export function shapeLightArea(light: ShapedLight): number {
  const r = light.radius;
  if (light.shape === 'sphere') return 4 * Math.PI * r * r;
  if (light.shape === 'disc') return Math.PI * r * r * (light.twoSided ? 2 : 1);
  const length = Math.hypot(
    light.end[0] - light.start[0],
    light.end[1] - light.start[1],
    light.end[2] - light.start[2],
  );
  return 2 * Math.PI * r * length + 4 * Math.PI * r * r;
}
/**
 * The `intensity` (radiance) that makes `light` emit `power` in total, from a Lambertian surface: power / (pi x area).
 * Lumens give candela per square metre (nits); watts give watts per square metre per steradian.
 * @throws RangeError for a negative or non-finite power or a light without a positive radius.
 */
export function radianceFromPower(light: ShapedLight, power: number): number {
  if (!(power >= 0) || !Number.isFinite(power) || !(light?.radius > 0))
    throw new RangeError('radianceFromPower needs a power of 0 or more and a light with a positive radius');
  return power / (Math.PI * shapeLightArea(light));
}

// One storage buffer, no textures, as AreaLights: a count, the lights (a.xyz + kind, b.xyz + radius, radiance +
// twoSided) and the LTC table (Heitz, Dupuy, Hill & Neubelt 2016). Every shape is lit through the same LTC lobe as the
// rectangle lights, so the GGX specular and Lambert diffuse match them:
// - A disc seen through the LTC matrix is an ellipse, and the cone from the shading point over it is elliptic. Its
//   quadric is B^-T diag(1, 1, -1) B^-1 with B = [axis 1, axis 2, centre]; with eigenvalues l1, l2 > 0 > l3 the cone is
//   x^2/a^2 + y^2/b^2 <= z^2 with a^2 = -l3/l1, b^2 = -l3/l2, and its vector form factor points along the l3 eigenvector
//   with length ab / sqrt((1 + a^2)(1 + b^2)) = sqrt(l3^2 / ((l1 - l3)(l2 - l3))) (the area of the cone's orthographic
//   projection on the unit disc over pi, derived for this package). The quadric R^T J R (R = det(B) B^-1) shares its
//   eigenvalues with G J, G = R R^T, whose characteristic cubic takes its coefficients from dot and cross products of
//   R's rows with no cancelling sums; the smallest root comes from the cubic's trigonometric solution refined by two
//   Newton steps, so a far, small disc under a stretched glossy lobe keeps its precision in float32.
// - Horizon clipping: while the mapped disc is wholly above the receiver's horizon the closed form is exact. Across
//   it, the rim's visible arc (where z = c.z + |(v1.z, v2.z)| cos(t - phi) >= 0) is integrated as polygons closed along
//   the horizon with the quad's edge term: (inscribed + 2 x circumscribed) / 3 over 6 arc steps, which cancels the
//   leading O(dt^2) error of each (a regular polygon's area series), within 0.2% of quadrature on the tests.
// - A sphere is the disc of its silhouette circle (radius r sqrt(1 - r^2/d^2) at d (1 - r^2/d^2) from the point).
// - A tube (capsule) is seen as the convex hull of its end spheres' silhouette discs: the two segments along its
//   tangent planes through the shading point, and around each end the arc of that disc beyond the chord between the
//   tangent points. The polygon (4 arc steps per end, inscribed + 2 x circumscribed over 3 as for clipped discs) is
//   integrated with the rectangle lights' horizon-clipped edge sum.
const sampling = (group: number) => /* wgsl */ `
struct ShapeLight {a:vec4f,b:vec4f,color:vec4f}
struct ShapeLightData {count:vec4u,lights:array<ShapeLight,${MAX_SHAPE_LIGHTS}>,lut:array<u32>}
struct ShapeDisc {c:vec3f,t1:vec3f,t2:vec3f}
struct ShapeArc {c:vec3f,x:vec3f,y:vec3f,beta:f32}
@group(${group}) @binding(${BINDING}) var<storage,read> shapeLights:ShapeLightData;
${ltcPolygonWgsl('shape')}fn shapeCone(m:mat3x3f,d:ShapeDisc)->vec3f {
  let big=m*d.c;let s=inverseSqrt(max(dot(big,big),1e-30));let k=big*s;let v1=m*d.t1*s;let v2=m*d.t2*s;
  let w0=cross(v2,k);let w1=cross(k,v1);let top=max(dot(w0,w0),dot(w1,w1));if(!(top>0.0)){return vec3f(0);}
  let g=inverseSqrt(top);let r0=w0*g;let r1=w1*g;let r2=cross(v1,v2)*g;let det=dot(r0,cross(r1,r2));if(det==0.0){return vec3f(0);}
  let c01=cross(r0,r1);let c02=cross(r0,r2);let c12=cross(r1,r2);let g00=dot(r0,r0);let g11=dot(r1,r1);let g22=dot(r2,r2);
  let t=g00+g11-g22;let minors=dot(c01,c01)-dot(c02,c02)-dot(c12,c12);let dt=-det*det;
  let p=minors-t*t/3;let q=-2*t*t*t/27+t*minors/3-dt;var l=t/3;
  if(p<0.0){let r=sqrt(-p/3);l=t/3+2*r*cos((acos(clamp(-q/(2*r*r*r),-1.0,1.0))+6.2831853)/3);}
  for(var i=0;i<2;i++){let slope=3*l*l-2*t*l+minors;if(slope!=0.0){l-=(l*(l*(l-t)+minors)-dt)/slope;}}
  let g01=dot(r0,r1);let g02=dot(r0,r2);let g12=dot(r1,r2);
  let a0=vec3f(g00-l,g01,-g02);let a1=vec3f(g01,g11-l,-g12);let a2=vec3f(g02,g12,-g22-l);
  let x0=cross(a0,a1);let x1=cross(a0,a2);let x2=cross(a1,a2);
  var y=x0;if(dot(x1,x1)>dot(y,y)){y=x1;}if(dot(x2,x2)>dot(y,y)){y=x2;}
  let axis=v1*y.x+v2*y.y+k*y.z;let magnitude=sqrt(l*l/max(3*l*l-2*t*l+minors,1e-30));
  return axis*inverseSqrt(max(dot(axis,axis),1e-30))*select(magnitude,-magnitude,dot(axis,k)<0.0);
}
fn shapeBasis(n:vec3f)->mat2x3f {let t=normalize(cross(n,select(vec3f(1,0,0),vec3f(0,0,1),abs(n.x)>0.5)));return mat2x3f(t,cross(n,t));}
fn shapeSilhouette(c:vec3f,r:f32)->ShapeDisc {
  let d2=max(dot(c,c),r*r*1.0001);let keep=1-r*r/d2;let b=shapeBasis(c*inverseSqrt(max(dot(c,c),1e-30)))*(r*sqrt(keep));
  return ShapeDisc(c*keep,b[0],b[1]);
}
fn shapeDiscForm(m:mat3x3f,d:ShapeDisc)->f32 {
  let c=m*d.c;let v1=m*d.t1;let v2=m*d.t2;let r=length(vec2f(v1.z,v2.z));
  if(c.z>=r){return max(shapeCone(m,d).z,0.0);}
  if(c.z<=-r){return 0.0;}
  // The rim is c + u cos(s) + w sin(s) with u.z = r and w.z = 0 (no atan2: a signed zero in v1.z must not turn the arc
  // to the hidden side), visible for |s| <= alpha, cos(alpha) = -c.z / r.
  let u=(v1*v1.z+v2*v2.z)/r;let w=(v2*v1.z-v1*v2.z)/r;let alpha=acos(clamp(-c.z/r,-1.0,1.0));let dt=2*alpha/${SEGMENTS}.0;let grow=1/cos(dt*0.5);
  let first=shapeUnit(c+u*cos(alpha)-w*sin(alpha));var a=first;var b=first;var inner=0.0;var outer=0.0;
  for(var i=1;i<=${SEGMENTS};i++){let t=f32(i)*dt-alpha;let h=t-dt*0.5;
    let p=shapeUnit(c+u*cos(t)+w*sin(t));inner+=shapeEdge(a,p);a=p;
    let q=shapeUnit(c+(u*cos(h)+w*sin(h))*grow);outer+=shapeEdge(b,q);b=q;}
  return (abs(inner+shapeEdge(a,first))+2*abs(outer+shapeEdge(b,a)+shapeEdge(a,first)))/3;
}
fn shapeForm(local:mat3x3f,lobe:mat3x3f,d:ShapeDisc)->vec2f {return vec2f(shapeDiscForm(lobe,d),shapeDiscForm(local,d));}
fn shapeArc(end:vec3f,r:f32,outward:vec3f,chord:vec3f,origin:vec3f)->ShapeArc {
  let d=shapeSilhouette(end,r);let rho=length(d.t1);let normal=end*inverseSqrt(max(dot(end,end),1e-30));
  let o=outward-normal*dot(outward,normal);let ox=o*inverseSqrt(max(dot(o,o),1e-30));
  let x=clamp(dot(end+chord-d.c,ox)/max(rho,1e-30),-1.0,1.0);let f=origin-d.c;let side=f-ox*dot(f,ox);
  return ShapeArc(d.c,ox*rho,-side*inverseSqrt(max(dot(side,side),1e-30))*rho,acos(x));
}
fn shapeWalk(m:mat3x3f,a:ShapeArc,last:vec3f,outer:bool,prev:ptr<function,vec3f>,leave:ptr<function,vec3f>,enter:ptr<function,vec3f>)->f32 {
  let dt=2*a.beta/${ARC_SEGMENTS}.0;let grow=select(1.0,1/cos(dt*0.5),outer);let start=select(1,0,outer);var sum=0.0;
  for(var i=start;i<${ARC_SEGMENTS};i++){let t=-a.beta+(f32(i)+select(0.0,0.5,outer))*dt;let q=m*(a.c+(a.x*cos(t)+a.y*sin(t))*grow);
    sum+=shapeClip(*prev,q,leave,enter);*prev=q;}
  let q=m*last;sum+=shapeClip(*prev,q,leave,enter);*prev=q;return sum;
}
fn shapeHull(m:mat3x3f,s:vec3f,e:vec3f,t0:vec3f,t1:vec3f,ae:ShapeArc,sa:ShapeArc,outer:bool)->f32 {
  var leave=vec3f(0);var enter=vec3f(0);let first=m*(s+t0);var prev=m*(e+t0);
  var sum=shapeClip(first,prev,&leave,&enter);
  sum+=shapeWalk(m,ae,e+t1,outer,&prev,&leave,&enter);
  let q=m*(s+t1);sum+=shapeClip(prev,q,&leave,&enter);prev=q;
  sum+=shapeWalk(m,sa,s+t0,outer,&prev,&leave,&enter);
  return abs(sum+shapeEdge(shapeUnit(leave),shapeUnit(enter)));
}
fn shapeTube(local:mat3x3f,lobe:mat3x3f,s:vec3f,e:vec3f,r:f32)->vec2f {
  let axis=normalize(e-s);let off=-s-axis*dot(-s,axis);let h=length(off);
  if(!(h>r)){return select(vec2f(0),shapeForm(local,lobe,shapeSilhouette(s,r)),dot(axis,s)>0.0)+select(vec2f(0),shapeForm(local,lobe,shapeSilhouette(e,r)),dot(axis,e)<0.0);}
  let u=off/h;let w=cross(axis,u);let cosine=r/h;let sine=sqrt(max(1-cosine*cosine,0.0));
  let t0=u*(r*cosine)+w*(r*sine);let t1=u*(r*cosine)-w*(r*sine);let chord=u*(r*cosine);
  let ae=shapeArc(e,r,axis,chord,e+t0);let sa=shapeArc(s,r,-axis,chord,s+t1);
  return vec2f(shapeHull(lobe,s,e,t0,t1,ae,sa,false)+2*shapeHull(lobe,s,e,t0,t1,ae,sa,true),
    shapeHull(local,s,e,t0,t1,ae,sa,false)+2*shapeHull(local,s,e,t0,t1,ae,sa,true))/3;
}
fn clusterShapeLighting(position:vec3f,n:vec3f,v:vec3f,nv:f32,base:vec3f,roughness:f32,metal:f32,dielectricF0:vec3f,dielectricF90:f32)->vec3f {
  let st=vec2f(clamp(roughness,0.045,1.0),sqrt(1-nv))*${ltcSize - 1}.0;let t1=vec4f(shapeLut(st,0u),shapeLut(st,1u));let t2=shapeLut(st,2u);
  var t=v-n*dot(n,v);if(dot(t,t)<1e-8){t=cross(n,select(vec3f(1,0,0),vec3f(0,0,1),abs(n.x)>0.5));}
  let x=normalize(t);let local=transpose(mat3x3f(x,cross(n,x),n));
  let lobe=mat3x3f(vec3f(t1.x,0,t1.y),vec3f(0,1,0),vec3f(t1.z,0,t1.w))*local;
  var specular=vec3f(0);var diffuse=vec3f(0);
  for(var j=0u;j<shapeLights.count.x;j++){
    let light=shapeLights.lights[j];let a=light.a.xyz-position;let r=light.b.w;var form=vec2f(0);
    if(light.a.w<0.5){form=shapeForm(local,lobe,shapeSilhouette(a,r));}
    else if(light.a.w<1.5){if(dot(light.b.xyz,a)>0.0&&light.color.w<0.5){continue;}let b=shapeBasis(light.b.xyz)*r;form=shapeForm(local,lobe,ShapeDisc(a,b[0],b[1]));}
    else{form=shapeTube(local,lobe,a,light.b.xyz-position,r);}
    specular+=light.color.rgb*form.x;diffuse+=light.color.rgb*form.y;
  }
  let f0=mix(dielectricF0,base,metal);
  return (f0*t2.x+(mix(dielectricF90,1.0,metal)-f0)*t2.y)*specular+(1-metal)*base*diffuse;
}
`;
/**
 * Sphere, disc and tube (capsule) area lights for clustered lighting: bulbs, round fixtures and fluorescent tubes whose
 * highlights take the light's shape and whose falloff near the light follows its size. Shaded with Linearly
 * Transformed Cosines (Heitz et al. 2016) like the rectangle lights of `@margoengine/clustered/area`: GGX specular and
 * Lambert diffuse, clipped to each surface's horizon. Core meshes and every receiver of the `lights` are lit. Every
 * fragment evaluates every shaped light (no cluster culling: the lights have no range). Without lights it adds nothing
 * to the shaders or the GPU work. Shadows are not cast (see docs/limits.md).
 * @throws TypeError without the Clustered lights; RangeError for an invalid light or more than `MAX_SHAPE_LIGHTS`.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`.
 */
export class ShapeLights implements EnginePlugin, ClusteredShapes {
  readonly name = 'clustered:shapes';
  readonly lights: Clustered;
  private engine?: Engine;
  private device?: GPUDevice;
  private buffer?: GPUBuffer;
  private entries: GPUBindGroupEntry[] = [];
  /** @internal The packed lights: a count, then 12 floats per light (a.xyz + kind, b.xyz + radius, radiance + twoSided). */
  readonly data = new Float32Array(HEADER + MAX_SHAPE_LIGHTS * LIGHT_FLOATS);
  private readonly count = new Uint32Array(this.data.buffer, 0, 1);
  private listValue: readonly ShapedLight[] = Object.freeze([]);
  private dirty = true;
  private disposed = false;
  constructor(options: ShapeLightOptions) {
    if (!options?.lights || typeof options.lights.setLights !== 'function')
      throw new TypeError('ShapeLights needs the Clustered lights');
    this.lights = options.lights;
  }
  get owner(): Engine | undefined {
    return this.engine;
  }
  static attach(instance: EngineKernel, options: ShapeLightOptions): ShapeLights {
    const effect = new ShapeLights(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  /** The lights last given to `setLights`, in order (a frozen copy of the list). */
  get list(): readonly ShapedLight[] {
    return this.listValue;
  }
  /**
   * Replaces the shaped lights (at most {@link MAX_SHAPE_LIGHTS}); validates every entry before changing anything. An
   * empty list removes the shader code.
   */
  setLights(lights: readonly ShapedLight[]): this {
    if (this.disposed || !Array.isArray(lights) || lights.length > MAX_SHAPE_LIGHTS)
      throw new RangeError(`Expected at most ${MAX_SHAPE_LIGHTS} shaped lights`);
    const packed = lights.map(pack);
    packed.forEach((values, i) => this.data.set(values, HEADER + i * LIGHT_FLOATS));
    this.count[0] = lights.length;
    this.listValue = Object.freeze([...lights]);
    this.dirty = true;
    this.sync();
    return this;
  }
  /** @internal ClusteredShapes: WGSL defining `clusterShapeLighting`. */
  declarations(group: number): string {
    return sampling(group);
  }
  /** @internal ClusteredShapes: binding 150 of the lit shader's group. */
  bindings(): GPUBindGroupEntry[] {
    if (!this.buffer || this.disposed)
      throw new MargoError('state', 'Shape lights are not attached; attach them to an engine first');
    return this.entries;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Attach new ShapeLights on WebGPU; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.device = engine.gpu;
    this.dirty = true;
    this.sync();
  }
  // The buffer (with the table) and the hook exist only while there are lights, so an empty ShapeLights changes no GPU call.
  private sync(): void {
    const active = !!this.device && !this.disposed && this.count[0] > 0;
    if (active && !this.buffer) {
      const table = ltcTable(),
        buffer = (this.buffer = this.device!.createBuffer({
          size: LUT_OFFSET + table.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        }));
      this.device!.queue.writeBuffer(buffer, LUT_OFFSET, table as Uint16Array<ArrayBuffer>);
      this.entries = [{ binding: BINDING, resource: { buffer } }];
      this.dirty = true;
    }
    const hook = active ? this : undefined;
    if (this.lights.shapes !== hook) this.lights.shapes = hook;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: -3.5,
      execute: (c) => {
        if (c.backend !== 'webgpu' || !this.buffer || !this.dirty) return;
        c.device.queue.writeBuffer(
          this.buffer,
          0,
          this.data as Float32Array<ArrayBuffer>,
          0,
          HEADER + this.count[0] * LIGHT_FLOATS,
        );
        this.dirty = false;
      },
    });
  }
  private release(): void {
    if (this.lights.shapes === this) this.lights.shapes = undefined;
    this.buffer?.destroy();
    this.buffer = undefined;
    this.entries = [];
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

const invalid = (what: string) =>
  new RangeError(
    `Invalid shaped light ${what}; give a shape of 'sphere', 'disc' or 'tube', finite positions, a positive finite radius, a non-zero disc direction, a colour with luminance of 0 or more and a finite intensity of 0 or more`,
  );
// One light's 12 floats; throws before anything changes.
function pack(light: ShapedLight): number[] {
  if (!light || typeof light !== 'object') throw invalid('entry');
  const intensity = light.intensity ?? 1,
    color = light.color ?? [1, 1, 1];
  finiteVector(color, 3, 'Shaped light color');
  if (!(0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2] >= 0)) throw invalid('color');
  if (!(intensity >= 0) || !Number.isFinite(Math.fround(intensity))) throw invalid('intensity');
  if (!(light.radius > 0) || !Number.isFinite(Math.fround(light.radius))) throw invalid('radius');
  const radiance = [color[0] * intensity, color[1] * intensity, color[2] * intensity];
  if (light.shape === 'sphere') {
    finiteVector(light.position, 3, 'Sphere light position');
    return [...light.position, 0, 0, 0, 0, light.radius, ...radiance, 0];
  }
  if (light.shape === 'disc') {
    finiteVector(light.position, 3, 'Disc light position');
    finiteVector(light.direction, 3, 'Disc light direction');
    const length = Math.hypot(...light.direction);
    if (!(length > 0) || !Number.isFinite(length)) throw invalid('direction');
    if (typeof (light.twoSided ?? false) !== 'boolean') throw new TypeError('Disc light twoSided must be a boolean');
    return [
      ...light.position,
      1,
      ...light.direction.map((v) => v / length),
      light.radius,
      ...radiance,
      light.twoSided ? 1 : 0,
    ];
  }
  if (light.shape === 'tube') {
    finiteVector(light.start, 3, 'Tube light start');
    finiteVector(light.end, 3, 'Tube light end');
    const [s, e] = [light.start, light.end];
    // A zero-length tube is a sphere: the shader needs an axis.
    if (s[0] === e[0] && s[1] === e[1] && s[2] === e[2]) return [...s, 0, 0, 0, 0, light.radius, ...radiance, 0];
    return [...s, 2, ...e, light.radius, ...radiance, 0];
  }
  throw invalid('shape');
}
