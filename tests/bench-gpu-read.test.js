// The benchmark GPU quiet gate reads NVIDIA load with nvidia-smi. When nvidia-smi gave nothing, the error was swallowed
// and the gate recorded only `checked: false`, so a run marked invalid for it could not say why (biomes G1 run at
// a56903ca9, 2026-11-01). The query now returns nvidia-smi's own failure and the gate records it as the reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nvidiaSmi } from '../bench/lib/env.mjs';
import { gpuIdle } from '../bench/lib/gate.mjs';

const failing = (props) => () => {
  throw Object.assign(new Error('spawn failed'), props);
};

test('nvidiaSmi reads name, driver and utilisation', () => {
  const r = nvidiaSmi(() => 'NVIDIA RTX A6000, 581.42, 3\n');
  assert.equal(r.error, undefined);
  assert.deepEqual(r.gpus, [
    { name: 'NVIDIA RTX A6000', driver: '581.42', utilizationPercent: 3, source: 'nvidia-smi' },
  ]);
});

test('nvidiaSmi says why it has no reading: missing, timed out, failed, silent or no utilisation', () => {
  const cases = [
    [failing({ code: 'ENOENT' }), /not found on PATH/],
    [failing({ code: 'ETIMEDOUT', signal: 'SIGTERM', status: null }), /did not finish within 20 s \(SIGTERM\)/],
    [
      failing({ status: 9, stderr: "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.\n" }),
      /exited 9: NVIDIA-SMI has failed because it couldn't communicate/,
    ],
    [failing({ code: 'EPERM' }), /could not run: EPERM/],
    [() => '\n', /printed nothing/],
    [() => 'NVIDIA RTX A6000, 581.42, [N/A]\n', /no utilisation reading: "NVIDIA RTX A6000, 581.42, \[N\/A\]"/],
  ];
  for (const [exec, why] of cases) {
    const r = nvidiaSmi(exec);
    assert.match(r.error, why);
    assert.ok(!r.gpus.some((g) => Number.isFinite(g.utilizationPercent)));
  }
  assert.match(nvidiaSmi(failing({ code: 'ENOENT' })).error, /command: nvidia-smi --query-gpu=/);
});

test('the GPU quiet gate records nvidia-smi failure as its reason', async () => {
  const error = 'nvidia-smi exited 9: driver not loaded (command: nvidia-smi --query-gpu=...)';
  assert.deepEqual(
    await gpuIdle(
      20,
      1,
      () => {},
      () => ({ gpus: [], error }),
    ),
    { checked: false, reason: error },
  );
});
