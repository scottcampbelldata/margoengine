// GPU data lab: draws 2^16..2^24 samples on the GPU (a seeded mix of two normals), then bins them (histogram), sorts
// them (CDF and quantiles) and reduces them (mean, std, min, max), and draws the result on a 2D canvas. Everything
// numeric runs in @margoengine/compute; the page only reads back the 256 bin counts and a few hundred CDF points.
import { createCompute, type ComputeContext } from '@margoengine/compute';
import { Random } from '@margoengine/compute/random';

declare global {
  interface Window {
    computeLab?: { runs: number; last?: Record<string, number> };
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('viewport'),
  status = $<HTMLParagraphElement>('status'),
  statsList = $<HTMLUListElement>('stats'),
  count = $<HTMLInputElement>('count'),
  mix = $<HTMLInputElement>('mix'),
  seed = $<HTMLInputElement>('seed');
const BINS = 256,
  CDF_POINTS = 512,
  RANGE: [number, number] = [-5, 7];

let gpu: ComputeContext | undefined;
let pending: AbortController | undefined;
let redraw: (() => void) | undefined;
window.computeLab = { runs: 0 };
window.addEventListener('pagehide', () => gpu?.dispose(), { once: true });

const label = () => {
  $<HTMLOutputElement>('countOut').textContent = `${(2 ** Number(count.value) / 1e6).toFixed(2)} M`;
  $<HTMLOutputElement>('mixOut').textContent = `${mix.value}%`;
};

async function run(): Promise<void> {
  pending?.abort();
  const controller = new AbortController();
  pending = controller;
  const signal = controller.signal;
  gpu ??= await createCompute();
  const n = 2 ** Number(count.value),
    share = Number(mix.value) / 100,
    rng = new Random(gpu, { seed: Math.max(0, Math.floor(Number(seed.value) || 0)) });
  const t0 = performance.now();
  // A mixture: N(0, 1) and, with probability `share`, N(3, 0.6), chosen per sample by a uniform draw.
  const a = rng.normal(n),
    b = rng.normal(n, { mean: 3, std: 0.6 }),
    pick = rng.uniform(n);
  const samples = gpu.where(pick.lt(share), b, a).eval();
  for (const x of [a, b, pick]) x.dispose();
  const hist = gpu.histogram(samples, { bins: BINS, range: RANGE });
  const sorted = gpu.sort(samples);
  // Evenly spaced order statistics for the CDF line, and the quartiles.
  // The order-statistic indices are a lazy expression over the spaced array: take() evaluates it, and only the spaced
  // array (a GpuArray) needs disposing.
  const spaced = gpu.linspace(0, n - 1, CDF_POINTS);
  const cdf = gpu.take(sorted, spaced.round().astype('i32'));
  const quartiles = gpu.quantile(samples, [0.25, 0.5, 0.75]);
  const mean = samples.mean(),
    std = samples.std(),
    lo = samples.min(),
    hi = samples.max();
  const [counts, curve, q, m, s, minimum, maximum] = await Promise.all([
    hist.counts.read({ signal }),
    cdf.read({ signal }),
    quartiles.read({ signal }),
    mean.item({ signal }),
    std.item({ signal }),
    lo.item({ signal }),
    hi.item({ signal }),
  ]);
  const ms = performance.now() - t0;
  for (const x of [samples, hist.counts, hist.edges, sorted, spaced, cdf, quartiles, mean, std, lo, hi]) x.dispose();
  if (signal.aborted) return;
  redraw = () => draw(counts as Uint32Array, curve as Float32Array, n);
  redraw();
  const last = { samples: n, mean: m, std: s, min: minimum, max: maximum, q1: q[0], median: q[1], q3: q[2], ms };
  window.computeLab = { runs: window.computeLab!.runs + 1, last };
  const fmt = (v: number) => v.toFixed(3);
  statsList.replaceChildren(
    ...[
      ['Samples', n.toLocaleString('en')],
      ['Mean', fmt(m)],
      ['Std', fmt(s)],
      ['Median', fmt(q[1])],
      ['Quartiles', `${fmt(q[0])} · ${fmt(q[2])}`],
      ['Range', `${fmt(minimum)} … ${fmt(maximum)}`],
      ['GPU work + readback', `${ms.toFixed(1)} ms`],
    ].map(([k, v]) => {
      const li = document.createElement('li'),
        bold = document.createElement('b');
      bold.textContent = k;
      li.append(bold, v);
      return li;
    }),
  );
  status.textContent = `Drew ${n.toLocaleString('en')} samples, binned, sorted and summarised on the GPU.`;
  canvas.dataset.ready = 'true';
}

function draw(counts: Uint32Array, curve: Float32Array, n: number): void {
  const dpr = Math.min(devicePixelRatio || 1, 2),
    w = Math.round(canvas.clientWidth * dpr),
    h = Math.round(canvas.clientHeight * dpr);
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!,
    pad = 36 * dpr,
    plotW = w - 2 * pad,
    plotH = h - 2 * pad,
    x = (v: number) => pad + ((v - RANGE[0]) / (RANGE[1] - RANGE[0])) * plotW;
  g.fillStyle = '#080c12';
  g.fillRect(0, 0, w, h);
  let peak = 1;
  for (const c of counts) peak = Math.max(peak, c);
  // Bars: the histogram, scaled to the tallest bin.
  const barW = plotW / counts.length;
  const fill = g.createLinearGradient(0, pad, 0, pad + plotH);
  fill.addColorStop(0, '#7bd3ff');
  fill.addColorStop(1, '#2f5d9e');
  g.fillStyle = fill;
  counts.forEach((c, k) => {
    const bh = (c / peak) * plotH;
    g.fillRect(pad + k * barW, pad + plotH - bh, Math.max(1, barW - dpr * 0.5), bh);
  });
  // CDF: order statistic i of n sits at height i / (n - 1).
  g.strokeStyle = '#ffd885';
  g.lineWidth = 2 * dpr;
  g.beginPath();
  curve.forEach((v, k) => {
    const px = Math.min(Math.max(x(v), pad), pad + plotW),
      py = pad + plotH - (k / (curve.length - 1)) * plotH;
    if (k) g.lineTo(px, py);
    else g.moveTo(px, py);
  });
  g.stroke();
  // Axes and ticks every unit.
  g.strokeStyle = '#3a4658';
  g.lineWidth = dpr;
  g.strokeRect(pad, pad, plotW, plotH);
  g.fillStyle = '#93a4bd';
  g.font = `${12 * dpr}px system-ui, sans-serif`;
  g.textAlign = 'center';
  for (let v = RANGE[0]; v <= RANGE[1]; v++) g.fillText(String(v), x(v), pad + plotH + 18 * dpr);
  g.textAlign = 'left';
  g.fillText(
    `histogram (${counts.length} bins, peak ${peak.toLocaleString('en')} of ${n.toLocaleString('en')})`,
    pad + 8 * dpr,
    pad + 18 * dpr,
  );
  g.fillStyle = '#ffd885';
  g.fillText('cumulative distribution', pad + 8 * dpr, pad + 36 * dpr);
}

const rerun = () => {
  label();
  run().catch((error: Error) => {
    if (error.name !== 'AbortError') status.textContent = `Could not compute: ${error.message}`;
  });
};
for (const input of [count, mix, seed]) input.addEventListener('change', rerun);
for (const input of [count, mix]) input.addEventListener('input', label);
$<HTMLButtonElement>('run').addEventListener('click', rerun);
// Resizing redraws the last result; it does not recompute.
new ResizeObserver(() => redraw?.()).observe(canvas);
rerun();
