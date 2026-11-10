// Vite transforms source before serving it. There is no second HTTP request owned by a page route.
// Public API: https://vite.dev/guide/api-plugin.html#transform
const setup = `import { Engine as SpecCaptureEngine } from '/packages/core/dist/index.js';
if (!SpecCaptureEngine.specCapture) {
  const create = SpecCaptureEngine.create.bind(SpecCaptureEngine);
  SpecCaptureEngine.create = (canvas, options = {}) => create(canvas, { exactSize: [Math.round(canvas.clientWidth * devicePixelRatio), Math.round(canvas.clientHeight * devicePixelRatio)], ...options });
  SpecCaptureEngine.specCapture = true;
}\n`;

/** Apply the exact same pixel-capture policy to each demo on the server, before compilation. */
export function specCapturePlugin() {
  return {
    name: 'sciviz-spec-capture',
    enforce: 'pre',
    transform(code, id) {
      if (!/\/sciviz-[^/]+\.tsx?(?:\?|$)/.test(id.replaceAll('\\', '/'))) return null;
      return { code: setup + code, map: null };
    },
  };
}
