// Sediment-laden flood water on the Water surface (FG-13): a surface effect `Flood` adds when it carries `sediment`. It
// reads the suspended load (kg/m^3) the flood's record pass keeps in the fourth channel of its wetting record and adds,
// over the clear water's own extinction, the non-algal particle absorption a(l) = a(443) exp(-0.0123 (l - 443)) with
// a(443) = 0.041 m^2/g x concentration (41 per metre for each kg/m^3) at about 650, 550 and 450 nm (M. Babin et al.,
// "Variations in the light absorption coefficients of phytoplankton, nonalgal particles, and dissolved organic matter in
// coastal waters around Europe", J. Geophys. Res. 108(C7), 2003, https://doi.org/10.1029/2001JC000882), and a brown
// back-scatter of 0.02 per kg/m^3 to the water's body colour, the same terms as `BreakingWaveMaterial`'s `sediment`
// (breaking.ts), so a breaking face and the flood behind it read as one water. Foam on muddy water goes a dirty beige.
import { fault } from '../../shared/errors.js';

const TRANSMISSION = 'let transmission=exp(-(vec3f(0.38,0.10,0.045)+vec3f(1.4,1.3,1.5)*murk)*optical);';
const BODY = 'let body=bottom*transmission+frame.color.rgb*(vec3f(1)-transmission)';
const FOAM = 'let foamAlbedo=FOAM_ALBEDO;';

/** The WGSL the effect adds: its uniform (the terrain's origin and size, world x and z) and the load, bilinear per cell. */
function declarations(binding: number, channel: 'x' | 'w'): string {
  return `
struct FloodSilt {origin:vec2f,size:vec2f}
@group(0) @binding(${binding}) var<uniform> floodSilt:FloodSilt;
@group(0) @binding(${binding + 1}) var floodSiltMap:texture_2d<f32>;
fn floodSiltLoad(i:vec2i,n:vec2i)->f32{return textureLoad(floodSiltMap,clamp(i,vec2i(0),n-1),0).${channel};}
fn floodSiltAt(q:vec2f)->f32{
 if(floodSilt.size.x<=0.0||floodSilt.size.y<=0.0){return 0.0;}
 let n=vec2i(textureDimensions(floodSiltMap));let a=(q-floodSilt.origin)/floodSilt.size*vec2f(n)-0.5;
 if(any(a<vec2f(-0.5))||any(a>vec2f(n)-0.5)){return 0.0;}
 let f=floor(a);let t=a-f;let i=vec2i(f);
 return max(mix(mix(floodSiltLoad(i,n),floodSiltLoad(i+vec2i(1,0),n),t.x),mix(floodSiltLoad(i+vec2i(0,1),n),floodSiltLoad(i+vec2i(1,1),n),t.x),t.y),0.0);
}
`;
}

/** Patches the Water surface's fragment: the load's absorption, its brown back-scatter and beige foam. */
export function siltShader(code: string, binding: number, channel: 'x' | 'w' = 'w'): string {
  if (!code.includes(TRANSMISSION) || !code.includes(BODY) || !code.includes(FOAM))
    throw fault('failed', 'Flood sediment cannot find the Water surface shader; use matching water package versions');
  return code
    .replace('struct Result', declarations(binding, channel) + '\nstruct Result')
    .replace(
      TRANSMISSION,
      'let silt=floodSiltAt(i.world.xz);let transmission=exp(-(vec3f(0.38,0.10,0.045)+vec3f(1.4,1.3,1.5)*murk+silt*41.0*vec3f(0.07839,0.26818,0.91750))*optical);',
    )
    .replace(
      BODY,
      'let body=bottom*transmission+(frame.color.rgb+min(silt,50.0)*0.02*vec3f(0.55,0.42,0.3))*(vec3f(1)-transmission)',
    )
    .replace(FOAM, 'let foamAlbedo=mix(FOAM_ALBEDO,vec3f(0.62,0.55,0.45),1.0-exp(-silt*0.2));');
}
