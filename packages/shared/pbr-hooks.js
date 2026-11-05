// gltf-pro's lighting hook composer (its README "Lighting hooks"), shared with VAT crowds whose lit fragment keeps the
// same hook points: `direct+ambient(s)`, `var color=`, `fn ambient(s:Surface)`, `+s.emissive;` and the tone-map line.
import { margoError } from './errors.js';
const lit = new WeakMap();
/** `code` (a PBR fragment with gltf-pro's hook points, possibly already lit) with one effect's hooks composed in. */
export function lightPBR(code, hooks) {
  const cache = lit.get(hooks),
    out = cache?.get(code);
  if (out !== undefined) return out;
  return composeLightPBR(code, hooks, cache);
}
// gltf-pro's built-in sky light, a fixed gradient times the ambient strength f.radiance.w, wherever a shader writes it (the
// hemisphere ambient, the clearcoat and sheen defaults, a light probe's fallback; also in materials' and VAT's shaders).
// The gradient (ground (0.35, 0.3, 0.25) to sky 1) and the f0 x 0.5 ambient specular are Margo design choices.
const gradient = /mix\(vec3f\(0\.35,0\.3,0\.25\),vec3f\(1(?:\.0)?\),clamp\(([\w.]+)\.y\*0\.5\+0\.5,0\.0,1\.0\)\)/g;
/** `text` with the built-in sky gradient replaced by the `sky` hook (margoSkyHook) and its strength (`*f.radiance.w`) dropped. */
const skyText = (text) => text.replace(gradient, 'margoSkyHook($1)').replaceAll('*f.radiance.w', '');
const hasGradient = (text) => text !== undefined && new RegExp(gradient.source).test(text);
// Keep the miss-only replacement closures outside the hot cache lookup's function context.
function composeLightPBR(code, hooks, cache) {
  // Hooks read the dielectric Fresnel ends as s.f0 and s.sw. A Surface without those fields has the glTF defaults.
  const dielectric = (text) =>
    text &&
    (code.includes(' f0:vec3f') ? text : text.replaceAll('s.f0', 'vec3f(0.04)')).replaceAll(
      's.sw',
      code.includes(' sw:f32') ? 's.sw' : '1.0',
    );
  let out = code;
  // A hook may return its anchor unchanged, so a miss is tested on the anchor, not on the result.
  const edit = (from, to) => {
    if (typeof from === 'string' ? !out.includes(from) : out.search(from) < 0)
      throw margoError(
        'unsupported',
        `PBR lighting hook point missing: ${from}; use matching @margoengine/gltf-pro and effect package versions`,
      );
    out = out.replace(from, to);
  };
  // gltf-pro's transmissive and extended shaders (they define margoAmbientLayers) evaluate light and ambient hooks as
  // functions of the surface: local lights see the diffuse left after transmission (margoFront), the ambient hook is
  // layered by margoAmbientLayers (thin film, diffuse transmission, bent normal).
  const layered = code.includes('fn margoAmbientLayers(');
  if (hooks.direct) edit('direct+ambient(s)', hooks.direct('direct') + '+ambient(s)');
  if (hooks.light) {
    if (layered) {
      const n = out.split('fn margoLocal').length - 1;
      edit('var color=', `var color=margoLocal${n}(i,margoFront(s),v)+`);
      out += `\nfn margoLocal${n}(i:Out,s:Surface,v:vec3f)->vec3f {return ${dielectric(hooks.light)};}\n`;
    } else edit('var color=', 'var color=' + dielectric(hooks.light) + '+');
  }
  // A sky hook composed before: an ambient hook that falls back to the built-in sky (light probes) uses the hook's sky
  // there; one that does not (image-based light) leaves the sky ambient in place, so the two add.
  const sky = out.includes('fn margoSkyHook(');
  if (hooks.ambient) {
    if (!sky || hasGradient(hooks.ambient))
      edit(/fn ambient\(s:Surface\)->vec3f \{[^}]*\}/, 'fn ambient(s:Surface)->vec3f {return vec3f(0);}');
    if (layered)
      edit(
        'fn margoAmbientTerm(i:Out,s:Surface,v:vec3f)->vec3f {return vec3f(0);}',
        () => `fn margoAmbientTerm(i:Out,s:Surface,v:vec3f)->vec3f {return ${dielectric(hooks.ambient)};}`,
      );
    edit(
      /var color=([^;]+)\+s\.emissive;/,
      (_, terms) =>
        `let margoAmbient=${layered ? 'margoAmbientLayers(i,s,v)' : dielectric(hooks.ambient)};var color=${terms}+s.emissive+margoAmbient;`,
    );
  }
  // Physical materials (gltf-pro's layers) light their clearcoat and sheen through these two functions.
  for (const [name, expression] of [
    ['margoCoatAmbient', hooks.coat],
    ['margoSheenAmbient', hooks.sheen],
  ])
    if (expression && out.includes(`fn ${name}(`))
      edit(
        new RegExp(`fn ${name}\\(s:Surface,v:vec3f\\)->vec3f \\{return [^;]*;\\}`),
        () => `fn ${name}(s:Surface,v:vec3f)->vec3f {return ${expression};}`,
      );
  if (hooks.sky) {
    if (sky)
      throw margoError('unsupported', 'Two sky lighting hooks on one shader; attach one HemisphereLight per engine');
    // An ambient hook composed before replaced the sky ambient: unless it falls back to the sky itself, bring it back.
    const ambient = /let margoAmbient=([^;]*);/.exec(out)?.[1],
      term = /fn margoAmbientTerm\(i:Out,s:Surface,v:vec3f\)->vec3f \{return ([^;]*);\}/.exec(out)?.[1];
    if (ambient !== undefined && !hasGradient(ambient) && !hasGradient(term))
      edit(
        'fn ambient(s:Surface)->vec3f {return vec3f(0);}',
        `fn ambient(s:Surface)->vec3f {${
          out.includes('fn margoHemisphere(')
            ? 'return margoHemisphere(s);'
            : out.includes('fn hemisphere_ambient(')
              ? 'return hemisphere_ambient(s);'
              : // VAT crowds write their hemisphere ambient inline: the same terms as gltf-pro's.
                'let f0=mix(vec3f(0.04),s.base.rgb,s.metal);return (s.base.rgb*(1.0-s.metal)+f0*0.5)*margoSkyHook(s.n)*s.occlusion;'
        }}`,
      );
    out += `
fn margoSkyHook(n:vec3f)->vec3f {return ${hooks.sky};}
`;
  }
  if (hooks.sky || sky) out = skyText(out);
  // The output hook wraps the tone-mapped colour; the sRGB encoding stays after it. Shaders end either with gltf-pro's
  // inline tone-map line or with shared/display.js toDisplay (voxels).
  const shared = 'if(f.settings.w<0.5) {color=toDisplay(color);}',
    srgb = 'select(color*12.92,1.055*pow(color,vec3f(1.0/2.4))-0.055,color>=vec3f(0.0031308))';
  if (hooks.output) {
    const display = out.includes(shared);
    edit(
      display ? shared : 'if(f.settings.w<0.5) {color=pbrNeutral(max(color,vec3f(0)));',
      `color=${hooks.output('select(color,pbrNeutral(max(color,vec3f(0))),f.settings.w<0.5)')};if(f.settings.w<0.5) {${
        display ? `color=${srgb};}` : ''
      }`,
    );
  }
  out = hooks.declarations + out;
  if (!cache) lit.set(hooks, (cache = new Map()));
  if (cache.size >= 64) cache.clear();
  cache.set(code, out);
  return out;
}
