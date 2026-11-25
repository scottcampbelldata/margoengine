// Lighting2D draws into a texture the app owns: one per device, so a restored device gets its own.
const USAGE = 0x10 | 0x01 | 0x04 | 0x02;

export async function fixtures(load = (entry) => import(entry)) {
  const { Lighting2D } = await load('../dist/index.js');
  return [false, true].map((factory) => ({
    name: 'Lighting2D' + (factory ? '.attach' : ''),
    create({ engine, dependency }) {
      const textures = new Map();
      const target = () => {
        const device = engine.gpu;
        if (!textures.has(device))
          textures.set(
            device,
            dependency(() => device.createTexture({ size: [32, 16], format: 'rgba8unorm', usage: USAGE })),
          );
        return textures.get(device);
      };
      const options = { target, ambient: '#000000', name: 'owner-lighting2d' };
      const plugin = factory ? Lighting2D.attach(engine, options) : new Lighting2D(options);
      if (!factory) engine.use(plugin);
      plugin.addLight({ x: 12.25, y: 7.75, radius: 20, falloff: 1.5, height: 6 });
      return {
        plugin,
        dispose: () => plugin.dispose(),
        cleanup() {
          for (const texture of textures.values()) texture.destroy();
        },
      };
    },
  }));
}
