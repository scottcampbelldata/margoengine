import { jobs } from './samples.js';

export function openArchive(signal) {
  const worker = new Worker(new URL('./parse-worker.js', import.meta.url), { type: 'module', name: 'CAD sample shelf' });
  const responses = new Map(), pending = new Map();
  const finish = () => {
    worker.terminate();
    signal.removeEventListener('abort', abort);
  };
  function exit(error) {
    finish();
    for (const result of pending.values()) result.reject(error);
    pending.clear();
  }
  const abort = () => exit(signal.reason);
  for (const id of jobs) {
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    void response.catch(() => {});
    responses.set(id, response);
  }
  worker.onmessage = ({ data: { id, sample, error } }) => {
    const resolve = pending.get(id);
    if (!resolve) return;
    pending.delete(id);
    if (error) resolve.reject(new Error(error));
    else resolve.resolve(sample);
    if (!pending.size) finish();
  };
  worker.onerror = (event) => exit(event.error ?? new Error('The exchange files could not be read.'));
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return responses;
}
