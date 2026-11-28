import { Timeline } from '@margoengine/sciviz';
import { LabelRenderer } from '@margoengine/labels';
import { chartPoint, chartHeight, chartWidth, dates, openingDay } from './wind-data.js';
import { buildChart } from './chart.js';
import { flowInk } from '@margoengine/sciviz/flow-ink';

const initial = openingDay;
const calendar = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' });
const oneDecimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

const locations = [
  ['PACIFIC', -127, 35, 'ocean'], ['ATLANTIC', -68.6, 35, 'ocean'],
  ['Gulf of Mexico', -90, 22.4, 'ocean'],
  ['Vancouver', -123.12, 49.28, 'place'], ['Chicago', -87.63, 41.88, 'place'],
  ['New York', -74.01, 40.71, 'place'], ['Los Angeles', -118.24, 34.05, 'place'],
];
const theme = { background: '#102834', axis: '#697b67', grid: '#53685d', text: '#eadac0' };

function placeLabels(engine) {
  const overlay = new LabelRenderer({ parent: engine.canvas.parentElement, className: 'geo-labels' });
  engine.scene.use(overlay);
  for (const [title, lon, lat, type] of locations) {
    const tag = document.createElement('span');
    tag.textContent = title;
    tag.className = 'geo-label ' + type;
    const [x, y] = chartPoint(lon, lat);
    overlay.add(tag, { position: [x, .014, -y], anchor: type === 'place' ? [0, .55] : [.5, .5] });
  }
}

export async function open({ engine, renderer, atlas, archive, frames, fit, fail, status, signal, label }) {
  const { canvas } = engine;
  const slider = document.querySelector('#day');
  const date = document.querySelector('#date');
  const peak = document.querySelector('#peak');
  const play = document.querySelector('#play');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let animate, origin, firstChange = false;
  let requestedDay, seeking = false;

  engine.onError = fail;
  engine.scene.background = '#101e27';
  engine.lighting.direction.set([-.75, 1.95, .48, 2.42]);
  engine.lighting.radiance.set([.96, .86, .68, .47]);
  engine.lighting.ambient.set([.60, .83, .95]);
  buildChart(engine, atlas);
  placeLabels(engine);

  function camera() {
    const { width, height } = canvas;
    const halfFov = 17.5 * Math.PI / 180;
    const aspect = width / height;
    const frame = Math.max((chartWidth + .15) / aspect, chartHeight + .19);
    const distance = frame / (2 * Math.tan(halfFov));
    engine.camera.position = [0, distance, .27];
    engine.camera.target = [0, -.01, 0];
    engine.camera.up = [0, 0, -1];
  }
  camera();

  // Chart x, y onto the table: x east, y north to -z, just above the sheet.
  const matrix = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, .011, 0, 1];
  const ramp = ['#4a9c9c', '#78c2b0', '#bfccb0', '#e8b87d', '#f78a57'];
  const winds = await flowInk(engine, {
    matrix, colors: ramp, range: [0, 20], width: 1.5, opacity: .42, signal,
    pulse: { length: .035, gap: .098, speed: .064, speedPerValue: .00227, opacity: .75, highlight: '#fff0c2', amount: .4 },
  });
  const arrows = await flowInk(engine, {
    matrix, colors: ramp, range: [0, 20], width: 1.6, opacity: .85, tint: '#faf5d9', tintAmount: .38, signal,
  });
  signal.addEventListener('abort', () => { winds.dispose(); arrows.dispose(); }, { once: true });
  function draw() {
    if (!signal.aborted) engine.render({ delta: 0 });
  }
  function loop(now) {
    if (signal.aborted) return;
    if (origin === undefined) origin = now;
    winds.seek((now - origin) * .001);
    draw();
    animate = requestAnimationFrame(loop);
  }
  function refreshMotion() {
    if (animate !== undefined) cancelAnimationFrame(animate);
    animate = undefined;
    if (!motion.matches && !document.hidden) animate = requestAnimationFrame(loop);
  }

  const timeline = new Timeline(undefined, theme, dates, async (index, timestamp) => {
    const frame = await frames[index];
    signal.throwIfAborted();
    const stamp = calendar.format(timestamp);
    winds.set(frame.strokes);
    arrows.set(frame.arrows);
    draw();
    slider.value = String(index);
    slider.setAttribute('aria-valuetext', stamp);
    date.value = stamp;
    peak.value = oneDecimal.format(archive[index].maxSpeed) + ' m/s';
    Object.assign(canvas.dataset, {
      day: String(index), date: new Date(timestamp).toISOString().slice(0, 10),
      vectors: String(frame.vectors), segments: String(frame.segments),
    });
    if (!firstChange && index !== initial) {
      firstChange = true;
      performance.mark('wind-day-applied');
    }
  }, { controls: false });

  function playState(playing) {
    play.textContent = playing ? 'Pause dates' : 'Play dates';
    play.setAttribute('aria-pressed', String(playing));
  }
  async function scrub() {
    if (seeking) return;
    seeking = true;
    try {
      while (requestedDay !== undefined && !signal.aborted) {
        const day = requestedDay;
        requestedDay = undefined;
        await timeline.seek(day);
      }
    } finally {
      seeking = false;
    }
  }
  slider.addEventListener('input', () => {
    requestedDay = Number(slider.value);
    timeline.pause();
    playState(false);
    void scrub().catch(fail);
  }, { signal });
  play.addEventListener('click', () => {
    if (timeline.playing) {
      timeline.pause();
      playState(false);
    } else {
      playState(true);
      timeline.play({ fps: 1.3, loop: true, signal }).catch(fail).finally(() => playState(false));
    }
  }, { signal });
  document.addEventListener('visibilitychange', refreshMotion, { signal });
  motion.addEventListener('change', refreshMotion, { signal });
  const observer = new ResizeObserver(() => {
    if (fit()) { camera(); draw(); }
  });
  observer.observe(canvas);
  signal.addEventListener('abort', () => {
    if (animate !== undefined) cancelAnimationFrame(animate);
    observer.disconnect();
    timeline.dispose();
  }, { once: true });

  await timeline.seek(initial);
  if (signal.aborted) return;
  canvas.dataset.renderer = renderer;
  slider.disabled = false;
  play.disabled = false;
  if (status.ready()) label.hidden = true;
  performance.mark('margo-first-usable-frame');
  refreshMotion();
}

