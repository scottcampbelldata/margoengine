// The in-browser runner (margoengine.com/bench/): runs the standard browser suites of bench/scenes/catalog.js in a
// same-origin frame, one fresh frame per run, with the same scene page and harness the CLI uses, and shows the
// medians next to the reference run in ./reference.json (written by `npm run bench -- --record`).
import { SCENES, STANDARD, caseId, sceneParams } from '../scenes/catalog.js';
import reference from './reference.json';

const SUITES = {
  startup: { title: 'Startup', metrics: ['loadMs', 'firstFrameMs'], on: true },
  render: { title: 'Render', metrics: ['cpuMs', 'gpuMs', 'fps'], on: true },
  objects: { title: 'Objects', metrics: ['cpuMs', 'gpuMs', 'fps'], on: true },
  scaling: { title: 'Scaling', metrics: ['cpuMs', 'gpuMs', 'fps'] },
  gltf: { title: 'glTF', metrics: ['buildMs', 'cpuMs', 'gpuMs'] },
  memory: { title: 'Memory', metrics: ['jsHeapMB', 'gpuMB'] },
  react: { title: 'React', metrics: ['buildMs', 'cpuMs', 'gpuMs'] },
};
const UNITS = {
  loadMs: 'ms',
  firstFrameMs: 'ms',
  cpuMs: 'ms',
  gpuMs: 'ms',
  buildMs: 'ms',
  fps: 'fps',
  jsHeapMB: 'MB',
  gpuMB: 'MB',
};
const HIGHER = new Set(['fps']);
const read = {
  loadMs: (r) => r.loadMs,
  firstFrameMs: (r) => r.firstFrameMs,
  buildMs: (r) => r.buildMs,
  cpuMs: (r) => r.throughput?.cpuMs?.median,
  gpuMs: (r) => r.gpu?.gpuMs?.median,
  fps: (r) => r.throughput?.fps,
  jsHeapMB: (r) => r.jsHeapMB,
  gpuMB: (r) => r.gpuMemory?.liveMB,
};
const $ = (s) => document.querySelector(s);
const median = (v) => {
  const s = v.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const fmt = (x) =>
  x == null ? '-' : x >= 100 ? Math.round(x).toLocaleString('en-US') : x >= 10 ? x.toFixed(1) : x.toFixed(2);

for (const [name, s] of Object.entries(SUITES))
  $('#suites').insertAdjacentHTML(
    'beforeend',
    `<label><input type="checkbox" value="${name}" ${s.on ? 'checked' : ''}> ${s.title} (${STANDARD[name].length})</label>`,
  );
$('#reference').textContent = reference.id
  ? `Ours: ${reference.label} run ${reference.id} on ${reference.machine}. ${reference.label === 'official' ? '' : 'Not an official measurement.'}`
  : 'No reference run is published yet.';

const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
$('#support').textContent = adapter
  ? `WebGPU adapter: ${[adapter.info?.vendor, adapter.info?.architecture, adapter.info?.description].filter(Boolean).join(' ') || 'unnamed'}.`
  : 'This browser has no WebGPU adapter, so the scenes cannot run here. Chrome, Edge and Safari 26 have WebGPU.';
if (!adapter) $('#run').disabled = true;

let stopped = false,
  results = null;
const stage = $('#stage'),
  fit = () => {
    const frame = stage.querySelector('iframe');
    if (frame) frame.style.transform = `scale(${stage.clientWidth / 1280})`;
  };
addEventListener('resize', fit);

/** One run of one scene in a fresh same-origin frame; resolves with the harness result. */
function once(scene, params, frames) {
  return new Promise((resolve) => {
    const query = new URLSearchParams({
      engine: 'margo',
      scene,
      ...params,
      frames,
      assets: new URL('./assets/', location.href).pathname,
    });
    const frame = document.createElement('iframe');
    frame.title = `${SCENES[scene].title} scene`;
    const done = (event) => {
      if (event.source !== frame.contentWindow || event.data?.type !== 'margo-bench-result') return;
      removeEventListener('message', done);
      resolve(event.data.result);
    };
    addEventListener('message', done);
    frame.src = `./scenes/page.html?${query}`;
    stage.replaceChildren(frame);
    fit();
  });
}

function row(suite, id, metric, mine) {
  const ours = reference.cases?.[`${suite}/${id}`]?.[metric] ?? null,
    ratio = mine != null && ours ? mine / ours : null,
    faster = ratio != null && (HIGHER.has(metric) ? ratio > 1 : ratio < 1);
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${SUITES[suite].title}</td><td>${id}</td><td>${metric} (${UNITS[metric]})</td><td>${fmt(mine)}</td><td>${fmt(ours)}</td><td class="${ratio == null ? 'muted' : faster ? 'faster' : 'slower'}">${ratio == null ? '-' : `${ratio.toFixed(2)}x`}</td>`;
  $('#results tbody').append(tr);
}

$('#run').addEventListener('click', async () => {
  const chosen = [...document.querySelectorAll('#suites input:checked')].map((i) => i.value),
    runs = +$('#runs').value,
    frames = +$('#frames').value;
  stopped = false;
  $('#run').disabled = true;
  $('#stop').disabled = false;
  $('#save').disabled = true;
  $('#results tbody').replaceChildren();
  results = {
    schema: 'margo-bench-web/1',
    date: new Date().toISOString(),
    userAgent: navigator.userAgent,
    adapter: adapter && {
      ...['vendor', 'architecture', 'device', 'description'].reduce((o, k) => ({ ...o, [k]: adapter.info?.[k] }), {}),
    },
    runs,
    frames,
    cases: {},
  };
  const list = chosen.flatMap((suite) => STANDARD[suite].map((c) => ({ suite, ...c })));
  for (const [i, { suite, scene, params }] of list.entries()) {
    const id = caseId(scene, params),
      samples = [];
    for (let r = 0; r < runs && !stopped; r++) {
      $('#status').textContent = `${i + 1}/${list.length} ${suite} ${id}, run ${r + 1} of ${runs}`;
      samples.push(await once(scene, sceneParams(scene, params), frames));
    }
    if (stopped) break;
    const errors = samples.map((s) => s.error).filter(Boolean),
      values = {};
    for (const metric of SUITES[suite].metrics) values[metric] = median(samples.map((s) => read[metric](s)));
    results.cases[`${suite}/${id}`] = { values, errors };
    if (errors.length) row(suite, id, SUITES[suite].metrics[0], null);
    else for (const metric of SUITES[suite].metrics) row(suite, id, metric, values[metric]);
  }
  stage.replaceChildren();
  $('#status').textContent = stopped ? 'Stopped.' : 'Done. Lower is better for times and memory, higher for fps.';
  $('#run').disabled = false;
  $('#stop').disabled = true;
  $('#save').disabled = false;
});
$('#stop').addEventListener('click', () => {
  stopped = true;
  $('#status').textContent = 'Stopping after this run.';
});
$('#save').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(results, null, 1)], { type: 'application/json' }));
  a.download = `margo-bench-${results.date.slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
