export async function fixtures(load = (entry) => import(entry)) {
  const { StencilBuffer } = await load('../dist/index.js');
  const { Transmission } = await load('../dist/transmission.js');
  const entries = [];
  const own = (name, make) => entries.push({ name, create({ engine }) {
    const plugin = make(engine);
    return { plugin, dispose: () => plugin.dispose() };
  } });
  own('StencilBuffer', () => new StencilBuffer());
  own('StencilBuffer.attach', (engine) => StencilBuffer.attach(engine));
  own('Transmission', () => new Transmission());
  own('Transmission.attach', (engine) => Transmission.attach(engine));
  return entries;
}
