/** Await optional package dependencies; a closed page owns no late factory result. */
export async function createWorkloadForPage(module, count, signal) {
  signal.throwIfAborted();
  const workload = await module.createWorkload(count, {signal});
  if (signal.aborted) {workload.dispose?.(); signal.throwIfAborted();}
  return workload;
}
