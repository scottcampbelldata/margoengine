// The inverse of Margo's display curve (./display.js), apart from it so only its user (gltf's screen-space transmission)
// carries it: its constants are computed when the module loads, which a bundler keeps in every importer of a module.
/**
 * The inverse of {@link pbrNeutral} (display-linear back to scene light), derived from the curve's three steps: the
 * peak roll-off solved for the peak (newPeak = 1 - 0.24^2/(peak - 0.52)) and the desaturation mix undone with that
 * peak's weight, then the black offset undone (below 0.04 the shifted minimum is 6.25 x^2). Exact for every value the
 * curve can output; a value at 1 or above (display white, which no finite light reaches) takes `white`, the least light
 * whose curve and 8-bit sRGB encoding round to 255 (about 13.49, {@link neutralWhite}). KB4000: gltf's screen-space transmission
 * reads a display-encoded scene with it.
 */
export function pbrNeutralInverse(c, out = [0, 0, 0], white = neutralWhite) {
  // The curve's grey input g has peak g - 0.04 after the black offset.
  const top = 1 - (0.24 * 0.24) / (white - 0.56);
  let peak = Math.max(c[0], c[1], c[2]);
  const scale = peak > top ? top / peak : 1;
  for (let i = 0; i < 3; i++) out[i] = Math.max(c[i] * scale, 0);
  peak = Math.min(peak, top);
  if (peak >= 0.76) {
    const old = 0.52 + (0.24 * 0.24) / (1 - peak),
      keep = 1 / (0.15 * (old - peak) + 1);
    for (let i = 0; i < 3; i++) out[i] = (((out[i] - peak * (1 - keep)) / keep) * old) / peak;
  }
  const m = Math.min(out[0], out[1], out[2]),
    offset = m < 0.04 ? 0.4 * Math.sqrt(Math.max(m, 0)) - m : 0.04;
  for (let i = 0; i < 3; i++) out[i] += offset;
  return out;
}
// The display-linear value that encodes to 254.5 / 255: the curve outputs above it show as 8-bit white.
const displayTop = ((254.5 / 255 + 0.055) / 1.055) ** 2.4;
/** The least grey scene light that {@link displayShader} writes as 8-bit white (about 13.49). */
export const neutralWhite = 0.56 + (0.24 * 0.24) / (1 - displayTop);
/** WGSL `pbrNeutralInverse(display-linear) -> scene light`, the twin of {@link pbrNeutralInverse} with `white` = {@link neutralWhite}. */
export const neutralInverseShader = `fn pbrNeutralInverse(input:vec3f)->vec3f {let top=${displayTop};var peak=max(input.r,max(input.g,input.b));var v=max(input*select(1.0,top/peak,peak>top),vec3f(0.0));peak=min(peak,top);if(peak>=0.76){let old=0.52+0.24*0.24/(1.0-peak);let keep=1.0/(0.15*(old-peak)+1.0);v=(v-peak*(1.0-keep))/keep*old/peak;}let m=min(v.r,min(v.g,v.b));return v+select(0.04,0.4*sqrt(max(m,0.0))-m,m<0.04);}
`;
