/** Options of {@link JobPool.run}. */
export interface JobOptions {
  /** Lower runs sooner; equal priorities run in call order. Default 0. */
  priority?: number;
  /** Most milliseconds a worker may run the job; past it the worker is restarted and the job rejects. Default none. */
  timeout?: number;
  /** Aborting rejects the job with the signal's reason: a queued job leaves the queue, a running job's reply is dropped. */
  signal?: AbortSignal;
}

/**
 * Workers sharing one priority queue; each runs one job at a time (its side is `serve` from worker.js). Workers start on
 * demand up to `size`; a crashed or timed-out worker rejects its job and a fresh one takes the queue.
 */
export class JobPool {
  constructor(create: () => Worker, size: number);
  /**
   * Queues one job. `message` (or the function's result, called when a worker takes the job) is posted with its
   * ArrayBuffers and ImageBitmaps transferred; the reply's result comes back the same way. A function returning
   * undefined resolves the job with undefined, unposted.
   */
  run<T>(message: object | (() => object | undefined), options?: JobOptions): Promise<T>;
  /** Terminates the workers and rejects every queued and running job (MargoError `disposed`). */
  dispose(): void;
}
