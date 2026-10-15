// AgX display transform (Troy Sobotka's AgX; the Rec.2020 inset/outset of Blender's AgX view, Eary Chow), linear Rec.709 in,
// linear Rec.709 display out: Rec.709 to Rec.2020 (ITU-R primaries, D65) and the AgX inset as one matrix; log2 encoding of
// middle grey 0.18 from -10 to +6.5 stops; Benjamin Wrensch's polynomial fit of the default-contrast curve (Horner form);
// the AgX outset; the 2.2 display power back to linear; Rec.2020 to Rec.709. packages/tonemap/tests/agx.test.js re-derives
// every matrix from its primary source; sources in ../tonemap/NOTICE.md.
export const agxShader = `
fn agx(v:vec3f)->vec3f {
  let inset=mat3x3f(vec3f(0.5448147,0.1404169,0.08881042),vec3f(0.3737874,0.7541376,0.1788718),vec3f(0.08139786,0.1054455,0.7323178))*v;
  let x=clamp((log2(max(inset,vec3f(1e-10)))+12.47393)/16.5,vec3f(0),vec3f(1));
  // shortcut: polynomial fit of the AgX curve; Blender's OCIO LUT gives exact view-transform parity.
  let curve=((((((15.5*x-40.14)*x+31.96)*x-6.868)*x+0.4298)*x+0.1191)*x-0.00232);
  let outset=pow(max(mat3x3f(vec3f(1.127101,-0.1413298,-0.1413298),vec3f(-0.1106066,1.157824,-0.1106066),vec3f(-0.01649393,-0.01649393,1.251936))*curve,vec3f(0)),vec3f(2.2));
  return clamp(mat3x3f(vec3f(1.660491,-0.1245505,-0.01815076),vec3f(-0.5876411,1.1329,-0.1005789),vec3f(-0.07284986,-0.008349423,1.11873))*outset,vec3f(0),vec3f(1));
}`;
