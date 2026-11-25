// One title scene for tests/outline-node-gpu.mjs, drawn the same way in a page (outline-page.js, from src) and in Node
// (outline-scene.mts, from dist): a large title with an outline and a soft shadow, a kerned caption and small text.
// Classes come in as arguments so each side passes its own build.

/** The strings the scene draws, also the glyph set whose field bytes the two sides hash. */
export const SCENE_TEXTS = [
  'When It Forms',
  'Captions: AVATAR, To, Ta, Wave.',
  'small text keeps its counters 0123456789',
];
export const SCENE_SIZE = [640, 360];

/** Adds the scene to `engine` and returns its camera. */
export function buildScene(engine, { TextRenderer, Text, Camera }, font) {
  engine.scene.background = '#1d2733';
  const renderer = TextRenderer.attach(engine);
  renderer.add(
    new Text({
      text: SCENE_TEXTS[0],
      font,
      fontSize: 0.62,
      anchorX: 'center',
      anchorY: 'middle',
      position: [0, 0.55, 0],
      color: '#ffd84a',
      outlineWidth: 0.035,
      outlineColor: '#101010',
      shadowOpacity: 0.7,
      shadowBlur: 0.04,
      shadowOffset: [0.03, -0.03],
    }),
  );
  renderer.add(
    new Text({
      text: SCENE_TEXTS[1],
      font,
      fontSize: 0.17,
      anchorX: 'center',
      anchorY: 'middle',
      position: [0, -0.35, 0],
      color: '#ffffff',
      outlineWidth: 0.012,
      outlineColor: '#000000',
      shadowOpacity: 0.5,
      shadowBlur: 0.01,
      shadowOffset: [0.01, -0.01],
    }),
  );
  renderer.add(
    new Text({
      text: SCENE_TEXTS[2],
      font,
      fontSize: 0.075,
      anchorX: 'center',
      anchorY: 'middle',
      position: [0, -0.75, 0],
      color: '#c8d4dc',
    }),
  );
  return new Camera({ position: [0, 0, 3.2], target: [0, 0, 0] });
}

/** SHA-256 (hex) of every field the scene's texts need, in a fixed order; crypto.subtle exists in pages and Node. */
export async function fieldHash(font) {
  const parts = [];
  for (const text of SCENE_TEXTS)
    for (const char of new Set(text)) {
      const g = font.glyph(char);
      if (g) parts.push(new TextEncoder().encode(`${char}|${g.width}|${g.height}|${g.left}|${g.top}|`), g.data);
    }
  let length = 0;
  for (const p of parts) length += p.length;
  const all = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}
