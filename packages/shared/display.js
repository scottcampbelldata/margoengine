// Margo's display transform. Khronos PBR Neutral tone mapping, written from the Khronos Group's published specification
// (2024): a colour passes through below 0.76 (less a small offset that keeps blacks black), its peak rolls off towards
// white above that, and saturation falls only as the peak does, so base colours under neutral light show as authored.
// Then the exact sRGB encoding (IEC 61966-2-1). Core keeps its own copy of the curve; every package that writes a lit
// colour to the screen ends with these, so a colour looks the same on a core mesh, a glTF model, terrain, sky, water,
// foliage and after any post effect.
export const neutralShader = `fn pbrNeutral(input:vec3f)->vec3f {let x=min(input.r,min(input.g,input.b));let offset=select(0.04,x-6.25*x*x,x<0.08);var v=input-offset;let peak=max(v.r,max(v.g,v.b));if(peak<0.76){return v;}let newPeak=1.0-0.24*0.24/(peak+0.24-0.76);v*=newPeak/peak;return mix(v,vec3f(newPeak),1.0-1.0/(0.15*(peak-newPeak)+1.0));}
`;
/** Same curve as {@link neutralShader} on the CPU (display-linear, before the sRGB encoding). Writes into `out` when given and returns it. */
export function pbrNeutral(c, out = [0, 0, 0]) {
  const x = Math.min(c[0], c[1], c[2]),
    offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  for (let i = 0; i < 3; i++) out[i] = c[i] - offset;
  const peak = Math.max(out[0], out[1], out[2]);
  if (peak < 0.76) return out;
  const newPeak = 1 - (0.24 * 0.24) / (peak + 0.24 - 0.76),
    keep = 1 / (0.15 * (peak - newPeak) + 1);
  for (let i = 0; i < 3; i++) out[i] = newPeak + (out[i] * (newPeak / peak) - newPeak) * keep;
  return out;
}
export const displayShader = `${neutralShader}fn toDisplay(c:vec3f)->vec3f {let x=pbrNeutral(max(c,vec3f(0)));return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308));}
`;

// Core's display transform at the end of its fragment shader (tone mapping and sRGB encoding).
const displayTail = /let mapped=pbrNeutral\([\s\S]*?return vec4f\([^\n]+\);/;

/**
 * Core's lighting shader `shader` returning linear HDR radiance instead of the display colour, for effects that capture
 * the scene before tone mapping (post, DOF, tonemap, creative, environment captures). Unchanged when the shader has no
 * core display transform (another plugin replaced it): throw MargoError 'unsupported' with {@link coreShaderRequired}.
 */
export const linearShader = (shader) => shader.replace(displayTail, 'return vec4f(linear,1);');
/** The message for an effect `owner` that found no core display transform to replace. */
export const coreShaderRequired = (owner) =>
  `${owner} requires the standard core lighting shader; remove the plugin that replaced core's shader`;

/** Marks a premultiplied canvas (`TransparentCanvas` of @margoengine/environment); shared through the symbol registry. */
const PREMULTIPLIED = Symbol.for('margoengine.premultiplied-canvas');
/** True when `engine` draws to a premultiplied canvas, so its display transforms must take straight colour. */
export const premultipliedCanvas = (engine) => !!engine?.canvas?.[PREMULTIPLIED];
// `vec4f(toDisplay(colour),alpha)`, the colour holding up to two levels of parentheses and the alpha a plain name.
const displayCall = /vec4f\(toDisplay\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\),([\w.]+)\)/g;
/**
 * The display shader `code` for a premultiplied canvas. A linear capture of a partly covered pixel holds colour times
 * coverage (T. Porter and T. Duff, "Compositing Digital Images", SIGGRAPH 1984,
 * https://graphics.pixar.com/library/Compositing/paper.pdf), and the curve and encoding of that product are brighter
 * than the product of the curve, a light rim on every silhouette. Each `vec4f(toDisplay(c),a)` becomes
 * `toDisplay(c/a)*a` for 0 < a < 1; covered and empty pixels are unchanged. Code may also call
 * `toDisplayStraight(c,a)` itself. Throws RangeError when `code` has no display output to convert.
 */
export function straightDisplay(code) {
  let outputs = 0;
  const out = code.replace(displayCall, (_, colour, alpha) => {
    outputs++;
    return `vec4f(toDisplayStraight(${colour},${alpha}),${alpha})`;
  });
  if (!outputs && !code.includes('toDisplayStraight('))
    throw new RangeError(
      'display shader has no vec4f(toDisplay(colour),alpha) output to convert; write the display output in that form or call toDisplayStraight(colour,alpha) itself',
    );
  return `${out}
fn toDisplayStraight(c:vec3f,a:f32)->vec3f {if(a>0.0&&a<1.0){return toDisplay(c/a)*a;}return toDisplay(c);}
`;
}
/** `code` as {@link straightDisplay} gives it when `engine` draws to a premultiplied canvas and `code` encodes for display. */
export const displayFor = (engine, code) =>
  premultipliedCanvas(engine) && code.includes('fn toDisplay(') ? straightDisplay(code) : code;
