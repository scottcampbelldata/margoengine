import { invariant } from '../../../tests/support/owner-lifetime.js';
export async function fixtures(load = (entry) => import(entry)) {
  const { Video } = await load('../dist/index.js');
  return [{
    name: 'Video', viewDraws: true, visible: true,
    create({ host }) {
      const frame = host.frame(), plugin = new Video(frame);
      return { plugin, dispose: () => plugin.dispose(), cleanup: () => frame.close(),
        check() { invariant(frame.displayWidth === 8, 'caller-owned VideoFrame stays alive'); } };
    },
  }];
}
