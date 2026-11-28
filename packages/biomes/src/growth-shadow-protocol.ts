export const growthControl = { generation: 0, ready: 1, done: 2, fault: 3, status: 4 } as const;

export interface GrowthWorkerJob {
  readonly module: WebAssembly.Module;
  readonly memory: WebAssembly.Memory;
  readonly job: number;
  readonly control: number;
  readonly stackTop: number;
  readonly part: number;
  readonly parts: number;
}
