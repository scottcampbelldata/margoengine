// A worker thread of a KernelWorld (`KernelWorld.useThreads`): its own instance of the threaded kernel over the world's
// shared memory, on a stack region of its own, solving the runs of islands the main thread hands it. The world itself is the
// main thread's: this instance only reads its handle from the kernel's statics and, on a view of its own, fits the boxes of
// runs of the awake bodies (`world_broad_refresh`), finds runs of the narrow phase's pairs (`world_narrow_pairs`) and solves
// runs of islands (`world_solve_islands`), so it never grows the world, filters a pair or modifies a contact.

import { MargoError } from '@margoengine/math/errors';

/** What the main thread sends: the module and memory to start on, then runs of boxes, of active pairs and of islands. */
type Message =
  | { readonly module: WebAssembly.Module; readonly memory: WebAssembly.Memory; readonly stack: number }
  | {
      readonly work: 'boxes' | 'pairs' | 'islands';
      readonly first: number;
      readonly last: number;
      readonly dt: number;
    };

/** The answer to each message: done, or the error that stopped it. */
type Reply = { readonly ok: true } | { readonly ok: false; readonly message: string };

const mainOnly = (what: string) => (): never => {
  throw new MargoError(
    'state',
    `A kernel thread only fits boxes, finds pairs and solves islands; ${what} is the main thread's work: step the world with stepAsync from the main thread.`,
  );
};

let solve: ((first: number, last: number, dt: number) => void) | null = null,
  narrow: ((first: number, last: number, dt: number) => number) | null = null,
  boxes: ((first: number, last: number, dt: number) => number) | null = null;

function handle(message: Message): Reply {
  try {
    if ('module' in message) {
      const { exports } = new WebAssembly.Instance(message.module, {
        env: {
          memory: message.memory,
          region_resize: mainOnly('growing the world'),
          contact_filter: mainOnly('filtering a pair'),
          contact_modify: mainOnly('modifying a contact'),
          clock: () => performance.now(),
        },
      });
      (exports.__stack_pointer as WebAssembly.Global).value = message.stack;
      solve = exports.world_solve_islands as (first: number, last: number, dt: number) => void;
      narrow = exports.world_narrow_pairs as (first: number, last: number, dt: number) => number;
      boxes = exports.world_broad_refresh as (first: number, last: number, dt: number) => number;
    } else {
      if (!solve || !narrow || !boxes)
        throw new MargoError(
          'state',
          'A kernel thread was asked to solve before it was started; send the module first.',
        );
      if (message.work === 'boxes') boxes(message.first, message.last, message.dt);
      else if (message.work === 'pairs') narrow(message.first, message.last, message.dt);
      else solve(message.first, message.last, message.dt);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;
if (typeof node === 'string') {
  const name = 'node:worker_threads';
  // The few members of Node's worker_threads used here (the package has no Node types).
  const { parentPort } = (await import(/* @vite-ignore */ name)) as {
    parentPort: {
      on(event: 'message', listener: (message: Message) => void): void;
      postMessage(reply: Reply): void;
    } | null;
  };
  parentPort?.on('message', (message: Message) => parentPort.postMessage(handle(message)));
} else {
  const scope = globalThis as unknown as {
    onmessage: (event: MessageEvent<Message>) => void;
    postMessage(reply: Reply): void;
  };
  scope.onmessage = (event) => scope.postMessage(handle(event.data));
}
