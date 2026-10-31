import type { MaterialExtension } from '@margoengine/gltf-pro';
import { coordinateExpression } from './coordinates.js';
import type { ClearcoatTextureSlot } from './shader.js';

export interface TransmissionShaderTextures {
  /** Snapshot of the opaque scene, in the render attachment's original format. */
  opaque: number;
  factor?: ClearcoatTextureSlot;
  thickness?: ClearcoatTextureSlot;
  /** [factor, IOR, thickness, inverse attenuation distance], then [attenuation RGB, dispersion]. */
  factorsIndex?: number;
  /** A clearcoat is composed under this extension: its `materialCoatKeep` also scales the transmitted light. */
  coated?: boolean;
}
/** Compiler-owned expressions evaluated in the extension's surface hook. */
export interface TransmissionShaderValues {
  factor: string;
  ior: string;
  thickness: string;
  attenuation: string;
  inverseDistance: string;
  dispersion?: string;
}

/** WGSL reading a material map at the fragment's UV: filtered when the slot has a sampler, else the nearest texel. */
function readMap(slot: ClearcoatTextureSlot, explicitLevel: boolean): string {
  const texture = `materialTexture${slot.index}`,
    coords = coordinateExpression(slot);
  if (slot.sampler)
    return explicitLevel
      ? `textureSampleLevel(${texture},materialSampler${slot.index},${coords},0.0)`
      : `textureSample(${texture},materialSampler${slot.index},${coords})`;
  const size = `vec2f(textureDimensions(${texture},0))`;
  return `textureLoad(${texture},vec2i(clamp(${coords}*${size},vec2f(0),${size}-vec2f(1))),0)`;
}

/**
 * Screen-space KHR_materials_transmission / KHR_materials_volume / KHR_materials_dispersion for a material extension.
 * The opaque-scene snapshot is read where the view ray, refracted by Snell's law, leaves a slab `thickness` deep (mesh
 * units, measured along the mesh normal). That light is tinted by the base colour and attenuated by Beer-Lambert
 * (T = attenuationColor^(path / attenuationDistance)), then added to the lit colour, weighted in linear light by the
 * factor, the dielectric share (1 - metal), 1 - Schlick Fresnel and what the layers above leave of it: glTF puts the
 * transmitted light in the base layer, under fresnel_mix (KHR_materials_transmission, KHR_materials_specular), sheen
 * and clearcoat. The host already dims diffuse and ambient light by the factor.
 *
 * @param textures - Slot of the opaque snapshot, optional transmission (R) and thickness (G) maps, and the factor row.
 * @param values - Compiler-owned WGSL expressions used in place of the factor rows (node materials).
 * @returns The extension's module declarations, beauty `output` statement and `transmission` weight expression.
 */
export function transmissionShader(
  textures: TransmissionShaderTextures,
  values?: TransmissionShaderValues,
): Pick<MaterialExtension, 'declarations' | 'output' | 'transmission' | 'ior'> {
  const row = textures.factorsIndex ?? 0,
    first = `materialFactors[${row}]`,
    second = `materialFactors[${row + 1}]`,
    snapshot = `materialTexture${textures.opaque}`;
  let helpers = '',
    factor: string,
    thickness: string;
  if (values) {
    factor = values.factor;
    thickness = values.thickness;
  } else {
    factor = `${first}.x`;
    thickness = `max(${first}.z,0.0)`;
    if (textures.factor) {
      // Evaluated in the surface hook (uniform control flow), so the map keeps its mip filtering.
      helpers += `fn materialTransmissionMap(i:Out)->f32 {return ${first}.x*${readMap(textures.factor, false)}.r;}\n`;
      factor = 'materialTransmissionMap(i)';
    }
    if (textures.thickness) {
      // Read from the output hook (non-uniform control flow), so at an explicit level.
      helpers += `fn materialTransmissionDepth(i:Out)->f32 {return ${first}.z*${readMap(textures.thickness, true)}.g;}\n`;
      thickness = 'max(materialTransmissionDepth(i),0.0)';
    }
  }
  const ior = values ? values.ior : `${first}.y`,
    attenuation = values ? values.attenuation : `${second}.xyz`,
    inverseDistance = values ? values.inverseDistance : `${first}.w`,
    dispersion = values ? (values.dispersion ?? '0.0') : `${second}.w`,
    coat = textures.coated ? '*materialCoatKeep' : '';
  const declarations = /* wgsl */ `${helpers}// IEC 61966-2-1 transfer, to tint display-encoded snapshots in linear light.
fn materialTransmissionLinear(c:vec3f)->vec3f {let x=max(c,vec3f(0)); return select(x/12.92,pow((x+0.055)/1.055,vec3f(2.4)),x>vec3f(0.04045));}
fn materialTransmissionEncode(c:vec3f)->vec3f {let x=max(c,vec3f(0)); return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>vec3f(0.0031308));}
// The snapshot texel under a framebuffer position, clamped to the texture.
fn materialTransmissionRead(p:vec2f)->vec3f {
  let size=vec2f(textureDimensions(${snapshot},0));
  return textureLoad(${snapshot},vec2i(clamp(floor(p),vec2f(0),size-vec2f(1))),0).rgb;
}
// World point to framebuffer position (NDC y up, framebuffer y down); |w| is floored away from zero.
fn materialTransmissionPixel(p:vec3f)->vec2f {
  let c=f.camera*vec4f(p,1.0);
  let w=select(min(c.w,-0.000001),max(c.w,0.000001),c.w>=0.0);
  return (c.xy/w*vec2f(0.5,-0.5)+0.5)*vec2f(textureDimensions(${snapshot},0));
}
// Multiplies the snapshot colour in linear light; a channel whose multiplier is exactly one keeps the value as read.
fn materialTransmissionFilter(captured:vec3f,k:vec3f)->vec3f {
  var filtered=captured*k;
  if(f.settings.w<0.5){filtered=materialTransmissionEncode(materialTransmissionLinear(captured)*k);}
  return select(filtered,captured,k==vec3f(1.0));
}
// Beer-Lambert c^(path*inverseDistance): a white channel stays exactly 1, black stays 0, and 0^0 is never evaluated.
fn materialTransmissionBeer(c:vec3f,path:f32,inverseDistance:f32)->vec3f {
  if(path<=0.0||inverseDistance<=0.0){return vec3f(1.0);}
  let x=clamp(c,vec3f(0),vec3f(1));
  return select(select(pow(max(x,vec3f(0.000001)),vec3f(path*inverseDistance)),vec3f(0.0),x<=vec3f(0.0)),vec3f(1.0),x>=vec3f(1.0));
}
// Light arriving through the surface along one IOR's ray; zero on total internal reflection.
fn materialTransmissionTrace(i:Out,n:vec3f,front:bool,ior:f32,thickness:f32,tint:vec3f,attenuation:vec3f,inverseDistance:f32)->vec3f {
  // Thin wall: the sightline is kept, so the light is this fragment's own pixel.
  if(thickness<=0.0){return materialTransmissionFilter(materialTransmissionRead(i.clip.xy),tint);}
  let d=normalize(i.position-f.eye.xyz);
  let entering=front==(f.coordsB.y>0.0);
  let r=refract(d,faceForward(n,d,n),select(ior,1.0/ior,entering));
  if(dot(r,r)<0.000001){return vec3f(0.0);}
  // Mesh space: the ray a = M^-1 r and the unit mesh normal m. Moving t along r moves t*a in mesh space, so the slab
  // depth (along m) is crossed after the world length thickness/|a.m|; this keeps rotation and non-uniform scale right.
  let c0=f.model[0].xyz; let c1=f.model[1].xyz; let c2=f.model[2].xyz;
  let x0=cross(c1,c2); let x1=cross(c2,c0); let x2=cross(c0,c1);
  let det=dot(c0,x0);
  let a=vec3f(dot(x0,r),dot(x1,r),dot(x2,r))/select(det,0.000000000001,abs(det)<0.000000000001);
  let g=vec3f(dot(c0,i.normal),dot(c1,i.normal),dot(c2,i.normal));
  let m=g/max(length(g),0.00000001);
  let path=thickness/max(abs(dot(a,m)),0.0001);
  // Only the bending moves the lookup: the exit point against the point as far along the unbent view ray.
  let shift=materialTransmissionPixel(i.position+r*path)-materialTransmissionPixel(i.position+d*path);
  let at=select(i.clip.xy+shift,i.clip.xy,ior==1.0);
  return materialTransmissionFilter(materialTransmissionRead(at),tint*materialTransmissionBeer(attenuation,path,inverseDistance));
}
// Dielectric F0 of the current fragment, ((IOR-1)/(IOR+1))^2 (KHR_materials_ior), set by materialTransmission
// before it calls materialTransmissionWeight (whose four-argument call the host contract fixes). Zero at IOR 1.
var<private> materialTransmissionF0:f32=0.04;
// The share lobes composed over transmission compute in place of the one below (materialLobesTransmitted, in the
// output hook); negative while no lobe has set it.
var<private> materialTransmissionLobes:vec3f=vec3f(-1.0);
// Share of the light behind that enters: the dielectric part less the Schlick Fresnel reflection (glTF 2.0 Appendix B).
fn materialTransmissionWeight(s:Surface,v:vec3f,n:vec3f,factor:f32)->vec3f {
  if(materialTransmissionLobes.x>=0.0){return factor*materialTransmissionLobes${coat};}
  let f0=mix(vec3f(materialTransmissionF0),clamp(s.base.rgb,vec3f(0),vec3f(1)),s.metal);
  let q=1.0-clamp(dot(n,v),0.0,1.0); let q2=q*q;
  return factor*(1.0-s.metal)*(1.0-(f0+(1.0-f0)*q2*q2*q))${coat};
}
fn materialTransmission(i:Out,s:Surface,color:vec3f,front:bool,factor:f32,ior:f32,thickness:f32,attenuation:vec3f,inverseDistance:f32,dispersion:f32)->vec3f {
  let v=normalize(f.eye.xyz-i.position);
  let n=s.n;
  let tint=clamp(s.base.rgb,vec3f(0),vec3f(1));
  var transmitted=materialTransmissionTrace(i,n,front,ior,thickness,tint,attenuation,inverseDistance);
  if(dispersion>0.0&&thickness>0.0&&ior!=1.0){
    // KHR_materials_dispersion: IOR spread (IOR-1)*0.025*dispersion; red and blue each read on their own ray.
    let spread=(ior-1.0)*0.025*dispersion;
    let red=materialTransmissionTrace(i,n,front,max(1.0,ior-spread),thickness,tint,attenuation,inverseDistance);
    let blue=materialTransmissionTrace(i,n,front,ior+spread,thickness,tint,attenuation,inverseDistance);
    transmitted=vec3f(red.r,transmitted.g,blue.b);
  }
  let r0=(ior-1.0)/(ior+1.0);
  materialTransmissionF0=r0*r0;
  return color+materialTransmissionFilter(transmitted,materialTransmissionWeight(s,v,n,factor));
}
`;
  return {
    transmission: factor,
    // The host's reflection F0 follows this IOR too (0 at IOR 1), the same F0 the transmitted share subtracts.
    ior,
    output: `if(s.tr>0.0){color=materialTransmission(i,s,color,front,s.tr,${ior},${thickness},${attenuation},${inverseDistance},${dispersion});}`,
    declarations,
  };
}
