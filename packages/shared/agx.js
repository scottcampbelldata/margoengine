// AgX transform adapted from Three.js (MIT); see ../tonemap/NOTICE.md.
export const agxShader = `
fn agx(v:vec3f)->vec3f {
  let rec2020=mat3x3f(vec3f(0.6274,0.0691,0.0164),vec3f(0.3293,0.9195,0.0880),vec3f(0.0433,0.0113,0.8956))*v;
  let inset=mat3x3f(vec3f(0.8566271533,0.1373189729,0.1118982130),vec3f(0.0951212405,0.7612419906,0.0767994186),vec3f(0.0482516061,0.1014390365,0.8113023684))*rec2020;
  let x=clamp((log2(max(inset,vec3f(1e-10)))+12.47393)/16.5,vec3f(0),vec3f(1));let x2=x*x;let x4=x2*x2;
  // shortcut: analytic AgX sigmoid fit, use Blender's OCIO LUT for exact view-transform parity.
  let sigmoid=15.5*x4*x2-40.14*x4*x+31.96*x4-6.868*x2*x+0.4298*x2+0.1191*x-0.00232;
  let outset=mat3x3f(vec3f(1.1271005818,-0.1413297635,-0.1413297635),vec3f(-0.1106066431,1.1578237022,-0.1106066431),vec3f(-0.0164939387,-0.0164939387,1.2519364066))*sigmoid;
  let linear=pow(max(outset,vec3f(0)),vec3f(2.2));
  return clamp(mat3x3f(vec3f(1.6605,-0.1246,-0.0182),vec3f(-0.5876,1.1329,-0.1006),vec3f(-0.0728,-0.0083,1.1187))*linear,vec3f(0),vec3f(1));
}`;
