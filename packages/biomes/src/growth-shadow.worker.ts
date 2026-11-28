import { growthControl as slots, type GrowthWorkerJob } from './growth-shadow-protocol.js';

type Phase = (job: number, part: number, parts: number) => number;

function run({ module, memory, job, control: address, stackTop, part, parts, phaseExport }: GrowthWorkerJob): void {
  const control = new Int32Array(memory.buffer, address, slots.status + parts - 1);
  try {
    const { exports } = new WebAssembly.Instance(module, { env: { memory } });
    const pointer = exports.__stack_pointer;
    const stage = exports[phaseExport];
    if (!(pointer instanceof WebAssembly.Global) || typeof stage !== 'function')
      throw new Error('Rebuild the Biomes helper with its selected native phase export.');
    pointer.value = stackTop;
    const phase = stage as Phase;
    let generation = Atomics.load(control, slots.generation);
    Atomics.add(control, slots.ready, 1);
    Atomics.notify(control, slots.ready);
    for (;;) {
      Atomics.wait(control, slots.generation, generation);
      const next = Atomics.load(control, slots.generation);
      if (next === generation) continue;
      generation = next;
      Atomics.store(control, slots.status + part - 1, phase(job, part, parts));
      Atomics.add(control, slots.done, 1);
      Atomics.notify(control, slots.done);
    }
  } catch {
    Atomics.store(control, slots.fault, 1);
    Atomics.notify(control, slots.ready);
    Atomics.notify(control, slots.done);
  }
}

if (typeof globalThis.postMessage === 'function') {
  // A connected port can wake a nested browser worker while the calling worker waits.
  globalThis.addEventListener(
    'message',
    (event: MessageEvent<MessagePort>) => {
      event.data.onmessage = (message: MessageEvent<GrowthWorkerJob>) => run(message.data);
      event.data.postMessage('ready');
    },
    { once: true },
  );
} else {
  const name = 'node:worker_threads';
  void import(/* @vite-ignore */ /* webpackIgnore: true */ name).then(({ parentPort }) => {
    if (!parentPort) throw new Error('Start the plant growth helper from a Node worker.');
    parentPort.once('message', run);
    parentPort.postMessage('ready');
  });
}
