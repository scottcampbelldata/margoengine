import { fixtureDocument } from '../../../tests/support/owner-dom.js';
import { lifetimeFault, ownedByEngine } from '../../../tests/support/owner-shell.js';

export async function fixtures(load = (entry) => import(entry)) {
  const { BehaviorTree, action } = await load('../dist/index.js');
  const { TreeInspector } = await load('../dist/inspect.js');
  const { TriggerSystem, sphereRegion } = await load('../dist/triggers.js');
  const tree = (signals = []) =>
    new BehaviorTree(action('wait'), {
      trace: true,
      handlers: {
        actions: {
          // Work that spans ticks and stops with its branch: it is handed a signal for exactly that.
          wait: ({ signal }) => {
            signals.push(signal);
            return new Promise(() => {});
          },
        },
      },
    });
  return [
    {
      name: 'BehaviorTree',
      create({ scene }) {
        const signals = [],
          running = tree(signals);
        running.tick(0.1);
        if (signals.length !== 1 || signals[0].aborted)
          lifetimeFault('a tree starts its async action with a live signal');
        return ownedByEngine(scene, 'BehaviorTree', () => running.dispose(), {
          check({ phase }) {
            if (phase === 'disposed' && !signals[0].aborted)
              lifetimeFault('a disposed tree leaves its running action a live signal');
          },
        });
      },
    },
    {
      // The panel mounts DOM, listens for clicks and runs on animation frames; an app signal outlives it.
      name: 'TreeInspector',
      async create({ scene }) {
        const { root, view, done } = await fixtureDocument(),
          controller = new AbortController();
        const panel = new TreeInspector(tree(), root, { signal: controller.signal });
        if (!root.contains(panel.element)) lifetimeFault('an inspector mounts its panel');
        return ownedByEngine(scene, 'TreeInspector', () => panel.dispose(), {
          cleanup() {
            if (root.contains(panel.element)) lifetimeFault('a disposed inspector leaves its panel mounted');
            done();
          },
        });
      },
    },
    {
      name: 'TriggerSystem',
      create({ scene }) {
        const system = new TriggerSystem('owner');
        system.set('zone', sphereRegion([0, 0, 0], 1));
        return ownedByEngine(scene, 'TriggerSystem', () => system.dispose(), {
          check({ phase }) {
            if (phase !== 'disposed') return;
            try {
              system.set('again', sphereRegion([0, 0, 0], 1));
            } catch (error) {
              if (error.code === 'disposed') return;
              throw error;
            }
            lifetimeFault('a disposed trigger system accepts regions');
          },
        });
      },
    },
  ];
}
