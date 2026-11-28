import { MargoError } from '@margoengine/math/errors';
import type { NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

export interface SwimKernelBuilds {
  readonly plain: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly pool?: NativePhasePool;
}

export interface SwimWorkerWork {
  readonly bodies: number;
  readonly simdAxisPairs: number;
  readonly passiveReactions: number;
}

export interface SwimWorkCounts extends SwimWorkerWork {
  readonly threads: number;
  readonly workers: readonly SwimWorkerWork[];
}

const U32 = Uint32Array.BYTES_PER_ELEMENT;
const JOB_WORDS = 12;
const RECEIPT_WORDS = 2;

type SwimPhase = (job: number, stage: number, part: number, parts: number) => number;
type SwimApply = (job: number) => number;

type SwimStep = (
  body: number,
  parameters: number,
  medium: number,
  next: number,
  kinematics: number,
  wake: number,
  count: number,
  dt: number,
) => number;

type SwimPassiveStep = (
  body: number,
  parameters: number,
  medium: number,
  next: number,
  kinematics: number,
  wake: number,
  passiveReaction: number,
  count: number,
  dt: number,
) => number;

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const name = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ name);
      const module = await WebAssembly.compile(await readFile(url, { signal }));
      signal?.throwIfAborted();
      return module;
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw new MargoError('failed', 'The swimming asset returned HTTP ' + response.status + '. Check its URL.');
    const module = await WebAssembly.compile(await response.arrayBuffer());
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(
      new MargoError(
        'failed',
        'The swimming kernel could not load. Serve its Wasm asset and use a SIMD-capable runtime.',
      ),
      { cause },
    );
  }
}

export async function loadSwimKernel(signal?: AbortSignal, threads = 1): Promise<SwimKernelBuilds> {
  if (!Number.isSafeInteger(threads) || threads < 1)
    throw new MargoError('state', 'Invalid swimmer thread count. Choose a positive whole number.');
  if (threads > 1 && !canShareMemory())
    throw new MargoError('unsupported', 'Use a shared-memory host for swimmer workers or threads: 1.');
  signal?.throwIfAborted();
  const [plain, shared] = await Promise.all([
    compile(new URL(/* @vite-ignore */ './swim-kernel.wasm?no-inline', import.meta.url), signal),
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './swim-kernel-shared.wasm?no-inline', import.meta.url), signal)
      : undefined,
  ]);
  if (threads === 1) return { plain, shared };
  const { createNativePhasePool } = await import('../native-phase-pool.js');
  const pool = await createNativePhasePool(threads, { subject: 'Swimmer', phaseExport: 'swim_thread_phase', signal });
  return { plain, shared, pool };
}

function stackTop(host: SolverHost, name: string): number {
  const stack = host.allocate(name, STACK_BYTES + 16, 'u8', 1);
  return Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
}

export function instantiateSwimKernel(
  host: SolverHost,
  builds: SwimKernelBuilds,
  withPassive: boolean,
): { step: SwimStep; passive: SwimPassiveStep; apply: SwimPassiveStep; workCounts(): SwimWorkCounts } {
  const shared = isShared(host.memory);
  const module = shared ? builds.shared : builds.plain;
  const { pool } = builds;
  if (pool && !shared)
    throw new MargoError('unsupported', 'Use worldMemory(true) for swimmer workers or set threads: 1.');
  if (!module)
    throw new MargoError(
      'unsupported',
      'The shared swimming kernel is unavailable. Use plain world memory on this host.',
    );
  const threads = pool?.count ?? 1;
  const accepted = new Uint32Array(RECEIPT_WORDS * threads);
  const job = host.allocate('swim-worker-job', JOB_WORDS * U32, 'u32', 1);
  const receipts = host.allocate('swim-work-receipts', accepted.length * U32, 'u32', 1);
  const leaderStack = stackTop(host, 'swim-kernel-stack');
  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  const pointer = exports.__stack_pointer;
  if (
    !(pointer instanceof WebAssembly.Global) ||
    typeof exports.swim_step !== 'function' ||
    typeof exports.swim_step_passive !== 'function' ||
    typeof exports.swim_apply !== 'function' ||
    typeof exports.swim_thread_phase !== 'function'
  )
    throw new MargoError(
      'failed',
      'The swimming kernel is missing exports. Run the Physics package and swimming Wasm builds.',
    );
  pointer.value = leaderStack;
  const native = exports.swim_apply as SwimApply;
  const partition = exports.swim_thread_phase as SwimPhase;
  const ptr = job.byteOffset;
  new Uint32Array(host.memory.buffer, ptr, 10)[8] = receipts.byteOffset;
  if (pool) {
    const control = host.allocate('swim-worker-control', U32 * pool.controlWords, 'i32', 1);
    const stackTops = Array.from({ length: threads - 1 }, (_, i) => stackTop(host, `swim-worker-stack-${i + 1}`));
    pool.init({ module, memory: host.memory, control: control.byteOffset, job: ptr, stackTops });
  }

  const apply: SwimPassiveStep = (body, parameters, medium, next, kinematics, wake, passive, count, dt) => {
    if (Boolean(passive) !== withPassive || !Number.isSafeInteger(count) || count < 0 || count > 0xffffffff)
      return 1;
    const { buffer } = host.memory;
    const header = new Uint32Array(buffer, ptr, 8);
    header[0] = body;
    header[1] = parameters;
    header[2] = medium;
    header[3] = next;
    header[4] = kinematics;
    header[5] = wake;
    header[6] = passive;
    header[7] = count;
    new Float64Array(buffer, ptr + 10 * U32, 1)[0] = dt;
    const status = pool ? pool.phase(0, () => partition(ptr, 0, 0, threads)) : native(ptr);
    if (status !== 0) return status;
    const recorded = new Uint32Array(buffer, receipts.byteOffset, accepted.length);
    let complete = 0;
    for (let i = 0; i < recorded.length; i += RECEIPT_WORDS) {
      const bodies = recorded[i]!;
      if (recorded[i + 1] !== (withPassive ? bodies : 0))
        throw new MargoError('failed', 'Swimmer batch returned invalid passive work. Rebuild the swimming assets.');
      complete += bodies;
    }
    if (complete !== count)
      throw new MargoError('failed', 'Swimmer batch missed body rows. Rebuild the swimming assets.');
    accepted.set(recorded);
    return 0;
  };

  function workCounts(): SwimWorkCounts {
    let bodies = 0;
    let passiveReactions = 0;
    const workers = Array.from({ length: threads }, (_, worker) => {
      const rows = accepted[RECEIPT_WORDS * worker]!;
      const passive = accepted[RECEIPT_WORDS * worker + 1]!;
      bodies += rows;
      passiveReactions += passive;
      return { bodies: rows, simdAxisPairs: 2 * rows, passiveReactions: passive };
    });
    return { threads, bodies, simdAxisPairs: 2 * bodies, passiveReactions, workers };
  }
  return { step: exports.swim_step as SwimStep, passive: exports.swim_step_passive as SwimPassiveStep, apply, workCounts };
}
