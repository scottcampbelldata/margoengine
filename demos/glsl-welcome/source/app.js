import { demoStatus } from 'margo-demo-status';
import { examples } from './examples.js';
import { prepareFragment } from './fragment.js';
import { openWorkspace } from './scene.js';

const element = id => document.getElementById(id);
const exhibit = element('exhibit');
const input = element('fragment');
const run = element('run');
const scrubber = element('phase');
const phaseValue = element('phase-value');
const diagnostic = element('diagnostic');
const title = element('active-name');
const buttons = [...document.querySelectorAll('[data-example]')];
const status = demoStatus(exhibit, element('engine-status'));
const force = new URLSearchParams(location.search).get('backend') === 'webgl2';
const controller = new AbortController();
const { signal } = controller;
let workspace, observer, running = false, serial = 0, phase = 0, phaseDirty = false, drawing;

input.value = examples.silk.source;

function setDiagnostic(text, error = false) {
  diagnostic.textContent = text;
  diagnostic.dataset.error = String(error);
  input.setAttribute('aria-invalid', String(error));
}

function markInput() {
  if (!performance.getEntriesByName('margo-first-input-rendered').length) {
    performance.mark('margo-first-input-rendered');
  }
}

function fail(error) {
  if (signal.aborted) return;
  status.error(error);
  for (const control of [input, run, scrubber, ...buttons]) control.disabled = true;
  workspace?.close();
}

async function updatePhase() {
  if (!workspace || drawing || running || status.failed || signal.aborted) return;
  phaseDirty = false;
  const value = phase;
  drawing = workspace.phase(value);
  try {
    await drawing;
    if (signal.aborted) return;
    phaseValue.value = value.toFixed(2);
    exhibit.dataset.phase = value.toFixed(2);
    if (value !== 0) markInput();
  } catch (error) {
    fail(error);
  } finally {
    drawing = undefined;
    if (phaseDirty) void updatePhase();
  }
}

function setRunning(busy) {
  running = busy;
  run.disabled = busy;
  for (const button of buttons) button.disabled = busy;
}

async function apply() {
  if (!workspace || running || signal.aborted || status.failed) return;
  const source = input.value;
  const match = Object.entries(examples).find(([, sample]) => source === sample.source);
  setRunning(true);
  setDiagnostic('Compiling fragment…');
  try {
    const compiled = prepareFragment(source);
    await drawing;
    await workspace.apply(compiled, phase);
    if (signal.aborted) return;
    const [key, sample] = match ?? ['custom', {title: 'Edited fragment'}];
    title.textContent = sample.title;
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.example === key));
    exhibit.dataset.shader = key;
    exhibit.dataset.revision = String(++serial);
    setDiagnostic('Compiled and rendered.');
    markInput();
  } catch (error) {
    if (!signal.aborted) setDiagnostic(error.message || String(error), true);
  } finally {
    if (!signal.aborted && !status.failed) {
      setRunning(false);
      if (phaseDirty) void updatePhase();
    }
  }
}

run.addEventListener('click', () => void apply(), {signal});
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void apply();
  }
}, {signal});
for (const button of buttons) {
  button.addEventListener('click', () => {
    input.value = examples[button.dataset.example].source;
    void apply();
  }, {signal});
}
scrubber.addEventListener('input', () => {
  phase = Number(scrubber.value) / 100;
  phaseDirty = true;
  void updatePhase();
}, {signal});
window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  controller.abort();
  observer?.disconnect();
}, {signal});

Promise.resolve().then(() => openWorkspace(element('view'), prepareFragment(input.value), force, signal)).then(scene => {
  workspace = scene;
  signal.throwIfAborted();
  exhibit.dataset.renderer = scene.backend;
  exhibit.dataset.shader = 'silk';
  exhibit.dataset.revision = '0';
  exhibit.dataset.phase = '0.00';
  for (const control of [input, run, scrubber, ...buttons]) control.disabled = false;
  setDiagnostic('Starter fragment ready.');
  observer = new ResizeObserver(() => {
    phaseDirty = true;
    void updatePhase();
  });
  observer.observe(element('view'));
  performance.mark('margo-first-usable-frame');
  status.ready(scene.backend === 'webgpu' ? 'WebGPU · GLSL ES 3.00' : 'WebGL2 · GLSL ES 3.00');
}).catch(fail);
