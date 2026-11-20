// The page side of pixels.js: its functions' source as one script that render.mjs installs in the shot's page before
// the driver, so globalThis.__margoShotPixels holds them. The functions call only each other, so they work there as
// they do in Node (tests/shot-capture.test.js runs this script in a fresh context to prove it).
import * as pixels from './pixels.js';

/** The names of pixels.js's functions, in the order the script defines them. */
export const PIXEL_FUNCTIONS = Object.freeze(Object.keys(pixels).filter((name) => typeof pixels[name] === 'function'));

/** One script that sets globalThis.__margoShotPixels to pixels.js's functions. */
export function pixelScript() {
  return `globalThis.__margoShotPixels = (() => {\n${PIXEL_FUNCTIONS.map((name) => String(pixels[name])).join('\n')}\nreturn { ${PIXEL_FUNCTIONS.join(', ')} };\n})();`;
}
