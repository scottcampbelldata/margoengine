import { Session } from 'node:inspector/promises';

/** One full operation, with a CPU sample inventory instead of elapsed-time metrics. */
export async function profileTask(task, session = new Session()) {
  session.connect();
  try {
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: 100 });
    await session.post('Profiler.start');
    await task(0);
    const { profile } = await session.post('Profiler.stop');
    return profile.nodes
      .filter((n) => n.hitCount)
      .map(({ callFrame: f, hitCount }) => ({
        function: f.functionName,
        url: f.url,
        line: f.lineNumber + 1,
        samples: hitCount,
      }))
      .sort((a, b) => b.samples - a.samples);
  } finally {
    session.disconnect();
  }
}
