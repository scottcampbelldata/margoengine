import {
  bindSurfaceEnergy,
  controlSlots as slots,
  type SurfaceEnergyWorkerStart,
} from './surface-energy-native-core.js';

function run(start: SurfaceEnergyWorkerStart, reply: (result: string) => void): void {
  const control = new Int32Array(start.memory.buffer, 0, slots.status + start.parts - 1);
  let apply: ReturnType<typeof bindSurfaceEnergy>;
  try {
    apply = bindSurfaceEnergy(start);
  } catch {
    reply('fault');
    return;
  }
  let seen = Atomics.load(control, slots.generation);
  reply('ready');
  for (;;) {
    Atomics.wait(control, slots.generation, seen);
    const next = Atomics.load(control, slots.generation);
    if (seen === next) continue;
    seen = next;
    try {
      const status = apply(
        Atomics.load(control, slots.input),
        Atomics.load(control, slots.output),
        Atomics.load(control, slots.receipts),
        Atomics.load(control, slots.rows),
        start.part,
        start.parts,
      );
      Atomics.store(control, slots.status + start.part - 1, status);
    } catch {
      Atomics.store(control, slots.fault, 1);
      Atomics.add(control, slots.done, 1);
      Atomics.notify(control, slots.done);
      return;
    }
    Atomics.add(control, slots.done, 1);
    Atomics.notify(control, slots.done);
  }
}

const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;
if (typeof node === 'string') {
  const name = 'node:worker_threads';
  type Parent = {
    once(event: 'message', receive: (start: SurfaceEnergyWorkerStart) => void): void;
    postMessage(value: string): void;
  };
  void (import(/* @vite-ignore */ /* webpackIgnore: true */ name) as Promise<{ parentPort: Parent }>).then(
    ({ parentPort }) => parentPort.once('message', (start) => run(start, (result) => parentPort.postMessage(result))),
  );
} else {
  const scope = globalThis as unknown as {
    onmessage: (event: MessageEvent<SurfaceEnergyWorkerStart>) => void;
    postMessage(value: string): void;
  };
  scope.onmessage = ({ data }) => run(data, (result) => scope.postMessage(result));
}
