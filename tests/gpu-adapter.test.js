import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chooseAdapter,
  gpuAdapterArg,
  lastAdapterChoice,
  listAdapters,
  parseAdapters,
} from '../scripts/lib/gpu-adapter.mjs';

// The adapter order seen on the two-GPU PC with no display output (bug 33): AMD first, then the NVIDIA card.
const OUTPUT = [
  'ADAPTER|AMD Radeon(TM) Graphics|4098|5056|536870912|0|90115|0',
  'ADAPTER|NVIDIA RTX A6000|4318|8752|51539607552|0|79477|0',
  'ADAPTER|Microsoft Basic Render Driver|5140|140|0|0|88885|2',
  'ADAPTER|Microsoft Basic Render Driver|5140|140|0|0|88886|1',
  'not an adapter line',
].join('\r\n');
const adapters = parseAdapters(OUTPUT);
const NVIDIA = '--use-adapter-luid=0,79477';
const AMD = '--use-adapter-luid=0,90115';

test('parseAdapters reads decimal LUIDs, video memory and the software flag, and skips other lines', () => {
  assert.deepEqual(
    adapters.map((a) => [a.name, a.high, a.low, a.software]),
    [
      ['AMD Radeon(TM) Graphics', '0', '90115', false],
      ['NVIDIA RTX A6000', '0', '79477', false],
      ['Microsoft Basic Render Driver', '0', '88885', true],
      ['Microsoft Basic Render Driver', '0', '88886', true],
    ],
  );
  assert.deepEqual(parseAdapters(''), []);
  assert.deepEqual(parseAdapters(undefined), []);
});

test('two hardware adapters: the one with the most video memory wins, whatever order Windows lists them in', () => {
  assert.equal(chooseAdapter(adapters, {}).arg, NVIDIA);
  assert.equal(chooseAdapter([...adapters].reverse(), {}).arg, NVIDIA);
});

test('one hardware adapter, or only software adapters, adds no flag', () => {
  assert.equal(chooseAdapter(adapters.slice(1, 2), {}).arg, undefined);
  assert.equal(chooseAdapter(adapters.slice(2), {}).arg, undefined);
  assert.equal(chooseAdapter([], {}).arg, undefined);
});

test('MARGO_GPU prefers a vendor, warns about an unknown value or a missing vendor, and default adds no flag', () => {
  assert.equal(chooseAdapter(adapters, { MARGO_GPU: 'amd' }).arg, AMD);
  assert.equal(chooseAdapter(adapters, { MARGO_GPU: ' NVIDIA ' }).arg, NVIDIA);
  assert.equal(chooseAdapter(adapters, { MARGO_GPU: 'default' }).arg, undefined);
  const warnings = [];
  assert.equal(chooseAdapter(adapters, { MARGO_GPU: 'intel' }, (w) => warnings.push(w)).arg, NVIDIA);
  assert.equal(chooseAdapter(adapters, { MARGO_GPU: 'banana' }, (w) => warnings.push(w)).arg, NVIDIA);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /no intel hardware adapter/);
  assert.match(warnings[1], /not default, nvidia, amd or intel/);
});

test('MARGO_GPU_LUID is used as given, wins over MARGO_GPU, and a malformed value is ignored with a warning', () => {
  assert.equal(chooseAdapter(adapters, { MARGO_GPU_LUID: '1,2', MARGO_GPU: 'amd' }).arg, '--use-adapter-luid=1,2');
  const warnings = [];
  assert.equal(chooseAdapter(adapters, { MARGO_GPU_LUID: '0x0,0x16003' }, (w) => warnings.push(w)).arg, NVIDIA);
  assert.match(warnings[0], /decimal/);
});

test('gpuAdapterArg: a failed lookup prints one warning and adds no flag, never throws', () => {
  const warnings = [];
  const arg = gpuAdapterArg({
    env: {},
    list: () => {
      throw new Error('powershell.exe not found\nsecond line');
    },
    warn: (w) => warnings.push(w),
  });
  assert.equal(arg, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /GPU lookup failed \(powershell.exe not found\)/);
  assert.match(lastAdapterChoice(), /lookup failed/);
});

test('gpuAdapterArg: MARGO_GPU_LUID and MARGO_GPU=default never run the lookup', () => {
  const list = () => assert.fail('lookup ran');
  assert.equal(gpuAdapterArg({ env: { MARGO_GPU_LUID: '0,5' }, list }), '--use-adapter-luid=0,5');
  assert.equal(gpuAdapterArg({ env: { MARGO_GPU: 'default' }, list }), undefined);
  assert.equal(gpuAdapterArg({ env: {}, list: () => adapters }), NVIDIA);
  assert.match(lastAdapterChoice(), /nvidia NVIDIA RTX A6000/);
});

test('listAdapters caches in a temp file by boot time: the second call does not run PowerShell', () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-gpu-test-'));
  try {
    let runs = 0;
    const spawn = () => (runs++, { status: 0, stdout: OUTPUT });
    const options = { spawn, dir, useProcessCache: false, bootAt: 1, now: 1_000_000 };
    assert.equal(listAdapters(options).length, 4);
    assert.equal(listAdapters({ ...options, now: 1_000_500 }).length, 4);
    assert.equal(runs, 1, 'cache hit');
    listAdapters({ ...options, bootAt: 2 });
    assert.equal(runs, 2, 'a new boot looks up again');
    listAdapters({ ...options, bootAt: 2, now: 1_000_000 + 31 * 60_000 });
    assert.equal(runs, 3, 'an old cache looks up again');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listAdapters throws a short message when PowerShell fails or prints an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-gpu-test-'));
  try {
    const base = { dir, useProcessCache: false, bootAt: 99 };
    assert.throws(() => listAdapters({ ...base, spawn: () => ({ error: new Error('spawn ENOENT') }) }), /ENOENT/);
    assert.throws(
      () => listAdapters({ ...base, spawn: () => ({ status: 0, stdout: 'ERROR CreateDXGIFactory1 hr=1' }) }),
      /CreateDXGIFactory1/,
    );
    assert.throws(
      () => listAdapters({ ...base, spawn: () => ({ status: 1, stdout: '', stderr: 'bad\nmore' }) }),
      /bad/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
