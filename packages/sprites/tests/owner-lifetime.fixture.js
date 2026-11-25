const atlas = () => ({
  width: 2,
  height: 2,
  data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
});

export async function fixtures(load = (entry) => import(entry)) {
  const { SpriteLayer } = await load('../dist/index.js');
  return [false, true].map((factory) => ({
    name: 'SpriteLayer' + (factory ? '.attach' : ''),
    create({ engine }) {
      const options = { atlas: atlas(), name: 'owner-sprites' };
      const plugin = factory ? SpriteLayer.attach(engine, options) : new SpriteLayer(options);
      if (!factory) engine.use(plugin);
      plugin.add({ x: 10, y: 7, pivotX: 0.5, pivotY: 1, scaleX: 4, scaleY: 4 });
      return { plugin, dispose: () => plugin.dispose() };
    },
  }));
}
