// A worker thread of the explosive kernel (FIRE-05): its own instance of the shared explosive kernel over the world's shared
// memory, on a stack region of its own, flying one fixed partition of the fragments each time the main thread raises the
// job's generation. The main thread flies the last partition and waits for every worker's done. A fragment's operations do
// not depend on which thread flies it, so any thread count gives the same bits.

/** The start message: the module, the world memory, this thread's stack top, and the control and job regions. */
interface Start {
  readonly module: WebAssembly.Module;
  readonly memory: WebAssembly.Memory;
  readonly stack: number;
  readonly control: number;
  readonly job: number;
  readonly index: number;
}

type Fly = (...args: number[]) => void;

/** Control words (i32): job generation, workers done, workers ready, an error flag. */
const GENERATION = 0,
  DONE = 1,
  READY = 2,
  ERROR = 3;

function run(start: Start): void {
  const { exports } = new WebAssembly.Instance(start.module, { env: { memory: start.memory } });
  (exports.__stack_pointer as WebAssembly.Global).value = start.stack;
  const fly = exports.fly as Fly;
  const control = () => new Int32Array(start.memory.buffer, start.control, 4);
  Atomics.add(control(), READY, 1);
  Atomics.notify(control(), READY);
  let seen = 0;
  for (;;) {
    Atomics.wait(control(), GENERATION, seen);
    seen = Atomics.load(control(), GENERATION);
    try {
      const j = new Float64Array(start.memory.buffer, start.job, JOB_WORDS);
      const count = j[16]!,
        threads = j[17]!;
      const first = Math.floor((start.index * count) / threads),
        last = Math.floor(((start.index + 1) * count) / threads);
      fly(
        j[13]! + first * 64,
        j[14]! + first * 8,
        j[15]! + first * 8,
        last - first,
        j[0]!,
        j[1]!,
        j[2]!,
        j[3]!,
        j[4]!,
        j[5]!,
        j[6]!,
        j[7]!,
        j[8]!,
        j[9]!,
        j[10]!,
        j[11]!,
        j[12]!,
        j[18]! + start.index * 16,
      );
    } catch {
      Atomics.store(control(), ERROR, 1);
    }
    Atomics.add(control(), DONE, 1);
    Atomics.notify(control(), DONE);
  }
}

/** f64 words of a job: dt, end, gx, gy, gz, ground, bed, columns, rows, width, depth, cx, cz, fragments, drag, launch,
 * count, threads, counts. */
const JOB_WORDS = 19;

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
