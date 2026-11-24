// The node adapter has no document: Stats gets a stand-in parent there, the real page body in a browser.
const element = () => ({ dataset: {}, style: {}, setAttribute() {}, getContext: () => null, append() {}, remove() {} });
const parent = () => globalThis.document?.body ?? { ownerDocument: { createElement: element }, append() {} };

export async function fixtures(load = (entry) => import(entry)) {
  const { Stats } = await load('../dist/index.js');
  const { FrameBeacon } = await load('../dist/beacon.js');
  const { PipelineCompiles } = await load('../dist/compile.js');
  const { FramePhases } = await load('../dist/phases.js');
  const entries = [];
  const own = (name, make) => entries.push({ name, create({ engine }) {
    const plugin = make(engine);
    return { plugin, dispose: () => plugin.dispose() };
  } });
  own('Stats', () => new Stats({ parent: parent() }));
  own('Stats.attach', (engine) => Stats.attach(engine, { parent: parent() }));
  // Never reaches its frame minimum, so it sends nothing.
  own('FrameBeacon', () => new FrameBeacon({ endpoint: 'http://127.0.0.1:9/beacon', intervalMilliseconds: 0, minFrames: 1e9 }));
  own('PipelineCompiles', () => new PipelineCompiles());
  own('FramePhases', () => new FramePhases());
  return entries;
}
