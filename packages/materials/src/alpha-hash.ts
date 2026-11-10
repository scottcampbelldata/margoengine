// Hashed alpha testing (Wyman and McGuire 2017, "Hashed Alpha Testing", I3D): the alpha test compares against a noise
// value instead of a fixed cutoff, so opacity comes out as coverage. The noise is a hash of the object-space position
// at a grid about one pixel across, which keeps it on the surface as the object or camera moves; two power-of-two
// grids are blended so the pattern does not pop as the distance changes, and the blend's sum is remapped back to a
// uniform distribution (the paper's CDF correction). The cell hash is pcg3d (Jarzynski and Olano 2020).
import type { Material, MaterialFeature } from './built-material.js';

/** Options of `alphaHash()`. */
export interface AlphaHashOptions {
  /** Noise cells per pixel: above 1 a finer grain, below 1 coarser. Default 1. */
  scale?: number;
  /**
   * The alpha cutoff of the passes that do not run the colour shader (shadow maps, picking, contact shadows, TAA
   * velocity), used while the material's own `alphaTest` is 0. Above 0, at most 1. Default 0.5.
   */
  cutoff?: number;
}
const code = (scale: string) => `fn margoHashCell(cell:vec3f)->f32 {
  var v=bitcast<vec3u>(vec3i(floor(cell)))*1664525u+1013904223u;
  v.x+=v.y*v.z; v.y+=v.z*v.x; v.z+=v.x*v.y; v^=v>>vec3u(16u); v.x+=v.y*v.z; v.y+=v.z*v.x; v.z+=v.x*v.y;
  return f32(v.x>>8u)/16777216.0;
}
fn margoAlphaHash(p:vec3f)->f32 {
  let footprint=max(length(dpdx(p)),length(dpdy(p))); let level=log2(${scale}/max(footprint,1e-20)); let low=floor(level);
  let t=level-low; let x=mix(margoHashCell(p*exp2(low)),margoHashCell(p*exp2(low+1.0)),t); let a=max(min(t,1.0-t),1e-6);
  let middle=(x-0.5*a)/(1.0-a); let spread=2.0*a*(1.0-a);
  let edge=select(1.0-(1.0-x)*(1.0-x)/spread,x*x/spread,x<a);
  return clamp(select(edge,middle,x>=a&&x<1.0-a),1e-6,1.0);
}
`;
const cached = new Map<string, string>(),
  test = /if\(((?:margoAlphaTest&&)?f\.settings\.x>0\.5&&f\.settings\.x<1\.5&&s\.base\.a<)f\.settings\.y\)/g,
  place = /let p=f\.model\*vec4f\(([^;]*),1\);/;
function hashed(source: string, scale: string): string {
  const id = scale + source;
  let out = cached.get(id);
  if (out !== undefined) return out;
  // The derivatives run ahead of the test: its && would put them in non-uniform control flow.
  out = source
    .replace(/(struct Out \{[^}]*?)\n\}/, '$1, @location(12) margoObject:vec3f\n}')
    .replace(place, (line, position: string) => `${line}o.margoObject=${position};`)
    .replace(test, (_, head: string) => `let margoCut=margoAlphaHash(i.margoObject);\n  if(${head}margoCut)`);
  if (!out.includes('o.margoObject=') || !out.includes('margoCut)'))
    throw new TypeError(
      'alphaHash needs the standard gltf-pro PBR shader; use matching gltf-pro and materials versions',
    );
  out = code(scale) + out;
  if (cached.size >= 64) cached.clear();
  cached.set(id, out);
  return out;
}
/**
 * A cut-out that dithers opacity per pixel with noise fixed to the surface, for hair, foliage and fading objects: no
 * sorting, depth written as for any cut-out, and TAA's jitter averages the grain out. Assign it through
 * `Material.features`; a material that does not list it keeps its shader text exactly. Opacity comes from the colour's
 * alpha, `map`, `alphaMap` and vertex colours. A material drawn `transparent` blends instead and ignores it.
 */
export function alphaHash(options: AlphaHashOptions = {}): MaterialFeature {
  const { scale = 1, cutoff = 0.5 } = options;
  if (typeof scale !== 'number' || !(scale > 0) || !Number.isFinite(Math.fround(scale)))
    throw new RangeError('alphaHash scale must be a finite number above 0; pass cells per pixel such as 1');
  if (typeof cutoff !== 'number' || !(cutoff > 0) || cutoff > 1)
    throw new RangeError('alphaHash cutoff must be above 0 and at most 1; pass an alpha such as 0.5');
  const raised = new WeakSet<Material>(),
    // A WGSL float literal, whatever the number's text.
    text = scale.toExponential();
  return {
    name: 'alphaHash',
    serialization: () => ({ scale, cutoff }),
    captureState: (material) => raised.has(material),
    restoreState(material, state) {
      if (typeof state !== 'boolean')
        throw new TypeError('Invalid alphaHash attachment state; restore its captured boolean');
      if (state) raised.add(material);
      else raised.delete(material);
    },
    shader: (source) => hashed(source, text),
    attach(material) {
      if (material.alphaTest === 0) {
        material.alphaTest = cutoff;
        raised.add(material);
      }
    },
    detach(material) {
      if (raised.delete(material) && material.alphaTest === cutoff) material.alphaTest = 0;
    },
  };
}
