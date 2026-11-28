// A worker thread of a GPUCloth's CPU route (SOFT-01): its own instance of the shared cloth kernel over the cloth's shared
// memory, on a stack region of its own, running its fixed share of every pass of a frame (cloth-kernel/src/lib.rs,
// `cloth_step_part`) each time the main thread raises the frame's generation. An item's operations do not depend on which
// thread runs it, so any thread count gives the same bits.

/** The start message: the module, the cloth's memory, this thread's stack top, the header and control regions. */
interface Start {
  readonly module: WebAssembly.Module;
  readonly memory: WebAssembly.Memory;
  readonly stack: number;
  readonly header: number;
  readonly control: number;
  readonly index: number;
  readonly threads: number;
}

/** Control words (i32): the frame's generation, workers done, workers ready, an error flag. */
const GENERATION = 0,
  DONE = 1,
  READY = 2,
  ERROR = 3;

function run(start: Start): void {
  const { exports } = new WebAssembly.Instance(start.module, { env: { memory: start.memory } });
  (exports.__stack_pointer as WebAssembly.Global).value = start.stack;
  const part = exports.cloth_step_part as (header: number, thread: number, threads: number) => void;
  const control = () => new Int32Array(start.memory.buffer, start.control, 4);
  Atomics.add(control(), READY, 1);
  Atomics.notify(control(), READY);
  let seen = 0;
  for (;;) {
    Atomics.wait(control(), GENERATION, seen);
    seen = Atomics.load(control(), GENERATION);
    try {
      part(start.header, start.index, start.threads);
    } catch {
      Atomics.store(control(), ERROR, 1);
    }
    Atomics.add(control(), DONE, 1);
    Atomics.notify(control(), DONE);
  }
}

const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;
if (typeof node === 'string') {
  const name = 'node:worker_threads';
  const { parentPort } = (await import(/* @vite-ignore */ name)) as {
    parentPort: { on(event: 'message', listener: (message: Start) => void): void } | null;
  };
  parentPort?.on('message', run);
} else {
  (globalThis as unknown as { onmessage: (event: MessageEvent<Start>) => void }).onmessage = (event) => run(event.data);
}
