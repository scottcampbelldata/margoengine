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
// Keep the miss-only replacement closures outside the hot cache lookup's function context.
function composeLightPBR(code, hooks, cache) {
  let out = code;
  const edit = (from, to) => {
    const next = out.replace(from, to);
    if (next === out)
      throw margoError(
        'unsupported',
        `PBR lighting hook point missing or used twice: ${from}; use matching @margoengine/gltf-pro and effect package versions`,
      );
    out = next;
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
      out += `\nfn margoLocal${n}(i:Out,s:Surface,v:vec3f)->vec3f {return ${hooks.light};}\n`;
    } else edit('var color=', 'var color=' + hooks.light + '+');
  }
  if (hooks.ambient) {
    edit(/fn ambient\(s:Surface\)->vec3f \{[^}]*\}/, 'fn ambient(s:Surface)->vec3f {return vec3f(0);}');
    if (layered)
      edit(
        'fn margoAmbientTerm(i:Out,s:Surface,v:vec3f)->vec3f {return vec3f(0);}',
        () => `fn margoAmbientTerm(i:Out,s:Surface,v:vec3f)->vec3f {return ${hooks.ambient};}`,
      );
    edit(
      /var color=([^;]+)\+s\.emissive;/,
      (_, terms) =>
        `let margoAmbient=${layered ? 'margoAmbientLayers(i,s,v)' : hooks.ambient};var color=${terms}+s.emissive+margoAmbient;`,
    );
  }
  if (hooks.output)
    edit(
      'if(f.settings.w<0.5) {color=aces(max(color,vec3f(0))/0.6);',
      `color=${hooks.output('select(color,aces(max(color,vec3f(0))/0.6),f.settings.w<0.5)')};if(f.settings.w<0.5) {`,
    );
  out = hooks.declarations + out;
  if (!cache) lit.set(hooks, (cache = new Map()));
  if (cache.size >= 64) cache.clear();
  cache.set(code, out);
  return out;
}
