import { demoStatus, errorText } from 'margo-demo-status';
import { COUNT, samples, valueAt } from './input.mjs';
import { createPlot } from './plot.js';

const el = id => document.getElementById(id);
const race = el('race'), button = el('run'), status = demoStatus(race, el('status'));
const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
const showMargo = createPlot(el('margo-plot'), '#e8ff89');
const showCpu = createPlot(el('cpu-plot'), '#d4aaff');
const number = new Intl.NumberFormat('en-US');
const measure = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const ms = value => measure.format(value);
const mark = name => performance.mark('sort-' + name);
const basicCosts = el('margo-costs').textContent;
const earlyCompatibility = forced || !navigator.gpu
  ? import('./compatibility.js').then(module => module.installCompatibility(forced))
    .then(outcome => ({ outcome }), error => ({ error }))
  : undefined;
const session = import('./scene.js').then(async scene => {
  const opened = await scene.openCompute(forced, earlyCompatibility);
  race.dataset.backend = opened.backend;
  if (opened.backend === 'webgl2') {
    el('backend').textContent = 'WebGL2 compatibility · CPU kernel';
    el('margo-time-label').textContent = 'radix + completion';
  } else {
    el('backend').textContent = 'Native WebGPU';
  }
  return { scene, ...opened };
}).catch(error => {
  race.dataset.backend = 'unavailable';
  el('backend').textContent = 'GPU unavailable';
  el('margo-costs').textContent = errorText(error);
  return { unavailable: error };
});

let seed = 479897;
let run = 0;
const resetPlots = () => {
  const preview = samples(index => valueAt(index, seed));
  showMargo(preview, false);
  showCpu(preview, false);
};
resetPlots();

function reply(worker, phase, signal, keys) {
  return new Promise((resolve, reject) => {
    const clean = () => {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      signal.removeEventListener('abort', aborted);
    };
    const aborted = () => { clean(); reject(signal.reason); };
    const failed = error => { clean(); reject(new Error(error.message || 'The sort worker failed.')); };
    if (signal.aborted) {
      aborted();
      return;
    }
    worker.onmessage = ({ data }) => {
      clean();
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    worker.onerror = worker.onmessageerror = failed;
    signal.addEventListener('abort', aborted, { once: true });
    if (keys) worker.postMessage({ phase, keys }, [keys.buffer]);
    else worker.postMessage({ phase, seed });
  });
}

function resultState(lane, value) {
  el(lane + '-state').textContent = value;
}

function showRanks(ranks) {
  const strip = el('rank-strip');
  strip.replaceChildren(...ranks.map((rank, i) => {
    const tag = document.createElement('span');
    tag.textContent = (i + 1) * 25 + '% · ' + number.format(rank);
    return tag;
  }));
  strip.hidden = false;
}

button.addEventListener('click', async () => {
  if (run++) seed = (seed + 341873) & 1048575;
  race.dataset.run = String(run);
  race.dataset.state = 'preparing';
  for (const key of ['verified', 'rankTotal', 'margoMs', 'cpuMs', 'compatCpuDispatches']) delete race.dataset[key];
  button.disabled = true;
  el('run-label').textContent = 'Sorting…';
  el('rank-strip').hidden = true;
  el('margo-time').textContent = el('cpu-time').textContent = '—';
  el('margo-costs').textContent = basicCosts;
  el('audit-title').textContent = 'Checking every value';
  el('audit-copy').textContent = 'Waiting for both ordered arrays.';
  resultState('margo', 'Queued');
  resultState('cpu', 'Queued');
  el('status').textContent = 'Preparing a million keys…';
  resetPlots();
  mark('accepted');
  const signal = AbortSignal.timeout(45000);
  let worker;
  try {
    worker = new Worker(new URL('./cpu.js', import.meta.url), { type: 'module' });
    const { keys } = await reply(worker, 'prepare', signal);
    if (keys.length !== COUNT) throw new Error('The input has the wrong length.');
    mark('input-ready');
    resultState('cpu', 'Sorting');
    race.dataset.state = 'cpu';
    el('status').textContent = 'Running the CPU sort…';
    const cpu = await reply(worker, 'cpu', signal);
    race.dataset.cpuMs = String(cpu.ms);
    el('cpu-time').textContent = ms(cpu.ms);
    showCpu(cpu.preview, true);
    resultState('cpu', 'Verified');
    mark('cpu-ready');

    const opened = await session;
    if (opened.unavailable) {
      resultState('margo', 'Unavailable');
      el('margo-costs').textContent = errorText(opened.unavailable);
      el('audit-title').textContent = 'CPU output verified';
      el('audit-copy').textContent = 'All 1,000,000 CPU values match the expected order. No GPU time is available.';
      el('status').textContent = 'CPU sort complete. GPU unavailable.';
      race.dataset.state = 'cpu-only';
      return;
    }

    const { compute, scene, backend } = opened;
    resultState('margo', 'Sorting');
    race.dataset.state = 'margo';
    el('status').textContent = 'Running the Margo radix sort…';
    const margo = await scene.sortKeys(compute, keys, signal);
    resultState('margo', 'Checking');
    const checked = await reply(worker, 'verify', signal, margo.result);
    const ranks = await scene.rankCuts(compute, checked.histogram, signal);
    race.dataset.margoMs = String(margo.ms);
    if (margo.cpuDispatches !== undefined) race.dataset.compatCpuDispatches = String(margo.cpuDispatches);
    race.dataset.verified = String(COUNT);
    race.dataset.rankTotal = String(ranks.at(-1));
    el('margo-time').textContent = ms(margo.ms);
    el('margo-costs').textContent = 'Upload ' + ms(margo.upload) + ' ms · Readback ' + ms(margo.readback) + ' ms';
    showMargo(checked.preview, true);
    showRanks(ranks);
    resultState('margo', 'Verified');
    el('audit-title').textContent = '1,000,000 matching values';
    el('audit-copy').textContent = 'Both arrays match at every index. A Margo prefix scan of the verified value bins gives the cumulative ranks below.';
    el('status').textContent = backend === 'webgl2'
      ? 'Verified. Both timings are CPU-backed here.'
      : 'Verified. Both results are in exact order.';
    race.dataset.state = 'complete';
    mark('complete');
  } catch (error) {
    race.dataset.state = 'failed';
    resultState('margo', 'Incomplete');
    if (!race.dataset.cpuMs) resultState('cpu', 'Incomplete');
    el('audit-title').textContent = 'Verification incomplete';
    el('audit-copy').textContent = errorText(error);
    el('status').textContent = 'The run did not finish.';
  } finally {
    worker?.terminate();
    button.disabled = false;
    el('run-label').textContent = 'Run again';
  }
});

button.disabled = false;
status.ready('Run both sorts on this device.');
mark('opening-ready');
