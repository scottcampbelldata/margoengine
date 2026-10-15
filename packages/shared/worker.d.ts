export function transferables(value: unknown, out?: Set<Transferable>, seen?: Set<object>): Set<Transferable>;
export function movable(input: ArrayBuffer | ArrayBufferView | string): ArrayBuffer | string;
export function canUseWorker(): boolean;
export function runWorker<T>(
  url: URL,
  message: Record<string, unknown>,
  signal?: AbortSignal,
  revive?: (error: { name: string; message: string; [key: string]: unknown }) => Error | undefined,
): Promise<T>;
/** Runs `job` for each message posted to this worker. `never` accepts a job typed for any message shape. */
export function serve(job: (message: never) => unknown): void;
