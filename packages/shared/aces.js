// ACES fit by Stephen Hill; references and licenses in ../tonemap/NOTICE.md.
export const acesShader = `
fn aces(v:vec3f)->vec3f {
  let x=mat3x3f(vec3f(0.59719,0.07600,0.02840),vec3f(0.35458,0.90834,0.13383),vec3f(0.04823,0.01566,0.83777))*v;
  let fit=(x*(x+0.0245786)-0.000090537)/(x*(0.983729*x+0.4329510)+0.238081);
  return clamp(mat3x3f(vec3f(1.60475,-0.10208,-0.00327),vec3f(-0.53108,1.10813,-0.07276),vec3f(-0.07367,-0.00605,1.07602))*fit,vec3f(0),vec3f(1));
}`;
