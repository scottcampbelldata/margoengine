import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { acPower, powerOnlineText, requireAC } from '../examples/package-benchmarks/parts/power.mjs';

function probe(t, { platform = 'win32', stdout = 'Online\r\n', error } = {}) {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform'),
    allowance = process.env.BENCH_ALLOW_BATTERY,
    calls = [];
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
  delete process.env.BENCH_ALLOW_BATTERY;
  t.mock.method(childProcess, 'execFileSync', (...args) => {
    calls.push(args);
    if (error) throw error;
    return stdout;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', originalPlatform);
    if (allowance === undefined) delete process.env.BENCH_ALLOW_BATTERY;
    else process.env.BENCH_ALLOW_BATTERY = allowance;
  });
  return calls;
}

test('Online power-line status records AC power, including on desktops without batteries', (t) => {
  probe(t);
  assert.equal(acPower(), true);
  assert.equal(requireAC(), true);
});

test('Offline power-line status records battery power and still refuses benchmark timing', (t) => {
  probe(t, { stdout: 'Offline\r\n' });
  assert.equal(acPower(), false);
  assert.throws(() => requireAC(), /On battery/);
});

test('power-line output ignores surrounding whitespace', (t) => {
  probe(t, { stdout: ' \r\nOnline\t ' });
  assert.equal(acPower(), true);
});

for (const stdout of ['Unknown', '', ' \r\n ', 'NoSystemBattery', 'True', 'False'])
  test(`unrecognized power-line output ${JSON.stringify(stdout)} stays unknown`, (t) => {
    probe(t, { stdout });
    assert.equal(acPower(), null);
    assert.equal(requireAC(), null);
  });

test('a failed Windows power query stays unknown instead of reporting battery power', (t) => {
  probe(t, { error: new Error('Power query failed') });
  assert.equal(acPower(), null);
  assert.equal(requireAC(), null);
});

test('non-Windows platforms remain unknown without launching PowerShell', (t) => {
  const calls = probe(t, { platform: 'linux' });
  assert.equal(acPower(), null);
  assert.equal(requireAC(), null);
  assert.equal(calls.length, 0);
});

test('Windows queries the power line with terminating errors and quiet captured output', (t) => {
  const calls = probe(t);
  acPower();
  const [command, args, options] = calls[0];
  assert.equal(command, 'powershell');
  assert.ok(args.includes('-NoProfile'));
  assert.ok(args.includes('-NonInteractive'));
  const query = args[args.indexOf('-Command') + 1];
  assert.match(query, /System\.Windows\.Forms/);
  assert.match(query, /PowerStatus\)?\.PowerLineStatus/);
  assert.match(query, /-ErrorAction Stop/);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'ignore']);
});

test('powerOnlineText: no battery (desktop) is mains, mains is mains, battery is refused', (t) => {
  // A desktop with no battery reports an Online power line; it must never read as battery.
  probe(t, { stdout: 'Online\r\n' });
  assert.equal(powerOnlineText(), 'True');
  probe(t, { stdout: 'Offline\r\n' });
  assert.equal(powerOnlineText(), 'False');
  probe(t, { error: new Error('no power class') });
  assert.equal(powerOnlineText(), 'Unknown');
});

test('no benchmark script reads the battery-only WMI class, which is empty on desktops', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../examples/package-benchmarks/', import.meta.url);
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.mjs')))
    assert.doesNotMatch(readFileSync(new URL(name, dir), 'utf8'), /BatteryStatus/, name);
  assert.doesNotMatch(readFileSync(new URL('../scripts/quiet-gate.mjs', import.meta.url), 'utf8'), /BatteryStatus/);
});
