import { FakeAudioContext } from './fake-web-audio.js';

export async function fixtures(load = (entry) => import(entry)) {
  const { AudioListener, PositionalAudio, Audio } = await load('../dist/index.js');
  const entries = [];
  for (const factory of [false, true]) for (const withSounds of [false, true])
    entries.push({ name: 'AudioListener' + (factory ? '.attach' : '') + (withSounds ? '.sounds' : ''),
      create({ engine }) {
        // The gesture listeners of autoResume go on the canvas document's window; the Node canvas has none.
        if (!engine.canvas.ownerDocument) engine.canvas.ownerDocument = { defaultView: new EventTarget() };
        const options = { context: new FakeAudioContext() };
        const plugin = factory ? AudioListener.attach(engine, options) : new AudioListener(options);
        if (withSounds) {
          const buffer = plugin.context.createBuffer(1, 8, 48000);
          new PositionalAudio(plugin).setBuffer(buffer).play();
          new Audio(plugin).setBuffer(buffer).play();
          plugin.follow(engine.createMesh());
        }
        return { plugin, dispose: () => plugin.dispose() };
      } });
  return entries;
}
