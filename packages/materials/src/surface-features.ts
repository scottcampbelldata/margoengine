// Optional surface features of a Material, compiled in by features.ts only while used (letters `p` parallax, `x`
// triplanar, `s` subsurface, `k` its thickness map): a material using none keeps its shader text, bindings and
// uniforms exactly. Bindings (the material's group): 170 the MargoSurface uniform, 171-172 the parallax map and its
// sampler, 173-174 the subsurface thickness map and its sampler.
import { MargoError } from '@margoengine/math/errors';

/**
 * The surface uniform, nine rows (144 bytes): parallax [scale, steps, mode (0 offset, 1 occlusion, 2 relief), 0] and
 * its map's two UV rows; triplanar [scale, sharpness, 0, 0]; subsurface [weight, mode (0 thick, 1 thin), distortion,
 * power], [colour rgb, thickness], [wrap, 0, 0, 0] and the thickness map's two UV rows.
 */
const surfaceStruct =
  'struct MargoSurface {parallax:vec4f, parallaxUV:array<vec4f,2>, triplanar:vec4f, sss:vec4f, sssColor:vec4f, sssWrap:vec4f, thicknessUV:array<vec4f,2>}';
/** Floats in the surface uniform. */
export const surfaceFloats = 36;

function edit(code: string, from: string, to: string): string {
  const next = code.replace(from, () => to);
  if (next === code)
    throw new MargoError(
      'unsupported',
      'Material surface features require the standard gltf-pro PBR shader; use matching @margoengine/gltf-pro and materials versions',
    );
  return next;
}
const head = 'fn surface(i:Out,front:bool)->Surface {';
/** `code` with its `surface()` renamed `name` and a new `surface()` returning `body` (statements in `i`, `front`). */
function wrapSurface(code: string, name: string, body: string): string {
  if (code.split(head).length !== 2)
    throw new MargoError(
      'unsupported',
      'Material surface features need exactly one PBR surface() function; use matching @margoengine/gltf-pro and materials versions',
    );
  return `${code.replace(head, `fn ${name}(i:Out,front:bool)->Surface {`)}\n${head}\n${body}\n}\n`;
}

// Parallax mapping: the view ray marched below the surface through a height field (red, linear: 1 the surface, 0 the
// full depth `parallaxScale` world units below it). The UV change per world unit along the surface is the UV gradient,
// solved from the screen derivatives of the world position and UV (Mikkelsen 2010; Schuler 2013, as in
// shared/tangent-frame.js, here unnormalised), so depth is in world units whatever the UV scale. A ray into the
// surface moves the UV by -(v.grad u, v.grad v) per unit of depth / n.v. Offset mapping (Welsh 2004, "Parallax
// Mapping with Offset Limiting") takes one step without the 1 / n.v; occlusion mapping (Tatarchuk 2006, "Dynamic
// Parallax Occlusion Mapping with Approximate Soft Shadows") steps linearly and interpolates between the last two
// depths; relief mapping (Policarpo, Oliveira and Comba 2005, "Real-Time Relief Mapping on Arbitrary Polygonal
// Surfaces") refines the linear step by six bisections. n.v is held at 0.1 or more (a Margo choice) so grazing views
// do not march off the texture. The march samples with the UV's own derivatives (textureSampleGrad), so it may loop
// on a uniform count without breaking out early, which keeps the rest of surface() in uniform control flow.
const parallaxWgsl = `fn margoSurfaceUV(c:vec2f,a:vec4f,b:vec4f)->vec2f {let p=vec3f(c,1); return vec2f(dot(a.xyz,p),dot(b.xyz,p));}
fn margoHeight(c:vec2f,d1:vec2f,d2:vec2f)->f32 {
  let a=margoSurface.parallaxUV[0]; let b=margoSurface.parallaxUV[1];
  return textureSampleGrad(margoParallaxMap,margoParallaxSampler,margoSurfaceUV(c,a,b),vec2f(dot(a.xy,d1),dot(b.xy,d1)),vec2f(dot(a.xy,d2),dot(b.xy,d2))).r;
}
fn margoParallax(i:Out)->Out {
  let k=margoSurface.parallax; let second=margoSurface.parallaxUV[0].w>0.5;
  let c=select(i.uv.xy,i.uv.zw,second); let d1=dpdx(c); let d2=dpdy(c); let dp1=dpdx(i.position); let dp2=dpdy(i.position);
  let g=normalize(i.normal); let v=normalize(f.eye.xyz-i.position); let n=select(-g,g,dot(g,v)>=0.0);
  let ps=max(max(max(abs(dp1.x),abs(dp1.y)),max(abs(dp1.z),abs(dp2.x))),max(abs(dp2.y),abs(dp2.z)));
  let us=max(max(abs(d1.x),abs(d1.y)),max(abs(d2.x),abs(d2.y)));
  let q1=dp1/max(ps,1e-30); let q2=dp2/max(ps,1e-30); let w1=d1/max(us,1e-30); let w2=d2/max(us,1e-30);
  let r1=cross(q2,n); let r2=cross(n,q1); let det=dot(q1,r1);
  let scale=select(0.0,us/(max(ps,1e-30)*det),ps>0.0&&us>0.0&&abs(det)>1e-6);
  let gu=(r1*w1.x+r2*w2.x)*scale; let gv=(r1*w1.y+r2*w2.y)*scale;
  let march=-vec2f(dot(v,gu),dot(v,gv))*k.x;
  let dir=select(march/max(dot(v,n),0.1),march,k.z<0.5);
  var t=1.0-margoHeight(c,d1,d2);
  if(k.z>0.5) {
    let count=u32(max(k.y,1.0)); let dt=1.0/f32(count);
    var lo=0.0; var above=t; var below=0.0; var found=false;
    for(var j=1u;j<=count;j++) {
      let at=f32(j)*dt; let depth=1.0-margoHeight(c+dir*at,d1,d2);
      if(!found&&at>=depth) {found=true; lo=at-dt; below=at-depth;}
      if(!found) {above=depth-at;}
    }
    t=lo+dt*above/max(above+below,1e-6);
    if(k.z>1.5) {
      var a=lo; var b=lo+dt;
      for(var j=0u;j<6u;j++) {
        let mid=(a+b)*0.5; let inside=mid>=1.0-margoHeight(c+dir*mid,d1,d2);
        b=select(b,mid,inside); a=select(mid,a,inside);
      }
      t=(a+b)*0.5;
    }
  }
  let shifted=c+dir*t; var o=i;
  o.uv=select(vec4f(shifted,i.uv.zw),vec4f(i.uv.xy,shifted),second);
  return o;
}
`;
/** `code` (a materials PBR shader) whose surface reads every UV0 map (or the parallax map's UV set) at the marched UV. */
export function parallaxShader(code: string): string {
  return wrapSurface(code, 'margoParallaxSurface', '  return margoParallaxSurface(margoParallax(i),front);');
}

// Triplanar mapping: surface() evaluated three times, with UV0 replaced by the world position (times the scale)
// projected along each axis, and blended by |n|^sharpness normalised (the weighting of Geiss and Thompson, GPU Gems 3
// ch. 1, 2007). Each projection's U runs to the viewer's right with V up (V along -z for the +y face), so no face shows
// its texture mirrored. The tangents are dropped, so every projection's normal-map frame comes from the derivatives of
// its own coordinates (shared/tangent-frame.js) and each projection perturbs the normal in its own plane; the blended
// normal is renormalised. UV1 is kept, so a lightMap stays on its unwrap.
/** `code` with its surface() blended from three world-space planar projections (the Surface fields of `code`). */
export function triplanarShader(code: string): string {
  const fields = /struct Surface \{([^}]*)\}/.exec(code)?.[1];
  if (!fields)
    throw new MargoError(
      'unsupported',
      'Material triplanar needs the standard gltf-pro PBR Surface struct; use matching @margoengine/gltf-pro and materials versions',
    );
  const blend = fields
    .split(',')
    .map((field) => field.trim().split(':'))
    .map(([name, type]) =>
      /^(f32|vec[234]f)$/.test(type)
        ? `  s.${name}=${name === 'n' || name === 'cn' ? 'normalize(' : '('}a.${name}*w.x+b.${name}*w.y+c.${name}*w.z);`
        : `  s.${name}=select(select(c.${name},b.${name},w.y>=w.z),a.${name},w.x>=max(w.y,w.z));`,
    )
    .join('\n');
  return wrapSurface(
    code,
    'margoPlanarSurface',
    `  let g=normalize(i.normal); let k=margoSurface.triplanar;
  var w=pow(max(abs(g),vec3f(0.0001)),vec3f(k.y)); w/=w.x+w.y+w.z;
  let p=i.position*k.x; let side=select(vec3f(-1),vec3f(1),g>=vec3f(0));
  var o=i; o.tangent=vec4f(0);
  o.uv=vec4f(-side.x*p.z,p.y,i.uv.zw); let a=margoPlanarSurface(o,front);
  o.uv=vec4f(p.x,-side.y*p.z,i.uv.zw); let b=margoPlanarSurface(o,front);
  o.uv=vec4f(side.z*p.x,p.y,i.uv.zw); let c=margoPlanarSurface(o,front);
  var s:Surface;
${blend}
  return s;`,
  );
}

// Subsurface scattering, two approximations of light that enters the surface and leaves it elsewhere. Thick (statues,
// skin, wax): light seen through the object, Barre-Brisebois and Bouchard 2011 ("Approximating Translucency for a
// Fast, Cheap and Convincing Subsurface Scattering Look", GDC 2011): (v . -(l + n distortion))^power, through
// 1 - thickness; plus a wrapped diffuse that carries light past the terminator (Green 2004, GPU Gems ch. 16),
// (n.l + w) / (1 + w)^2, which integrates to pi over the sphere as Lambert's n.l does over the hemisphere, so it moves
// light rather than adding it. Thin (leaves, paper, cloth): the sheet's far side lit as a Lambert surface, max(-n.l, 0),
// through 1 - thickness. Both are tinted by the base and subsurface colours and leave metals alone. The wrap is part of
// the directional light, so shadows darken it; the translucency is added after (light behind the object reaches it
// whatever a shadow map says about the front). Only the engine's directional light scatters.
const subsurfaceWgsl = (thicknessMap: boolean) => `${
  thicknessMap
    ? `fn margoThickness(i:Out)->f32 {
  let a=margoSurface.thicknessUV[0]; let b=margoSurface.thicknessUV[1]; let p=vec3f(select(i.uv.xy,i.uv.zw,a.w>0.5),1);
  return textureSample(margoThicknessMap,margoThicknessSampler,vec2f(dot(a.xyz,p),dot(b.xyz,p))).r;
}`
    : 'fn margoThickness(i:Out)->f32 {return 1.0;}'
}
fn margoSubsurfaceWrap(s:Surface,l:vec3f)->vec3f {
  let k=margoSurface.sss; let w=margoSurface.sssWrap.x; let nl=dot(s.n,l);
  let moved=margoSurface.sssColor.rgb*max(nl+w,0.0)/((1+w)*(1+w))-max(nl,0.0);
  return select(k.x*(1-s.metal)*s.base.rgb/3.14159265*moved*f.radiance.rgb*f.light.w,vec3f(0),k.y>0.5);
}
fn margoSubsurface(i:Out,s:Surface,v:vec3f,l:vec3f)->vec3f {
  let k=margoSurface.sss; let c=margoSurface.sssColor;
  let through=k.x*(1-s.metal)*(1-clamp(c.a*margoThickness(i),0.0,1.0));
  let bent=l+s.n*k.z; let h=bent/max(length(bent),1e-6);
  let lobe=select(pow(clamp(dot(v,-h),0.0,1.0),k.w),clamp(-dot(s.n,l),0.0,1.0),k.y>0.5);
  return s.base.rgb*c.rgb*through*lobe/3.14159265*f.radiance.rgb*f.light.w;
}
`;
/** `code` (a lit materials PBR shader) with the subsurface terms added to its directional light. */
export function subsurfaceShader(code: string, thicknessMap: boolean): string {
  let out = edit(code, 'let direct=direct_light(s,v,l);', 'let direct=direct_light(s,v,l)+margoSubsurfaceWrap(s,l);');
  out = edit(out, 'var color=', 'var color=margoSubsurface(i,s,v,l)+');
  // Auxiliary entries (G-buffer, ambient) call surface() only: they keep the beauty bind group layout.
  return edit(
    out,
    head,
    `${head}\n  _=&margoSurface;${thicknessMap ? '_=margoThicknessMap;_=margoThicknessSampler;' : ''}`,
  );
}

/** Module-scope declarations of the surface features in use, in bind group `group`. */
export function surfaceDeclarations(group: number, parallax: boolean, subsurface: boolean, thickness: boolean): string {
  return `${surfaceStruct}
@group(${group}) @binding(170) var<uniform> margoSurface:MargoSurface;
${
  parallax
    ? `@group(${group}) @binding(171) var margoParallaxMap:texture_2d<f32>;\n@group(${group}) @binding(172) var margoParallaxSampler:sampler;\n${parallaxWgsl}`
    : ''
}${
  thickness
    ? `@group(${group}) @binding(173) var margoThicknessMap:texture_2d<f32>;\n@group(${group}) @binding(174) var margoThicknessSampler:sampler;\n`
    : ''
}${subsurface ? subsurfaceWgsl(thickness) : ''}`;
}
