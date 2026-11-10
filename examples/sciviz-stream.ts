import { streamLayer, SlidingTimeWindow, pollingSource } from '@margoengine/sciviz/stream';
import { polishFigure } from '@margoengine/sciviz/format';
import { createFigure, element } from './sciviz-demo.js';
interface Feed {
  metadata: { generated: number };
  features: { id: string; properties: { mag: number | null; time: number; updated: number } }[];
}
const rows = (feed: Feed) =>
  feed.features
    .filter((f) => Number.isFinite(f.properties.mag) && Number.isFinite(f.properties.time))
    .map((f) => ({ id: f.id, time: f.properties.time, mag: f.properties.mag!, updated: f.properties.updated }))
    .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
const feed = (await fetch('./assets/sciviz/stream/earthquakes.geojson').then((r) => r.json())) as Feed,
  samples = rows(feed),
  initial = samples.slice(0, 3),
  data = { x: initial.map((r) => r.time), y: initial.map((r) => r.mag) };
const figure = await createFigure(element<HTMLCanvasElement>('viewport'), {
    mode: '2d',
    theme: 'light',
    scale: { x: 'date' },
    tooltips: false,
    margin: { left: 65, right: 35, top: 24, bottom: 60 },
  }),
  nativeLine = await figure.line(data, { name: 'Event magnitudes', color: '#d47a46', width: 2 });
const chart = await polishFigure(figure, {
  x: { domain: [samples[0].time, samples.at(-1)!.time] },
  y: { domain: [-2, 8] },
  xFormat: {
    mode: 'date',
    date: { month: 'short', day: 'numeric', year: undefined, hour: '2-digit', minute: '2-digit' },
  },
  xLabel: 'Event time, UTC',
  yLabel: 'Magnitude',
  tooltip: '{name}: {x:date} / M {y:fixed.2}',
});
const line = await streamLayer(figure, nativeLine, { rollover: 64, data }),
  points = await streamLayer(figure, await chart.scatter(data, { name: 'Earthquakes', color: '#277da8', size: 7 }), {
    rollover: 64,
    data,
  }),
  window = new SlidingTimeWindow(figure, { duration: 6 * 3600000, end: initial.at(-1)!.time, smoothing: 250 });
let cursor = 3,
  ids = initial.map((r) => r.id),
  operation: AbortController | undefined,
  lastTime = initial.at(-1)!.time;
const status = (message = 'snapshot replay') => {
  element('status').textContent =
    `Ready: ${line.streamData.x.length} retained events; ${cursor}/${samples.length} snapshot events; ${message}.`;
};
async function append(items: typeof samples) {
  if (!items.length) return;
  const data = { x: items.map((r) => r.time), y: items.map((r) => r.mag) };
  await Promise.all([line.append(data), points.append(data)]);
  ids = [...ids, ...items.map((r) => r.id)].slice(-64);
  lastTime = Math.max(lastTime, items.at(-1)!.time);
  window.setTime(lastTime);
}
let advancing = Promise.resolve();
function advance(count = 10): Promise<void> {
  const run = async () => {
    const next = samples.slice(cursor, cursor + count);
    await append(next);
    cursor += next.length;
    status();
  };
  const pending = advancing.then(run, run);
  advancing = pending;
  return pending;
}
function stop() {
  operation?.abort();
  operation = undefined;
  status('stopped');
}
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, ms),
      abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
    signal.addEventListener('abort', abort, { once: true });
  });
const failure = (error: unknown, signal?: AbortSignal) => {
  if (!signal?.aborted) element('status').textContent = `Source failed: ${(error as Error).message}`;
};
element('next').addEventListener('click', () => {
  void advance().catch((e) => failure(e));
});
element('stop').addEventListener('click', stop);
element('replay').addEventListener('click', () => {
  stop();
  operation = new AbortController();
  const signal = operation.signal;
  void (async () => {
    while (cursor < samples.length) {
      signal.throwIfAborted();
      await advance(1);
      await pause(200, signal);
    }
  })().catch((e) => failure(e, signal));
});
element('live').addEventListener('click', () => {
  stop();
  operation = new AbortController();
  const signal = operation.signal;
  void (async () => {
    for await (const feed of pollingSource<Feed>(
      'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
      { interval: 60000, signal },
    )) {
      const latest = rows(feed);
      for (const r of latest) {
        const index = ids.indexOf(r.id);
        if (index >= 0) {
          const old = line.streamData;
          if (old.x[index] !== r.time || old.y[index] !== r.mag)
            await Promise.all([
              line.patch(index, { x: [r.time], y: [r.mag] }),
              points.patch(index, { x: [r.time], y: [r.mag] }),
            ]);
        }
      }
      await append(latest.filter((r) => r.time > lastTime && !ids.includes(r.id)));
      status(`live feed generated ${new Date(feed.metadata.generated).toISOString()}`);
    }
  })().catch((e) => failure(e, signal));
});
element('export').addEventListener('click', () => {
  void chart
    .toSVG()
    .then((svg) => {
      const a = document.createElement('a'),
        url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      a.href = url;
      a.download = 'usgs-live.svg';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    })
    .catch((e) => failure(e));
});
Object.assign(globalThis, { streamDemo: { figure, chart, line, points, window, samples, advance, stop } });
status();
