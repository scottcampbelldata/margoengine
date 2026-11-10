import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  allowedBreak,
  assessChange,
  checkCoverage,
  classify,
  declarationHash,
  parseReport,
  readLock,
} from '../scripts/api-lock.mjs';

const root = resolve(import.meta.dirname, '..');
const report = (body) => `## API Report File for "@margoengine/example"\n\n\`\`\`ts\n${body}\n\`\`\`\n`;
const compare = (a, b) => classify(report(a), report(b));
const lock = {
  locked: ['@margoengine/core', '@margoengine/stage'],
  watch: ['@margoengine/example'],
  internal: [],
  ticked: {},
};

test('removals, renames, parameter edits, aliases, consts and local types are breaking', () => {
  for (const [a, b] of [
    ['export function run(x: number): void;', ''],
    ['export function run(x: number): void;', 'export function start(x: number): void;'],
    ['export function run(x: number): void;', 'export function run(x: string): void;'],
    ['export function run(x?: number): void;', 'export function run(x: number): void;'],
    ['export function run(): void;', 'export function run(x: number): void;'],
    ['export { A as B };', 'export { A as C };'],
    ['export const n: number;', 'export const n: string;'],
    ['type Hidden = number;', 'type Hidden = string;'],
    ['export type Options = { x: number };', 'export type Options = { x?: number };'],
    ['export const f: (x: number) => void;', 'export const f: (x?: number) => void;'],
    ['export function f(): { x: number };', 'export function f(): { x?: number };'],
    ['export interface X { data: { x: number }; }', 'export interface X { data: { x?: number }; }'],
    ['export function f(cb: (x: number) => void): void;', 'export function f(cb: (x?: number) => void): void;'],
    ['declare global { var x: number; }', 'declare global { var x: string; }'],
    ['export interface X { x: number; }', 'export interface X { readonly x: number; }'],
    ['export interface X { x: number; }', 'interface X { x: number; }'],
    ['export enum E { A = 0, B = 1 }', 'export enum E { A = 0 }'],
  ])
    assert.ok(compare(a, b).breaking.length, `${a} -> ${b}`);
});

test('members are matched by name, split at depth, and retain overloads', () => {
  assert.equal(
    parseReport(report('export class C { get(): void; readonly: number; }')).items.get('class:C')[0].members.size,
    2,
  );
  const a = 'export class C { x: { a: string; b: number; }; run(x: number): void; run(x: string): void; }';
  assert.equal(compare(a, 'export class C { x: { a: string; b: number; }; run(x: number): void; }').breaking.length, 1);
  assert.equal(compare(a, a.replace('run(x: number): void;', 'run(x: boolean): void;')).breaking.length, 1);
  assert.equal(compare(a, a.replace('x: { a: string; b: number; };', '')).breaking[0].symbol, 'C.x');
  assert.equal(
    compare(a, 'export class C { run(x: string): void; x: { a: string; b: number; }; run(x: number): void; }').breaking
      .length,
    0,
  );
  assert.equal(compare(a, a.replace('b: number', 'b: boolean')).breaking.length, 1);
});

test('exports, members, enum values, overloads, optional relaxations and local type promotion are compatible', () => {
  for (const [a, b] of [
    ['', 'export type New = number;'],
    ['export class C { x: number; }', 'export class C { x: number; y: string; }'],
    ['export enum E { A = 0 }', 'export enum E { A = 0, B = 1 }'],
    ['export function f(x: number): void;', 'export function f(x: string): void; export function f(x: number): void;'],
    ['export function f(x: number): void;', 'export function f(x?: number): void;'],
    ['export interface X { x: number; }', 'export interface X { x?: number; }'],
    [
      'export function f(x: number): void;',
      'export function f(x: number, y?: { a: number; b: string; }, z?: (v: string) => void): void;',
    ],
    ['export function f(): void;', 'export function f(x?: number): void;'],
    ['type Local = number;', 'export type Local = number;'],
    ['import { A } from "a"; export type T = A;', 'import { A } from "b"; export type T = A;'],
  ])
    assert.equal(compare(a, b).breaking.length, 0, `${a} -> ${b}`);
  for (const b of [
    'export function f(x: number, y?: string, z: number): void;',
    'export function f(x: number, y: string): void;',
  ])
    assert.ok(compare('export function f(x: number): void;', b).breaking.length);
});

test('a break approval binds entry, symbol, old declaration hash, change and Scott approval', () => {
  const old = 'export function f(x: number): void;';
  const item = compare(old, 'export function f(x: string): void;').breaking[0];
  assert.equal(item.was, declarationHash(old));
  const approval = {
    entry: '@margoengine/core',
    ...item,
    reason: 'Scott requested this contract',
    date: '2026-11-10',
    approved: 'Scott 2026-11-10',
  };
  assert.equal(allowedBreak([approval], approval.entry, item), true);
  for (const changed of [
    { was: '00000000' },
    { symbol: 'g' },
    { entry: 'other' },
    { change: 'removed' },
    { approved: '' },
    { reason: '' },
  ])
    assert.equal(allowedBreak([{ ...approval, ...changed }], approval.entry, item), false);
  const second = compare('export function f(x: string): void;', 'export function f(x: boolean): void;').breaking[0];
  assert.equal(allowedBreak([approval], approval.entry, second), false);
  assert.equal(
    assessChange(lock, [], '@margoengine/core', approval.entry, { breaking: [item], additive: [] }, true).fail,
    true,
  );
  assert.equal(
    assessChange(lock, [approval], '@margoengine/core', approval.entry, { breaking: [item], additive: [] }, true).fail,
    false,
  );
});

test('watch warns and passes; locked updates reject breaks and accept additions; unlocked diffs need update', () => {
  const changes = compare('export type A = number;', 'export type A = string;');
  const watched = assessChange(lock, [], '@margoengine/example', '@margoengine/example/subpath', changes);
  assert.equal(watched.fail, false);
  assert.match(watched.lines[0], /^would fail: .*A \(type\).*"was":"[a-f0-9]{8}"/);
  assert.equal(assessChange(lock, [], '@margoengine/core', '@margoengine/core/new-entry', changes, true).fail, true);
  const addition = compare('', 'export type A = string;');
  assert.equal(assessChange(lock, [], '@margoengine/core', '@margoengine/core', addition, true).fail, false);
  assert.match(
    assessChange(lock, [], '@margoengine/core', '@margoengine/core', addition).lines[0],
    /additive; run api:update/,
  );
  assert.equal(assessChange(lock, [], 'unlisted', 'unlisted', addition).fail, true);
});

test('Day 0 locks core/stage, watches every other report package, and keeps TSDoc baseline at zero', () => {
  const actual = readLock(root);
  assert.deepEqual(actual.locked, ['@margoengine/core', '@margoengine/stage']);
  assert.deepEqual(
    Object.keys(JSON.parse(readFileSync(join(root, 'scripts/quality/baselines/api.json'))).items).filter((key) =>
      key.startsWith('tsdoc '),
    ),
    [],
  );
  for (const file of readdirSync(join(root, 'api')).filter((f) => f.endsWith('.api.md'))) {
    const text = readFileSync(join(root, 'api', file), 'utf8');
    const entry = text.match(/^## API Report File for "([^"]+)"/m)[1];
    const name = entry.startsWith('@') ? entry.split('/').slice(0, 2).join('/') : entry.split('/')[0];
    assert.ok(actual.locked.includes(name) || actual.watch.includes(name), name);
    const parsed = parseReport(text);
    assert.deepEqual(parsed.leftover, [], file);
    assert.ok(parsed.items.size, file);
    assert.deepEqual(classify(text, text), { breaking: [], additive: [] }, file);
  }
});

test('parser preserves strings, generic constraints, merged kinds and local types; invalid syntax fails closed', () => {
  const text = report(
    'export interface X<T extends { x: string }> { value: T; text: "a;}{"; }\nexport const X: number;\n// Not exported\ntype Local = `x${number}`;',
  );
  const parsed = parseReport(text);
  assert.deepEqual(parsed.leftover, []);
  assert.equal(parsed.items.size, 3);
  assert.deepEqual(parseReport('no block').leftover, ['missing TypeScript block']);
  assert.throws(() => compare('export class C {', ''), /Unclosed/);
  assert.throws(() => compare('unrecognised stuff;', ''), /Unparsed/);
});

test('exports coverage rejects missing manifests, missing exports, reports, unresolved lines and orphan reports', (t) => {
  const temp = mkdtempSync(join(root, 'test-results/api-lock-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  mkdirSync(join(temp, 'packages', 'example'), { recursive: true });
  const manifest = join(temp, 'packages/example/package.json');
  assert.match(checkCoverage(temp, lock, new Map())[0], /missing package.json/);
  assert.deepEqual(checkCoverage(temp, { ...lock, internal: ['packages/example'] }, new Map()), []);
  writeFileSync(manifest, JSON.stringify({ name: '@margoengine/example' }));
  assert.match(checkCoverage(temp, lock, new Map())[0], /missing exports/);
  writeFileSync(
    manifest,
    JSON.stringify({ name: '@margoengine/example', exports: { '.': './index.js', './new': './new.js' } }),
  );
  assert.equal(checkCoverage(temp, lock, new Map()).length, 2);
  const reports = new Map([
    ['example.api.md', report('export type T = number;')],
    ['example.new.api.md', report('export { X }; // unresolved')],
  ]);
  assert.match(checkCoverage(temp, lock, reports)[0], /unresolved/);
  reports.set('example.new.api.md', report('export type X = number;'));
  assert.deepEqual(checkCoverage(temp, lock, reports), []);
  reports.set('orphan.api.md', report('export type X = number;'));
  assert.match(checkCoverage(temp, lock, reports)[0], /entry no longer exists/);
});

test('report command classifies before any update writes and checks coverage before exit', () => {
  const source = readFileSync(join(root, 'scripts/api-report.js'), 'utf8');
  const hook = source.indexOf('const changes = classify(');
  assert.ok(hook > source.indexOf('// Write or compare.'));
  assert.ok(hook < source.indexOf('if (update) {', hook));
  assert.ok(source.indexOf('if (lockProblems.length) {', hook) < source.indexOf('if (update) {', hook));
  assert.match(source, /checkCoverage\(root, lock, coverageReports\)/);
  assert.match(source, /generated report has no TypeScript block or has an unresolved export/);
});
