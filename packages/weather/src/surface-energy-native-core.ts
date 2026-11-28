export const PAGE = 65_536;
export const MAX_PAGES = 65_536;
export const INPUT_WORDS = 13;
export const OUTPUT_WORDS = 4;
export const WORK_WORDS = 4;

export const controlSlots = {
  generation: 0,
  done: 1,
  fault: 2,
  input: 3,
  output: 4,
  receipts: 5,
  rows: 6,
  status: 7,
} as const;

export interface SurfaceEnergyWorkerStart {
  readonly module: WebAssembly.Module;
  readonly memory: WebAssembly.Memory;
  readonly part: number;
  readonly parts: number;
}

type Apply = (input: number, output: number, receipts: number, rows: number, part: number, parts: number) => number;

export function bindSurfaceEnergy({ module, memory, part }: SurfaceEnergyWorkerStart): Apply {
  const { exports } = new WebAssembly.Instance(module, { env: { memory } });
  const { __stack_pointer: stack, __data_end: data, surface_energy_apply: apply } = exports;
  if (!(stack instanceof WebAssembly.Global) || !(data instanceof WebAssembly.Global) || data.value !== 0)
    throw new Error('Build surface energy with the stateless native stack exports.');
  if (typeof apply !== 'function') throw new Error('Build surface energy with its matching native batch export.');
  stack.value = (part + 2) * PAGE;
  return apply as Apply;
}
