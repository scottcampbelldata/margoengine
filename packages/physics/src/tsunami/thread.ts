import { TSUNAMI_THREAD_CONTROL as slots, type TsunamiWorkerStart } from './threads.js';

type NativePhase = (job: number, stage: number, part: number, parts: number) => number;

function run(start: TsunamiWorkerStart): void {
  const view = () => new Int32Array(start.memory.buffer, start.control, slots.status + start.parts - 1);
  let phase: NativePhase;
  try {
    const { exports } = new WebAssembly.Instance(start.module, { env: { memory: start.memory } });
    const stack = exports.__stack_pointer;
    const kernelPhase = exports.tsunami_thread_phase;
    if (!(stack instanceof WebAssembly.Global) || typeof kernelPhase !== 'function') {
      throw new Error('Tsunami worker Wasm exports are missing. Rebuild both tsunami kernel variants.');
    }
    stack.value = start.stackTop;
    phase = kernelPhase as NativePhase;
  } catch {
    const control = view();
    Atomics.store(control, slots.fault, 1);
    Atomics.add(control, slots.ready, 1);
    Atomics.notify(control, slots.ready);
    return;
  }
  const control = view();
  let seen = Atomics.load(control, slots.generation);
  Atomics.add(control, slots.ready, 1);
  Atomics.notify(control, slots.ready);
  for (;;) {
    Atomics.wait(view(), slots.generation, seen);
    const current = view();
    const next = Atomics.load(current, slots.generation);
    if (next === seen) continue;
    seen = next;
    try {
      const status = phase(start.job, Atomics.load(current, slots.stage), start.part, start.parts);
      Atomics.store(current, slots.status + start.part - 1, status);
    } catch {
      Atomics.store(current, slots.fault, 1);
      Atomics.add(current, slots.done, 1);
      Atomics.notify(current, slots.done);
      return;
    }
    Atomics.add(current, slots.done, 1);
    Atomics.notify(current, slots.done);
  }
}

const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;
if (typeof node === 'string') {
  const name = 'node:worker_threads';
  const { parentPort } = (await import(/* @vite-ignore */ /* webpackIgnore: true */ name)) as {
    parentPort: {
      once(event: 'message', listener: (message: TsunamiWorkerStart) => void): void;
      postMessage(message: string): void;
    } | null;
  };
  parentPort?.once('message', run);
  parentPort?.postMessage('ready');
} else {
  const worker = globalThis as unknown as {
    onmessage: (event: MessageEvent<MessagePort>) => void;
  };
  worker.onmessage = ({ data: port }) => {
    port.onmessage = (event: MessageEvent<TsunamiWorkerStart>) => {
      port.close();
      run(event.data);
    };
    port.postMessage('ready');
  };
}
