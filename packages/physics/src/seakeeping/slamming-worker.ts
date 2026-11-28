import { openSlammingBatch, type SlammingJob, type SlammingReply } from './slamming-native.js';

function run(job: SlammingJob): SlammingReply {
  try {
    const native = openSlammingBatch(job);
    try {
      for (const section of job.sections) if (!native.add(section)) return { invalid: true };
      return native.result();
    } finally {
      native.close();
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;
if (typeof node === 'string') {
  type ParentPort = {
    once(event: 'message', listener: (request: SlammingJob) => void): void;
    postMessage(reply: SlammingReply): void;
  };
  const name = 'node:worker_threads';
  void (import(/* @vite-ignore */ /* webpackIgnore: true */ name) as Promise<{ parentPort: ParentPort | null }>).then(
    ({ parentPort }) => parentPort?.once('message', (request) => parentPort.postMessage(run(request))),
  );
} else {
  const worker = globalThis as unknown as {
    onmessage: (event: MessageEvent<SlammingJob>) => void;
    postMessage(reply: SlammingReply): void;
  };
  worker.onmessage = ({ data }) => worker.postMessage(run(data));
}
