// The layer is hidden: the compositor still makes its uniform buffer, bind groups and layer texture and opens its pass
// in each view, but draws nothing. A visible layer draws a full-target triangle under the target's default viewport,
// clipped by a scissor narrower than the view's (the camera rectangle, for letterboxing): pixel-correct, since the
// shader reads the framebuffer position, but not the exact view viewport and scissor the harness requires of a draw.
const image = () => ({ width: 16, height: 8, data: new Uint8Array(16 * 8 * 4).fill(200) });

export async function fixtures(load = (entry) => import(entry)) {
  const { LayerCompositor } = await load('../dist/index.js');
  return [false, true].map((factory) => ({
    name: 'LayerCompositor' + (factory ? '.attach' : ''),
    create({ engine }) {
      const options = { camera: { width: 16, height: 8 }, name: 'owner-pixel' };
      const plugin = factory ? LayerCompositor.attach(engine, options) : new LayerCompositor(options);
      if (!factory) engine.use(plugin);
      const layer = plugin.addLayer({ anchor: 'world' });
      layer.write(image());
      layer.visible = false;
      return { plugin, dispose: () => plugin.dispose() };
    },
  }));
}
