// An eye: a sphere whose front is a clear cornea over a flat iris set back from it. The view ray refracts at the cornea by
// Snell's law and meets the iris plane, so the iris sits inside the eye and shifts with the view, instead of being painted
// on the ball. The light refracts the same way, so the iris is lit through the cornea, brightest on the side away from the
// light. The sizes are those of Gullstrand's schematic eye as usually quoted: cornea index 1.376, an eyeball 24 mm across,
// an iris about 11.7 mm across and an anterior chamber about 3 mm deep. Outside the cornea the material is the sclera. The
// reflection is GGX on the smooth cornea, F0 from the index, on the mesh's normal; a normal map shows on the sclera only.
import { ggxD, smithG } from '../../shared/light-terms.js';
import { direction, float, localShaded, shaded, vec3, vertexFields, within } from './character-light.js';
import { whiteTexture } from '../../shared/white-texture.js';
import type { Material, MaterialFeature, Texture } from './built-material.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** Options of `eye()`. */
export interface EyeOptions {
  /** Iris picture, its centre at the middle of the map. Default none: fibres drawn in `irisColor`. */
  irisMap?: Texture;
  /** Pupil radius in `irisMap`, as a share of the iris's radius. Default 0.3. */
  irisMapPupil?: number;
  /** Linear colour of the iris, three numbers; it multiplies `irisMap`. Live on the feature. Default a grey blue. */
  irisColor?: readonly [number, number, number];
  /** Pupil radius, as a share of the iris's radius, above 0, below 1. Live on the feature. Default 0.3. */
  pupil?: number;
  /** Iris radius, as a share of the eyeball's radius. Default 0.49. */
  irisRadius?: number;
  /** How far the iris sits behind the front of the eyeball, as a share of its radius. Default 0.25. */
  depth?: number;
  /** Index of refraction of the cornea. Default 1.376. */
  ior?: number;
  /** The way the eye looks, in the mesh's axes. Default [0, 0, 1]. */
  axis?: readonly [number, number, number];
  /** The centre of the eyeball, in the mesh's axes. Default [0, 0, 0]. */
  center?: readonly [number, number, number];
}
/** What `eye()` returns: the feature, and the numbers that stay live. */
export interface EyeFeature extends MaterialFeature {
  /** Pupil radius, as a share of the iris's radius. */
  pupil: number;
  /** Linear colour of the iris. */
  irisColor: [number, number, number];
}
const code = (
  group: number,
  mapped: boolean,
  ior: string,
  f0: string,
  mapPupil: string,
) => `struct MargoEyeRows {iris:vec4f, shape:vec4f}
@group(${group}) @binding(132) var<uniform> margoEyeRows:MargoEyeRows;
${mapped ? `@group(${group}) @binding(133) var margoEyeMap:texture_2d<f32>;\n@group(${group}) @binding(134) var margoEyeSampler:sampler;\n` : ''}var<private> margoEyeCornea:f32;
var<private> margoEyeLook:vec3f;
var<private> margoEyeRoughness:f32;
fn margoEyeHash(k:f32)->f32 {
  var x=bitcast<u32>(i32(k))*747796405u+2891336453u; x=((x>>((x>>28u)+4u))^x)*277803737u; x^=x>>22u;
  return f32(x>>8u)/16777216.0;
}
fn margoEyeSpokes(angle:f32,count:f32)->f32 {
  let a=(angle/6.2831853+0.5)*count; let low=floor(a); let t=a-low;
  return mix(margoEyeHash(low),margoEyeHash(low+1.0-select(0.0,count,low+1.0>=count)),t*t*(3.0-2.0*t));
}
// Fibres: spokes of two scales, darker toward the pupil and the rim, and a lighter ring a third of the way out.
fn margoEyeFibres(q:vec2f,t:f32)->vec3f {
  let angle=atan2(q.y,q.x); let fine=margoEyeSpokes(angle,96.0); let broad=margoEyeSpokes(angle,24.0);
  let ring=exp(-pow((t-0.32)/0.14,2.0));
  return vec3f((0.45+0.35*fine+0.3*broad)*(0.8+0.5*ring));
}
fn margoEyeSurface(i:Out,n:vec3f,under:Surface)->Surface {
  let axis=normalize(i.margoEyeAxis); let right=normalize(i.margoEyeRight-axis*dot(i.margoEyeRight,axis)); let up=cross(axis,right);
  let k=margoEyeRows.shape; let d=i.position-i.margoEyeCentre; let radius=length(d); let iris=radius*k.y;
  let height=dot(d,axis); let rim=length(d-axis*height)/iris;
  let v=normalize(f.eye.xyz-i.position); let r=refract(-v,n,1.0/${ior});
  let hit=d+r*((radius*(1.0-k.w)-height)/min(dot(r,axis),-0.0001));
  let q=vec2f(dot(hit,right),dot(hit,up))/iris; let dx=dpdx(q); let dy=dpdy(q); let reach=length(q);
  let t=clamp((reach-k.z)/(1.0-k.z),0.0,1.0);
  let picture=${mapped ? `textureSampleGrad(margoEyeMap,margoEyeSampler,q/max(reach,0.00001)*mix(${mapPupil},1.0,t)*0.5+0.5,dx*0.5,dy*0.5).rgb` : 'margoEyeFibres(q,t)'};
  let soft=max(length(dx)+length(dy),0.004);
  let colour=margoEyeRows.iris.rgb*picture*smoothstep(k.z-soft,k.z+soft,reach)*mix(1.0,0.25,smoothstep(0.8,1.0,reach));
  // Where the ray misses the iris it meets the white of the eye, in the iris's shadow.
  let inside=mix(colour,under.base.rgb*0.25,smoothstep(1.0,1.08,reach));
  let cornea=select(0.0,1.0-smoothstep(0.94,1.06,rim),height>0.0);
  var s=under; s.base=vec4f(mix(under.base.rgb,inside,cornea),under.base.a); s.n=normalize(mix(under.n,n,cornea));
  s.roughness=mix(under.roughness,0.05,cornea); s.metal=0.0;
  margoEyeCornea=cornea; margoEyeLook=axis; margoEyeRoughness=s.roughness;
  return s;
}
fn margoEyeLight(n:vec3f,v:vec3f,l:vec3f,base:vec3f)->vec3f {
  let h=(v+l)/max(length(v+l),0.0001); let nl=clamp(dot(n,l),0.0,1.0); let nv=clamp(dot(n,v),0.0001,1.0);
  let nh=clamp(dot(n,h),0.0,1.0); let vh=clamp(dot(v,h),0.0,1.0); let a=margoEyeRoughness*margoEyeRoughness; let a2=a*a;
  let d=${ggxD}; let g=${smithG}; let f0=mix(0.04,${f0},margoEyeCornea); let fresnel=f0+(1-f0)*pow(1-vh,5.0);
  let through=select(0.0,max(dot(-refract(-l,n,1.0/${ior}),margoEyeLook),0.0),nl>0.0);
  return (1-fresnel)*base/3.14159265*mix(nl,through,margoEyeCornea)+d*g*fresnel/max(4*nv,0.0001);
}
`;
/**
 * An eye for a sphere mesh: a refracting cornea over an iris set back inside it, with a pupil that opens and closes.
 * Assign it through `Material.features` on a `PbrMaterial`, whose `color`, `map` and `roughness` are the white of the eye.
 * Works on any size of sphere with nothing else; `feature.pupil` and `feature.irisColor` are live.
 */
export function eye(options: EyeOptions = {}): EyeFeature {
  const { irisMap, irisMapPupil = 0.3, irisRadius = 0.49, depth = 0.25, ior = 1.376, center = [0, 0, 0] } = options,
    look = direction(options.axis ?? [0, 0, 1], 'eye axis');
  within(irisMapPupil, 0, 0.99, 'eye irisMapPupil');
  within(irisRadius, 0, 1, 'eye irisRadius');
  within(depth, 0, 1, 'eye depth');
  within(ior, 1, 3, 'eye ior');
  if (!Array.isArray(center) || center.length !== 3 || !center.every((v) => Number.isFinite(Math.fround(v))))
    throw new TypeError("eye center must be three finite numbers; pass a point in the mesh's axes");
  if (irisMap !== undefined && typeof irisMap?.bind !== 'function')
    throw new TypeError('eye irisMap must be a Texture; pass one');
  // Any direction across the axis: the iris has no up of its own.
  const across = Math.abs(look[1]) > 0.9 * Math.hypot(...look) ? [1, 0, 0] : [0, 1, 0],
    side = [
      across[1] * look[2] - across[2] * look[1],
      across[2] * look[0] - across[0] * look[2],
      across[0] * look[1] - across[1] * look[0],
    ],
    f0 = ((ior - 1) / (ior + 1)) ** 2,
    cached = new Map<string, string>(),
    data = new Float32Array(8),
    buffers = new Map<GPUDevice, { buffer: GPUBuffer; last: Float32Array }>();
  let users = 0,
    pupil = 0.3;
  const feature: EyeFeature = {
    name: 'eye',
    serialization: () => ({
      ...options,
      irisColor: [...feature.irisColor],
      pupil: feature.pupil,
      axis: [...look],
      center: [...center],
    }),
    irisColor: [...(options.irisColor ?? [0.16, 0.3, 0.42])],
    get pupil() {
      return pupil;
    },
    set pupil(v: number) {
      if (typeof v !== 'number' || !(v > 0 && v < 1))
        throw new RangeError('eye pupil must be above 0 and below 1; pass a share of the iris radius such as 0.3');
      pupil = v;
    },
    shader(source, group) {
      const id = group + source;
      let out = cached.get(id);
      if (out !== undefined) return out;
      out = shaded(source, 'margoEyeLight', '  s=margoEyeSurface(i,n,s);', 'eye');
      out = vertexFields(
        out,
        '@location(13) @interpolate(flat) margoEyeAxis:vec3f, @location(14) @interpolate(flat) margoEyeRight:vec3f, @location(15) @interpolate(flat) margoEyeCentre:vec3f',
        `o.margoEyeAxis=(margoObjectModel*vec4f(${vec3(look)},0)).xyz; o.margoEyeRight=(margoObjectModel*vec4f(${vec3(side)},0)).xyz; o.margoEyeCentre=(margoObjectModel*vec4f(${vec3(center)},1)).xyz;`,
        'eye',
      );
      out = code(group, !!irisMap, float(ior), float(f0), float(irisMapPupil)) + out;
      if (cached.size >= 16) cached.clear();
      cached.set(id, out);
      return out;
    },
    lit: (source) => localShaded(source, 'margoEyeLight'),
    bindings(device: GPUDevice) {
      let held = buffers.get(device);
      if (!held)
        buffers.set(
          device,
          (held = {
            buffer: device.createBuffer({
              size: data.byteLength,
              usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            }),
            last: new Float32Array(data.length).fill(Number.NaN),
          }),
        );
      data.set([...feature.irisColor, 1, 1, irisRadius, pupil, depth]);
      // Steady frames upload nothing.
      if (data.some((v, k) => v !== held.last[k])) {
        device.queue.writeBuffer(held.buffer, 0, data);
        held.last.set(data);
      }
      const entries: GPUBindGroupEntry[] = [{ binding: 132, resource: { buffer: held.buffer } }];
      if (irisMap) {
        const [view, sampler] = irisMap.bind(device, true) ?? whiteTexture(device, '2d');
        entries.push({ binding: 133, resource: view }, { binding: 134, resource: sampler });
      }
      return entries;
    },
    attach(_material: Material) {
      users++;
    },
    detach(_material: Material) {
      if (--users > 0) return;
      for (const { buffer } of buffers.values()) buffer.destroy();
      buffers.clear();
    },
  };
  feature.pupil = options.pupil ?? 0.3;
  return feature;
}
