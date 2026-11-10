// Every lobe of a physical material lit by the clustered lights. By default a clustered light reaches a physical surface
// as plain GGX on the base: its clearcoat and sheen answer only the main directional light, and anisotropy and the thin
// film do not bend its highlight. This hook rewrites a physical shader's light loops (and only those) so that each light
// also goes through the surface's own direct BRDF and its coat and sheen, with the same falloff, cone, profile and
// shadow as the base. Layering follows gltf-pro's `layers`: the sum under the coat is attenuated there, so the base stays
// in `result`, and the lobes above it are added after.
import { clusterBrdf } from '../../shared/light-terms.js';
import type { ClusteredLobes } from './index.js';

const term = 'result+=' + clusterBrdf + '*nl*',
  weighted = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^;]*);', 'g'),
  front = /(@fragment fn fragment\([^{]*\{\s*let s=surface\(i,front\);)/,
  layered = 'color=layers(s,v,l,color);',
  // The coat over everything, and the sheen on the base under the coat: both as `layers` weighs them.
  declarations = /* wgsl */ `var<private> clusterSurface:Surface;
var<private> clusterLobeLight:vec3f=vec3f(0);
fn clusterLobes(v:vec3f,l:vec3f)->vec3f {
  let s=clusterSurface; let h=(v+l)/max(length(v+l),0.0001);
  let nl=clamp(dot(s.n,l),0.0,1.0); let nv=clamp(dot(s.n,v),0.0001,1.0);
  let fc=0.04+0.96*pow(1-clamp(dot(s.cn,v),0.0,1.0),5.0);
  return (1-s.cc*fc)*s.sh.rgb*margoSheenBRDF(s.sh.w,nl,nv,clamp(dot(s.n,h),0.0,1.0))*nl+s.cc*fc*ggx(s.cn,v,l,s.cr);
}
`;
/** The coat under area and shaped lights: the Linearly Transformed Cosines of the coat's normal and roughness, F0 0.04, no diffuse. */
const coat = (fn: string) =>
  `if(s.cc>0.0){clusterLobeLight+=s.cc*${fn}(i.position,s.cn,v,clamp(dot(s.cn,v),0.0001,1.0),vec3f(0),s.cr,0.0,vec3f(0.04),1.0);}`;
/**
 * Set as `Clustered.lobes`: `lights.lobes = physicalLobes`. Physical shaders then light clearcoat, sheen, anisotropy and
 * the thin film with every point, spot and extra directional light, and clearcoat with every area and shaped light. Shaders without
 * those lobes keep their text. Costs one more GGX and sheen term per light on physical materials only.
 */
export const physicalLobes: ClusteredLobes = {
  finish(code) {
    if (!code.includes('fn layers(')) return code;
    const direct = code.includes('fn margoDirect(') ? 'margoDirect(clusterSurface,v,l)' : clusterBrdf + '*nl',
      area =
        (code.includes('fn clusterAreaLighting(') ? coat('clusterAreaLighting') : '') +
        (code.includes('fn clusterShapeLighting(') ? coat('clusterShapeLighting') : '');
    return (
      declarations +
      code
        .replace(
          weighted,
          (_, weight: string) =>
            `{let clusterWeight=${weight};result+=${direct}*clusterWeight;clusterLobeLight+=clusterLobes(v,l)*clusterWeight;}`,
        )
        .replace(front, '$1clusterSurface=s;')
        .replace(layered, `${layered}${area}color+=clusterLobeLight*clusterFrame.intensity.x;`)
    );
  },
};
