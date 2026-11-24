// A stand-in font: the node adapter has no rasterizer, so glyph shapes are absent and only registration, atlas and
// block resources are exercised.
export async function fixtures(load = (entry) => import(entry)) {
  const { Text, Font, TextRenderer } = await load('../dist/index.js');
  const font = () => Object.assign(Object.create(Font.prototype), {
    revision: 0, glyph: () => undefined, advance: (s) => s.length * 0.5, kerning: () => 0, metrics: () => ({ ascent: 0.8, descent: 0.2 }),
  });
  const entries = [];
  for (const factory of [false, true]) {
    entries.push({ name: 'TextRenderer' + (factory ? '.attach' : ''), visible: false, create({ engine }) {
      const plugin = factory ? TextRenderer.attach(engine) : new TextRenderer();
      plugin.add(new Text({ text: 'abc', font: font() }));
      return { plugin, dispose: () => plugin.dispose() };
    } });
  }
  return entries;
}
