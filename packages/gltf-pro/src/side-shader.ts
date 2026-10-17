// Keep front/double shader sources unchanged; only back-only draws need a reversed surface guard.
const cache = new Map<string, string>();
export function backSideShader(code: string): string {
  const previous = cache.get(code);
  if (previous) return previous;
  // An extension can prepend a facing helper before surface(), where the instance patch first matches.
  const scoped = code.includes('o.mirror=margoS;')
    ? code.replaceAll('let facing=front==(f.coordsB.y>0);', 'let facing=front==(i.mirror>0);')
    : code;
  let matches = 0;
  let result = scoped.replace(
    /if\((margoFaceTest&&)?!facing&&f\.settings\.z<0\.5\)/g,
    (_, test: string | undefined) => {
      matches++;
      return `if(${test ?? ''}facing)`;
    },
  );
  if (matches !== 1) throw new Error('Back-side material requires one PBR surface face guard');
  // Factor-only transmission tint never calls surface(). Mirrored instances disable raster culling,
  // so this frame-only entry needs its own guard without pulling texture bindings into its layout.
  const facing = scoped.match(/let facing=(front==[^;]+);/)?.[1];
  if (!facing) throw new Error('Back-side material requires the PBR logical facing expression');
  result = result.replace(
    '@fragment fn margoTint(i:Out)->@location(0) vec4f {return vec4f(f.coordsB.zw,f.ext.z,1);}',
    `@fragment fn margoTint(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {if(${facing}){discard;}return vec4f(f.coordsB.zw,f.ext.z,1);}`,
  );
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(code, result);
  return result;
}
