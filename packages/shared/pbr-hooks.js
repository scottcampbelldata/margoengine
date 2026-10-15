// gltf-pro's lighting hook composer (its README "Lighting hooks"), shared with VAT crowds whose lit fragment keeps the
// same hook points: `direct+ambient(s)`, `var color=`, `fn ambient(s:Surface)`, `+s.emissive;` and the tone-map line.
const lit=new WeakMap();
/** `code` (a PBR fragment with gltf-pro's hook points, possibly already lit) with one effect's hooks composed in. */
export function lightPBR(code,hooks){
  let cache=lit.get(hooks),out=cache?.get(code);if(out!==undefined)return out;out=code;
  const edit=(from,to)=>{const next=out.replace(from,to);if(next===out)throw new Error('PBR lighting hook point missing or used twice: '+from);out=next;};
  if(hooks.direct)edit('direct+ambient(s)',hooks.direct('direct')+'+ambient(s)');
  if(hooks.light)edit('var color=','var color='+hooks.light+'+');
  if(hooks.ambient){edit(/fn ambient\(s:Surface\)->vec3f \{[^}]*\}/,'fn ambient(s:Surface)->vec3f {return vec3f(0);}');edit(/var color=([^;]+)\+s\.emissive;/,(_,terms)=>`let margoAmbient=${hooks.ambient};var color=${terms}+s.emissive+margoAmbient;`);}
  if(hooks.output)edit('if(f.settings.w<0.5) {color=aces(max(color,vec3f(0))/0.6);',`color=${hooks.output('select(color,aces(max(color,vec3f(0))/0.6),f.settings.w<0.5)')};if(f.settings.w<0.5) {`);
  out=hooks.declarations+out;if(!cache)lit.set(hooks,cache=new Map());if(cache.size>=64)cache.clear();cache.set(code,out);return out;
}
