import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { borrowedSites, readRegistry } from '../scripts/borrowed-sites.mjs';

// The class check for docs/conventions.md, "Borrowed GPU objects" (KB-RESTORE-BORROWED1): every public member that
// can hold a caller's GPUTexture, GPUTextureView, GPUSampler or GPUBuffer is ruled (its owner uses
// packages/shared/borrowed.js), exempt with a reason, or pending. Four behaviours for one device restore (a throw that
// stopped the frame loop, a console warning, silence, a stand-in) grew because each site was fixed on its own.
const root = resolve(import.meta.dirname, '..');
// Lowered by each push that rules a package's rows; it never rises, so a new option cannot land as pending.
const PENDING_AT_MOST = 9;

test('every member that can hold a caller GPU object is in the registry, and every row still exists', () => {
  const sites = borrowedSites(root),
    rows = readRegistry(root);
  assert.ok(sites.size > 200, `found ${sites.size} members`);
  const unlisted = [...sites.keys()].filter((key) => !rows[key]);
  assert.deepEqual(unlisted, [], 'rule, exempt or list these in scripts/borrowed-registry.json');
  const gone = Object.keys(rows).filter((key) => !sites.has(key));
  assert.deepEqual(gone, [], 'remove these rows from scripts/borrowed-registry.json');
});

test('each row is ruled through the shared helper, or names its reason', () => {
  for (const [key, row] of Object.entries(readRegistry(root))) {
    assert.ok(['ruled', 'exempt', 'pending'].includes(row.status), `${key}: status ${row.status}`);
    if (row.status === 'ruled') {
      assert.ok(row.source && existsSync(join(root, row.source)), `${key}: source ${row.source}`);
      assert.match(
        readFileSync(join(root, row.source), 'utf8'),
        /from '(?:\.\.\/)+shared\/(?:borrowed|texture-option)\.js'/,
        `${key}: ${row.source} must take the object through packages/shared/borrowed.js or its texture-option.js`,
      );
    } else assert.ok(row.reason?.length > 5, `${key}: a ${row.status} row needs a reason`);
  }
});

test('pending rows only shrink, and stay listed as an open known bug until none is left', () => {
  const pending = Object.values(readRegistry(root)).filter((row) => row.status === 'pending').length,
    open = /^### Open[^\n]*KB-RESTORE-BORROWED1/m.test(readFileSync(join(root, 'docs/known-bugs.md'), 'utf8'));
  assert.ok(pending <= PENDING_AT_MOST, `${pending} pending rows; at most ${PENDING_AT_MOST}`);
  assert.equal(
    open,
    pending > 0,
    pending ? 'docs/known-bugs.md needs the open KB-RESTORE-BORROWED1 entry' : 'close it',
  );
});

test('the scan finds plain forms, aliases and multi-line types, and skips functions, getters and private fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'borrowed-sites-'));
  try {
    mkdirSync(join(dir, 'api'));
    writeFileSync(
      join(dir, 'api', 'demo.api.md'),
      [
        '```ts',
        'export type Atlas = ImageBitmap | GPUTexture | ((device: GPUDevice) => GPUTexture);',
        'type Wrapped = Atlas | null;',
        'export type Getter = () => GPUTexture;',
        'export interface DemoOptions {',
        '    atlas: Wrapped;',
        '    getter?: Getter;',
        '    live?: () => GPUTexture | undefined;',
        '    count: number;',
        '    source: Float32Array | {',
        '        readonly buffer: GPUBuffer;',
        '    };',
        // A callback among an object type's members once hid the GPU property beside it; a method's GPU parameter is
        // no held object (sky's SkyFeatures.bruneton gained `extend?: (code: string) => string`).
        '    mixed?: {',
        '        readonly texture: GPUTexture;',
        '        done: () => void;',
        '    };',
        '    tables?: {',
        '        create(view: GPUTextureView, extend?: (code: string) => string): void;',
        '        readonly name: string;',
        '    };',
        '}',
        // Each of the next four once made the scan swallow, without a word, every declaration after it: a head with a
        // type parameter default, a comment line, a template literal over several lines and an enum.
        'export interface Generic<Context = unknown> extends Base<Context> {',
        '    readonly options: Context;',
        '}',
        '// Not exported from this entry, but used by the exports above:',
        'export interface AfterGeneric {',
        '    texture: GPUTextureView;',
        '}',
        'export const source = `fn f() -> u32 {',
        '  for (var i = 0; i < 2; i++) { return 1u; }',
        '}`;',
        'export enum Mode {',
        '    Off = 0,',
        '    On = 1',
        '}',
        'export namespace Group {',
        '    export interface Inner {',
        '        buffer: GPUBuffer;',
        '    }',
        '    export const count: number;',
        '}',
        'declare global {',
        '    var margoDemo: number | undefined;',
        '}',
        'export class Demo {',
        '    readonly view: GPUTextureView;',
        '    private held: GPUSampler;',
        '    get texture(): GPUTexture;',
        '    sample(view: GPUTextureView): void;',
        '}',
        '```',
      ].join('\n'),
    );
    assert.deepEqual([...borrowedSites(dir).keys()].sort(), [
      'demo:AfterGeneric.texture',
      'demo:Demo.view',
      'demo:DemoOptions.atlas',
      'demo:DemoOptions.mixed',
      'demo:DemoOptions.source',
      'demo:Group.Inner.buffer',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the scan throws on a report it cannot read, naming the file and line, instead of skipping what follows', () => {
  const cases = [
    // A head split over two lines.
    [
      ['export interface Split<T>', '    extends Base<T> {', '    texture: GPUTextureView;', '}'],
      /demo\.api\.md:2: cannot read the head/,
    ],
    // A statement that never ends before the next declaration.
    [
      ['export type Open = A |', 'export interface Next {', '    texture: GPUTextureView;', '}'],
      /demo\.api\.md:3: .* starts before/,
    ],
    // A scope the fence closes.
    [
      ['export interface Unclosed {', '    texture: GPUTextureView;'],
      /demo\.api\.md:4: the fence closes inside Unclosed/,
    ],
  ];
  for (const [body, error] of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'borrowed-sites-'));
    try {
      mkdirSync(join(dir, 'api'));
      writeFileSync(join(dir, 'api', 'demo.api.md'), ['```ts', ...body, '```'].join('\n'));
      assert.throws(() => borrowedSites(dir), error);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
