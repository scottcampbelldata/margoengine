/** Runs jobs of one key one at a time, in call order; jobs of other keys do not wait. A job's failure stays its own. */
export function keyQueue(): <T>(key: string, job: () => Promise<T>) => Promise<T> {
  const queues = new Map<string, Promise<unknown>>();
  return (key, job) => {
    const run = (queues.get(key) ?? Promise.resolve()).then(job, job),
      tail = run.then(
        () => undefined,
        () => undefined,
      );
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return run;
  };
}
