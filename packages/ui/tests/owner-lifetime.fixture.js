// The node adapter's canvas is an EventTarget without attributes, so the DOM accessibility mirror (needs a document) is
// off here; pointer, touch, wheel and keyboard listeners on the canvas are still attached and checked.
const measurer = { advance: () => 0.5, kerning: () => 0, metrics: () => ({ ascent: 0.8, descent: 0.2 }) };

export async function fixtures(load = (entry) => import(entry)) {
  const { Ui, UiRenderer, Panel } = await load('../dist/index.js');
  const { WorldPanel, WorldPanels } = await load('../dist/world.js');
  const { GlWorldPanels } = await load('../dist/world-gl.js');
  const { CurvedPanel } = await load('../dist/curved.js');
  const ui = () => {
    const value = new Ui({ width: 64, height: 32, measurer, reducedMotion: true, safeArea: [0, 0, 0, 0] });
    // No text: glyph rasterization needs a canvas the node adapter does not have.
    value.add(new Panel());
    return value;
  };
  const entries = [];
  for (const factory of [false, true]) {
    const suffix = factory ? '.attach' : '';
    entries.push({ name: 'UiRenderer' + suffix, create({ engine }) {
      const plugin = factory ? UiRenderer.attach(engine, ui(), { mirror: false }) : new UiRenderer(ui(), { mirror: false });
      return { plugin, dispose: () => plugin.dispose() };
    } });
    for (const [name, Plugin] of Object.entries({ WorldPanels, GlWorldPanels })) {
      entries.push({ name: name + suffix, create({ engine }) {
        const plugin = factory ? Plugin.attach(engine) : new Plugin();
        plugin.add(new WorldPanel(ui(), { width: 1, height: 0.5, position: [0, 0, -2] }));
        return { plugin, dispose: () => plugin.dispose() };
      } });
    }
  }
  entries.push({ name: 'WorldPanels.curved', create({ engine }) {
    const plugin = WorldPanels.attach(engine);
    plugin.add(new CurvedPanel(ui(), { width: 1, height: 0.5, position: [0, 0, -2] }));
    return { plugin, dispose: () => plugin.dispose() };
  } });
  return entries;
}
