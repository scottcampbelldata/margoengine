// Audit vpt-c (2026-11-24): the learned denoiser's WGSL must compute exactly the features and network that
// scripts/train-denoise.py trained (feature order, neighbour order, scale, variance over 27 values, weight layout
// 10x16 | 16 | 16x8 | 8 | 8x1 | 1). This test is an independent transcription of the trainer's `data` features and
// `forward`, run against the shader on the CPU compute evaluator for every pixel of a 3x3 image's centre.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DENOISE_ML } from '../src/denoise-ml-shader.ts';
import { WEIGHTS } from '../src/denoise-ml-weights.ts';
import { runComputeOnCPU } from '@margoengine/webgl2-compat/compute';

const mean3 = (v) => (v[0] + v[1] + v[2]) / 3;
const sub = (a, b) => a.map((x, i) => x - b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Python trainer, numpy params[0..5] flattened row-major into WEIGHTS.
function reference(color, albedo, normal, alpha, samples) {
  const at = (arr, k, n = 3) => Array.from(arr.slice(k * n, k * n + n));
  const scale = Math.max(mean3(at(color, 4)), 0.01);
  const noisy = [...Array(9)].map((_, k) => at(color, k).map((v) => v / scale));
  const center = noisy[4],
    clum = mean3(center),
    lum = noisy.map(mean3);
  let variance = 0;
  for (const n of noisy) variance += dot(sub(n, center), sub(n, center));
  variance /= 27;
  const W = WEIGHTS;
  const scores = noisy.map((n, k) => {
    const x = (k % 3) - 1,
      y = Math.floor(k / 3) - 1,
      da = sub(at(albedo, k), at(albedo, 4)),
      d = sub(n, center);
    const f = [
      (x * x + y * y) / 2,
      Math.log1p(dot(d, d) / 3 / (1 + clum * clum)),
      dot(da, da) / 3,
      Math.min(2, Math.max(0, 1 - dot(at(normal, k), at(normal, 4)))),
      Math.log1p(variance / (1 + clum * clum)),
      clum / (1 + Math.abs(clum)),
      lum[k] / (1 + Math.abs(lum[k])),
      Math.abs(alpha[k] - alpha[4]),
      1 / Math.sqrt(samples),
      0.25,
    ];
    const h = [...Array(16)].map((_, a) =>
      Math.max(
        0,
        f.reduce((s, v, b) => s + v * W[b * 16 + a], W[160 + a]),
      ),
    );
    const j = [...Array(8)].map((_, a) =>
      Math.max(
        0,
        h.reduce((s, v, b) => s + v * W[176 + b * 8 + a], W[304 + a]),
      ),
    );
    return j.reduce((s, v, a) => s + v * W[312 + a], W[320]);
  });
  const top = Math.max(...scores),
    w = scores.map((s) => Math.exp(s - top)),
    total = w.reduce((s, v) => s + v, 0);
  return [0, 1, 2].map((c) => (noisy.reduce((s, n, k) => s + w[k] * n[c], 0) / total) * scale);
}

function shaderCentre(color, albedo, normal, alpha, samples) {
  const params = new Uint32Array([3, 3, 0, 0]);
  new Float32Array(params.buffer)[2] = samples;
  const output = new Float32Array(27);
  const bytes = (a) => new Uint8Array(a.buffer);
  runComputeOnCPU({
    source: DENOISE_ML,
    entryPoint: 'denoiseML',
    workgroups: [1, 1],
    workBudget: 10_000_000,
    buffers: new Map([
      ['0:0', bytes(params)],
      ['0:1', bytes(new Float32Array(WEIGHTS))],
      ['0:2', bytes(color)],
      ['0:3', bytes(albedo)],
      ['0:4', bytes(normal)],
      ['0:5', bytes(alpha)],
      ['0:6', bytes(output)],
    ]),
  });
  return Array.from(output.slice(12, 15));
}

test('learned denoiser WGSL matches the trainer features and network on a 3x3 neighbourhood', () => {
  let state = 132024;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0), state / 2 ** 32);
  for (let round = 0; round < 6; round++) {
    // Rounds 4 and 5 are signed, as renderImage's colour is behind dispersive glass (KB-VPT-DENOISEML-RANGE).
    const color = new Float32Array(27).map(() => (round >= 4 && random() < 0.4 ? -1 : 1) * Math.exp(4 * random() - 2)),
      albedo = new Float32Array(27).map(() => 0.02 + 0.98 * random()),
      normal = new Float32Array(27),
      alpha = new Float32Array(9).map(() => (random() < 0.3 ? 0 : 1));
    for (let k = 0; k < 9; k++) {
      const v = [random() - 0.5, random() - 0.5, random() + 0.2],
        l = Math.hypot(...v);
      normal.set(
        v.map((x) => x / l),
        k * 3,
      );
    }
    const samples = [1, 4, 16, 64][round % 4];
    const want = reference(color, albedo, normal, alpha, samples),
      got = shaderCentre(color, albedo, normal, alpha, samples);
    for (let c = 0; c < 3; c++)
      assert.ok(
        Math.abs(got[c] - want[c]) <= 1e-4 * Math.max(1, Math.abs(want[c])),
        `round ${round} c${c}: ${got[c]} vs ${want[c]}`,
      );
  }
});
