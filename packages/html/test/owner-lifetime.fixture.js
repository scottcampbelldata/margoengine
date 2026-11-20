// Owner/lifetime fixture of @margoengine/html: the DOM overlay (HTML, with its scene-depth occlusion and fade), the
// blended overlay (HTMLBlend), elements drawn as textures on quads (HTMLTexture, HTMLTextureGL) and a texture whose
// elements are prepared by the resource inliner (inline). Each is attached, drawn and disposed: every listener on the
// document, the canvas and the elements, every GPU resource, the overlay roots and surface holders it put in the page
// and the canvas style it changed must be gone, and nothing may reach engine.onError on the way.
//
// On the CPU there is no page: one jsdom document stands in for it, and the harness's canvas is given it as its
// ownerDocument, as a canvas in that page would be. jsdom draws nothing (no 2D canvas, no image decoding), so there a
// texture's elements are prepared by a preparation that holds until the surface is removed: what the CPU proves is that
// disposal aborts a raster still in flight (the removal signal) and leaves nothing behind. The browser leaf draws the
// elements for real, through the browser's own rasterizer.
let dom = null;
async function page() {
  if (globalThis.document?.body) return null;
  if (!dom) {
    const name = 'jsdom';
    const { JSDOM } = await import(/* @vite-ignore */ name);
    dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
    // jsdom's selector engines (one for queries, one for style resolution) listen on the document (mouseover and
    // mouseout, for :hover) from their first use: the page's, made here, not an owner's (the inliner resolves styles).
    dom.window.document.querySelector('body');
    dom.window.getComputedStyle(dom.window.document.body);
  }
  return dom.window;
}

const panel = (doc, text) => {
  const element = doc.createElement('div');
  element.style.cssText = 'width:64px;height:32px;background:#08f;color:#fff;font:12px sans-serif';
  element.textContent = text;
  return element;
};
// The CPU's preparation: the inliner's (or a plain) copy, then a wait that ends only when the surface is removed.
const held = (inner) => async (element, signal) => {
  const copy = inner ? await inner(element, signal) : element.cloneNode(true);
  await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  return copy;
};

export async function fixtures(load = (entry) => import(entry)) {
  const window = await page();
  const { HTML } = await load('../dist/index.js');
  const { HTMLBlend } = await load('../dist/blend.js');
  const { HTMLTexture } = await load('../dist/texture.js');
  const { HTMLTextureGL } = await load('../dist/texture-gl.js');
  const { resourceInliner } = await load('../dist/inline.js');
  // Shared by every entry: the page's document, the elements given to the plugin and the checks on disposal.
  const own = (name, make, extra = {}) => ({
    name,
    eventTargets: () => (window ? [window.EventTarget.prototype] : []),
    ...extra,
    create({ engine }) {
      if (window) engine.canvas.ownerDocument = window.document;
      const doc = engine.canvas.ownerDocument,
        errors = [],
        onError = engine.onError,
        style = ['position', 'zIndex', 'pointerEvents'].map((key) => engine.canvas.style[key]);
      engine.onError = (error) => errors.push(error);
      const { plugin, elements, nodes = () => [] } = make(engine, doc);
      const missing = [...elements, ...nodes()].filter((node) => !node.isConnected);
      if (missing.length) throw new Error(`OWNER_LIFETIME: ${name} put ${missing.length} node(s) off the page`);
      const reported = () => {
        if (errors.length) throw new Error(`OWNER_LIFETIME: ${name} reported ${errors[0]?.message ?? errors[0]}`);
      };
      return {
        plugin,
        dispose: () => plugin.dispose(),
        check({ phase }) {
          reported();
          // The harness also draws after a disposal (a stale disposal must not come back): only 'disposed' checks the page.
          if (phase !== 'disposed') return;
          const left = [...elements, ...nodes()].filter((node) => node.isConnected);
          if (left.length) throw new Error(`OWNER_LIFETIME: ${name} leaves ${left.length} node(s) in the page`);
          const now = ['position', 'zIndex', 'pointerEvents'].map((key) => engine.canvas.style[key]);
          if (now.some((value, i) => value !== style[i]))
            throw new Error(`OWNER_LIFETIME: ${name} leaves the canvas style changed: ${now.join(', ')}`);
        },
        cleanup() {
          engine.onError = onError;
        },
      };
    },
  });
  const overlay = (Kind, options) => (engine, doc) => {
    const plugin = new Kind(options),
      label = panel(doc, 'label'),
      object = panel(doc, 'object');
    plugin.add(label, { position: [0, 0.5, 0] });
    plugin.add3D(object, { position: [0, 0, 0] });
    engine.use(plugin);
    return { plugin, elements: [label, object], nodes: () => (plugin.root ? [plugin.root] : []) };
  };
  const textures = (Kind, prepare) => (engine, doc) => {
    const plugin = Kind.attach(engine, { rasterizer: 'foreign-object', prepare: window ? held(prepare) : prepare }),
      element = panel(doc, 'surface'),
      surface = plugin.add(element, { width: 1, height: 0.5, pixelRatio: 1 });
    return { plugin, elements: [element], nodes: () => [surface.holder] };
  };
  return [
    own('HTML', overlay(HTML, { fade: { duration: 0.2 } })),
    own('HTML.attach', (engine, doc) => {
      const plugin = HTML.attach(engine),
        label = panel(doc, 'label');
      plugin.add(label, { position: [0, 0, 0] });
      return { plugin, elements: [label], nodes: () => (plugin.root ? [plugin.root] : []) };
    }),
    own('HTMLBlend', overlay(HTMLBlend, {})),
    own('HTMLTexture', textures(HTMLTexture)),
    own('HTMLTextureGL', textures(HTMLTextureGL)),
    own('inline', textures(HTMLTexture, resourceInliner())),
  ];
}
