// Time to first frame. The startup scene (one lit box through the smallest app path, Margo: core + stage) in a fresh
// browser per run, cold HTTP and shader caches; loadMs runs from navigation start to the end of the first frame the
// GPU has finished. Then every site demo as a phone would load it (bench/lib/demo-loads.mjs: cache off, CPU and
// network throttled by LOAD_PROFILE, default phone-layout-cold), when site/dist is built (`npm run build:site`).
import { sceneCases } from '../lib/browser.mjs';
import { DEMOS, PROFILES, loadDemo, serveSite } from '../lib/demo-loads.mjs';

const ms = (primary = false) => ({ unit: 'ms', better: 'lower', primary });

export default {
  name: 'startup',
  title: 'Time to first frame: startup scene, site demos cold',
  uses: 'gpu',
  async cases(ctx) {
    const profileName = process.env.LOAD_PROFILE ?? 'phone-layout-cold',
      profile = PROFILES[profileName];
    if (!profile) throw new Error(`LOAD_PROFILE ${profileName}: one of ${Object.keys(PROFILES).join(', ')}`);
    let site;
    const demo = (path) => ({
      id: `demo-${path.split('/').filter(Boolean).at(-1).replace('.html', '')}`,
      title: `${path} cold, ${profileName}`,
      metrics: {
        firstFrameMs: ms(),
        readyMs: ms(),
        sceneReadyMs: ms(true),
        transferBytes: { unit: 'B', better: 'lower', exact: true },
      },
      async setup() {
        site ??= (await serveSite()) ?? false;
      },
      async run() {
        if (!site) return { unsupported: 'site/dist is not built (npm run build:site)' };
        const t = await loadDemo(site.origin, path, profile);
        return {
          values: {
            firstFrameMs: t.firstFrame,
            readyMs: t.ready,
            sceneReadyMs: t.principalScenePresentedOpportunity,
            transferBytes: t.transferBytes,
          },
          info: { profile: profileName },
        };
      },
    });
    const demos = DEMOS.map(demo);
    this.dispose = async () => {
      if (site) await site.close();
      site = undefined;
    };
    return [
      ...sceneCases('startup', {
        primary: ['loadMs'],
        keep: ['loadMs', 'firstFrameMs', 'createMs', 'jsBytes', 'cpuMs', 'gpuMs', 'jsHeapMB', 'gpuMB'],
      })(ctx),
      ...demos,
    ];
  },
};
