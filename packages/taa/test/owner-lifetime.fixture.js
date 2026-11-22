// TAAUpscale is not here: it draws one full-canvas view and throws on the shared harness's two views by design
// (its README); its scene detach is covered by test/scene-owner.test.js.
export async function fixtures(load = (entry) => import(entry)) {
  const { TAA } = await load('../dist/index.js');
  const entries = [];
  const own = (name, make) =>
    entries.push({
      name,
      create({ engine }) {
        const plugin = make(engine);
        return { plugin, dispose: () => plugin.dispose() };
      },
    });
  own('TAA', () => new TAA({ historyWeight: 0.9 }));
  return entries;
}
