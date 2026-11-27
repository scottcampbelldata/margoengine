// The straight-colour display rewrite for premultiplied canvases (KB-POST-ALPHARIM1), in a module of its own so a
// bundle that only reads the display curve (PostStack and every LDR effect that loads it) carries none of it: as part
// of display.js its chunk held these functions for every consumer of the curve (KB-SIZE-STRAIGHT1).
/** Marks a premultiplied canvas (`TransparentCanvas` of @margoengine/environment); shared through the symbol registry. */
const PREMULTIPLIED = Symbol.for('margoengine.premultiplied-canvas');
/** True when `engine` draws to a premultiplied canvas, so its display transforms must take straight colour. */
export const premultipliedCanvas = (engine) => !!engine?.canvas?.[PREMULTIPLIED];
/**
 * Marks `engine`'s output premultiplied (`on`) or not, for a pass that makes empty pixels alpha 0 (TransparentCanvas,
 * the eyes of an AR session), and returns the previous mark. Without a canvas it marks nothing and returns false.
 */
export function markPremultiplied(engine, on) {
  const canvas = engine?.canvas;
  if (!canvas) return false;
  const before = !!canvas[PREMULTIPLIED];
  canvas[PREMULTIPLIED] = on;
  return before;
}
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
