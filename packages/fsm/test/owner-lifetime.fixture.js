import { fixtureDocument } from '../../../tests/support/owner-dom.js';
import { lifetimeFault, ownedByEngine } from '../../../tests/support/owner-shell.js';

export async function fixtures(load = (entry) => import(entry)) {
  const { StateMachine } = await load('../dist/index.js');
  const { MachineTrace } = await load('../dist/trace.js');
  const { EventMachine, EventTrace } = await load('../dist/events.js');
  const { MachineView } = await load('../dist/inspect.js');
  const { InvokeMachine } = await load('../dist/invoke.js');
  const light = () => new StateMachine({ red: {}, green: {} }, 'red', {}, [{ from: 'red', to: 'green', event: 'go' }]);
  return [
    {
      // A trace takes the machine's single listener slot, and must give it back.
      name: 'MachineTrace',
      create({ scene }) {
        const machine = light(), trace = new MachineTrace(machine);
        if (!machine.listener) lifetimeFault('a trace listens to its machine');
        return ownedByEngine(scene, 'MachineTrace', () => {
          trace.dispose();
          if (machine.listener) lifetimeFault('a disposed trace leaves its listener on the machine');
        });
      },
    },
    {
      name: 'EventTrace',
      create({ scene }) {
        const machine = new EventMachine({ red: {}, green: {} }, 'red', {}, [{ from: 'red', to: 'green', event: 'go' }]);
        const trace = new EventTrace(machine);
        return ownedByEngine(scene, 'EventTrace', () => {
          trace.dispose();
          if (machine.listener) lifetimeFault('a disposed event trace leaves its listener on the machine');
        });
      },
    },
    {
      // The overlay mounts DOM, runs on animation frames, traces its machine and listens on an app signal.
      name: 'MachineView',
      async create({ scene }) {
        const { root, done } = await fixtureDocument(), machine = light(), controller = new AbortController();
        const view = new MachineView(machine, { parent: root, signal: controller.signal });
        if (!root.contains(view.element)) lifetimeFault('a machine view mounts its overlay');
        return ownedByEngine(scene, 'MachineView', () => {
          view.dispose();
          if (machine.listener) lifetimeFault('a disposed machine view leaves its trace on the machine');
        }, { cleanup() {
          if (root.contains(view.element)) lifetimeFault('a disposed machine view leaves its overlay mounted');
          done();
        } });
      },
    },
    {
      // A service still running when the machine goes: its signal must abort, and the app's signal listener go.
      name: 'InvokeMachine',
      create({ scene }) {
        const controller = new AbortController(), signals = [];
        const machine = new InvokeMachine({ busy: { invoke: { id: 'work', run: (_c, signal) => { signals.push(signal); return new Promise(() => {}); } } } },
          'busy', {}, [], { signal: controller.signal });
        if (signals.length !== 1 || signals[0].aborted) lifetimeFault('a machine starts its service with a live signal');
        return ownedByEngine(scene, 'InvokeMachine', () => machine.dispose(), { check({ phase }) {
          if (phase === 'disposed' && !signals[0].aborted) lifetimeFault('a disposed machine leaves its running service a live signal');
        } });
      },
    },
  ];
}
