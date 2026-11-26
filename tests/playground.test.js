// The playground's projects, share links (versioned), version history, run message, policies and message schema
// (site/playground/share.js, site/_headers), and its templates against margoengine's import map. The page itself:
// tests/browser/playground.test.js.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import {
  CHANNEL,
  LINK_VERSION,
  MAX_CODE_BYTES,
  MAX_FILES,
  MAX_LINK_CHARS,
  MAX_SNAPSHOTS,
  STORE_KEY,
  addSnapshot,
  codeFromHash,
  decodeProject,
  downloadDocument,
  encodeProject,
  parseFrameMessage,
  readStore,
  runMessage,
  scriptText,
  single,
  writeStore,
} from '../site/playground/share.js';
import { templates } from '../site/playground/templates.js';
import { headersFor, parseHeaders } from '../scripts/support/headers.mjs';

const linkError = (pattern) => (error) =>
  error.name === 'MargoError' && error.code === 'playground-link' && pattern.test(error.message);
const two = [
  { name: 'main.js', code: "import {x} from './util.js';\nconsole.log(x);\n" },
  { name: 'util.js', code: 'export const x = 1;\n' },
];
// A version 2 link of any JSON payload, for malformed-content cases.
const v2 = (value) =>
  Buffer.concat([Buffer.of(LINK_VERSION), deflateRawSync(Buffer.from(JSON.stringify(value)))]).toString('base64url');

test('a share link round-trips the files exactly, Unicode and line endings included', async () => {
  for (const files of [
    single("import {createStage} from 'margoengine';\r\nconsole.log('héllo, 世界 🎲');\n"),
    templates[0].files,
    templates.find((t) => t.id === 'modules').files,
    two,
    single('x'.repeat(100_000)),
  ]) {
    const text = await encodeProject(files);
    assert.match(text, /^[A-Za-z0-9_-]+$/, 'base64url without padding');
    assert.equal(Buffer.from(text, 'base64url')[0], LINK_VERSION, 'the version byte comes first');
    assert.deepEqual(await decodeProject(text), files);
  }
  // Deflate does the work: a template compresses well below its own length.
  assert.ok((await encodeProject(templates[0].files)).length < templates[0].files[0].code.length);
  const a = await encodeProject(single('a'));
  assert.equal(codeFromHash(`#code=${a}&embed`), a);
  assert.equal(codeFromHash('#other=1'), null);
  assert.equal(codeFromHash(''), null);
});

test('a version 1 link (deflate of main.js alone) still opens, and a newer version says so', async () => {
  const code = "// From the first playground\nconsole.log('v1');\n";
  assert.deepEqual(await decodeProject(deflateRawSync(Buffer.from(code)).toString('base64url')), single(code));
  // The version byte is a reserved deflate block type, so no version 1 link starts with it.
  assert.equal(LINK_VERSION & 0b110, 0b110);
  await assert.rejects(decodeProject(Buffer.of(0x0f, 1, 2, 3).toString('base64url')), linkError(/newer playground/));
});

test('share links are capped both ways and bad input rejects with a clear coded error', async () => {
  await assert.rejects(encodeProject(single('x'.repeat(MAX_CODE_BYTES + 1))), linkError(/at most 262144/));
  await assert.rejects(decodeProject('A'.repeat(MAX_LINK_CHARS + 1)), linkError(/limit is 65536/));
  await assert.rejects(decodeProject(''), linkError(/no code/));
  await assert.rejects(decodeProject('abc$%'), linkError(/not base64url/));
  await assert.rejects(decodeProject('abcde'), linkError(/not base64url/));
  // Valid base64url that is not deflate data.
  await assert.rejects(
    decodeProject(Buffer.of(0x01, 0x02, 0x03).toString('base64url')),
    linkError(/does not decompress/),
  );
  // A truncated link: the deflate stream ends early.
  const whole = await encodeProject(templates[1].files);
  await assert.rejects(decodeProject(whole.slice(0, (whole.length >> 3) << 2)), linkError(/does not decompress/));
  // A small link that inflates past the cap (a decompression bomb) stops at the cap.
  const big = deflateRawSync(Buffer.alloc(MAX_CODE_BYTES * 8, 97)).toString('base64url');
  assert.ok(big.length < MAX_LINK_CHARS);
  await assert.rejects(decodeProject(big), linkError(/expands past 262144/));
  // Bytes that are not UTF-8.
  await assert.rejects(
    decodeProject(deflateRawSync(Buffer.from([0xff, 0xfe, 0xc0])).toString('base64url')),
    linkError(/UTF-8/),
  );
  // Version 2 content that is not a valid project.
  await assert.rejects(decodeProject(v2({ files: 1 })), linkError(/not readable/));
  await assert.rejects(decodeProject(v2([['util.js', 'x']])), linkError(/first file must be main\.js/));
  await assert.rejects(
    decodeProject(
      v2([
        ['main.js', 'a'],
        ['../evil.js', 'b'],
      ]),
    ),
    linkError(/name such as util\.js/),
  );
  await assert.rejects(
    decodeProject(
      v2([
        ['main.js', 'a'],
        ['main.js', 'b'],
      ]),
    ),
    linkError(/two files/),
  );
  await assert.rejects(decodeProject(v2([['main.js', 7]])), linkError(/code as text/));
  const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => [i ? `f${i}.js` : 'main.js', '']);
  await assert.rejects(decodeProject(v2(many)), linkError(/1 to 12 files/));
  await assert.rejects(encodeProject(many.map(([name, code]) => ({ name, code }))), TypeError);
});

test('the version history keeps the newest snapshots first, skips repeats and caps its length', () => {
  let history = [];
  history = addSnapshot(history, single('// First\na()'), 1);
  history = addSnapshot(history, single('// First\na()'), 2);
  assert.equal(history.length, 1, 'the same files twice are one snapshot');
  history = addSnapshot(history, single('\n\n  b()\n'), 3);
  history = addSnapshot(history, two, 4);
  assert.deepEqual(
    history.map((s) => [s.time, s.title]),
    [
      [4, "import {x} from './util.js'; (2 files)"],
      [3, 'b()'],
      [1, 'First'],
    ],
  );
  assert.deepEqual(history[0].files, two);
  for (let i = 0; i < MAX_SNAPSHOTS + 10; i++) history = addSnapshot(history, single(`v${i}`), 10 + i);
  assert.equal(history.length, MAX_SNAPSHOTS);
  assert.equal(history[0].files[0].code, `v${MAX_SNAPSHOTS + 9}`);
  assert.equal(history.at(-1).files[0].code, 'v10');
});

test('the store survives missing, malformed, old-format and full storage', () => {
  const memory = (limit = Infinity) => {
    const data = new Map();
    return {
      data,
      getItem: (key) => data.get(key) ?? null,
      setItem(key, value) {
        if (value.length > limit) throw new DOMException('full', 'QuotaExceededError');
        data.set(key, value);
      },
    };
  };
  assert.deepEqual(readStore(memory()), { current: null, history: [] });
  const bad = memory();
  bad.data.set(STORE_KEY, '{not json');
  assert.deepEqual(readStore(bad), { current: null, history: [] });
  bad.data.set(
    STORE_KEY,
    JSON.stringify({
      current: 5,
      history: [{ code: 'a', time: 1, title: 'a' }, { code: 7 }, { files: [], time: 2, title: 'b' }],
    }),
  );
  // The first playground saved one code string: it reads as a one-file project.
  assert.deepEqual(readStore(bad), { current: null, history: [{ files: single('a'), time: 1, title: 'a' }] });
  bad.data.set(STORE_KEY, JSON.stringify({ current: 'old code', history: [] }));
  assert.deepEqual(readStore(bad).current, single('old code'));
  const blocked = {
    getItem: () => {
      throw new DOMException('blocked', 'SecurityError');
    },
  };
  assert.deepEqual(readStore(blocked), { current: null, history: [] });

  const store = memory();
  const history = [3, 2, 1].reduce((h, i) => addSnapshot(h, single(`code ${i}`), i), []);
  assert.deepEqual(writeStore(store, { current: two, history }), history);
  assert.deepEqual(readStore(store), { current: two, history });
  // Full storage: the oldest snapshots go first until the state fits.
  const small = memory(JSON.stringify({ current: two, history: history.slice(0, 2) }).length);
  assert.deepEqual(writeStore(small, { current: two, history }), history.slice(0, 2));
  assert.equal(writeStore(memory(5), { current: two, history }), null);
});

test('the run message and the download carry the files safely', () => {
  const files = [{ name: 'main.js', code: "console.log('</script><!-- x');\nthrow new Error('two');" }, two[1]];
  assert.deepEqual(runMessage(files, 'http://127.0.0.1:5180/node_modules/'), {
    channel: CHANNEL,
    kind: 'run',
    files,
    packages: 'http://127.0.0.1:5180/node_modules/',
  });
  assert.equal(runMessage(files).packages, null);
  assert.throws(() => runMessage(files, '/node_modules/'), TypeError);
  assert.throws(() => runMessage(files, 'javascript:alert(1)//'), TypeError);
  assert.throws(() => runMessage([two[1]]), TypeError);
  const frameHtml = readFileSync(new URL('../site/playground/frame/index.html', import.meta.url), 'utf8');
  const html = downloadDocument(frameHtml, files);
  assert.equal(
    html.match(/<\/script>/gi).length,
    frameHtml.match(/<\/script>/gi).length + 1,
    'the code cannot end its element',
  );
  assert.ok(html.includes(scriptText(JSON.stringify(runMessage(files)))));
  assert.ok(html.indexOf('window.MARGO_PLAYGROUND') < html.indexOf("const CHANNEL = 'margo-playground'"));
  assert.throws(() => downloadDocument('<html></html>', files), /marker/);
  assert.ok(frameHtml.includes('<meta http-equiv="Content-Security-Policy"'));
  assert.ok(!html.includes('<meta http-equiv="Content-Security-Policy"'), 'a saved file is the visitor own page');
});

test('the playground page keeps a strict policy; only the sandboxed run frame gets the loose one', () => {
  const rules = parseHeaders(readFileSync(new URL('../site/_headers', import.meta.url), 'utf8'));
  const policy = (path) =>
    Object.fromEntries(
      headersFor(rules, path)
        .get('content-security-policy')
        .split(';')
        .map((part) => part.trim().split(/\s+/))
        .map(([name, ...values]) => [name, values]),
    );
  for (const path of ['/playground/', '/playground/index.html', '/playground/playground.js']) {
    const page = policy(path);
    assert.deepEqual(page['script-src'], ["'self'"], path);
    assert.deepEqual(page['connect-src'], ["'self'"], path);
    assert.ok(!JSON.stringify(page).includes('unsafe-inline'), `${path}: no unsafe-inline anywhere`);
    assert.ok(!JSON.stringify(page).includes('https:'), `${path}: no https: source`);
    assert.deepEqual(page['frame-src'], ["'self'"], path);
    assert.deepEqual(page['frame-ancestors'], ["'self'"], `${path}: the main page is never embedded elsewhere`);
  }
  const frame = policy('/playground/frame/');
  assert.ok(frame['script-src'].includes('https://cdn.jsdelivr.net') && frame['script-src'].includes('blob:'));
  // The frame is sandboxed by its own header too, so opened directly it is still an opaque origin.
  assert.deepEqual(frame.sandbox, ['allow-scripts']);
  // Its meta policy repeats the script and connect sources, for a host that ignores _headers; a meta policy cannot
  // carry sandbox or frame-ancestors, so it has neither.
  const frameHtml = readFileSync(new URL('../site/playground/frame/index.html', import.meta.url), 'utf8');
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(frameHtml);
  assert.ok(meta, 'the frame has a meta policy');
  const metaPolicy = Object.fromEntries(
    meta[1].split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name, values];
    }),
  );
  for (const directive of ['script-src', 'connect-src', 'default-src', 'object-src', 'base-uri'])
    assert.deepEqual(metaPolicy[directive], frame[directive], directive);
  assert.equal(metaPolicy.sandbox, undefined);
  assert.equal(metaPolicy['frame-ancestors'], undefined);
  // The frame takes a run message only from its parent, from the playground's origin, and only when framed.
  assert.match(frameHtml, /event\.source === top && event\.origin === home/);
  assert.match(frameHtml, /const framed = parent !== window/);
  // The page loads the frame by URL in a sandbox without allow-same-origin, never as srcdoc (which inherits the policy).
  const page = readFileSync(new URL('../site/playground/playground.js', import.meta.url), 'utf8');
  assert.match(page, /setAttribute\('sandbox', 'allow-scripts'\)/);
  assert.doesNotMatch(page, /\.srcdoc\b|'allow-same-origin'|allow-scripts allow-same-origin/);
});

test('only well-formed frame messages pass the schema', () => {
  assert.deepEqual(parseFrameMessage({ channel: CHANNEL, kind: 'log', level: 'warn', text: 'hi' }), {
    kind: 'log',
    level: 'warn',
    text: 'hi',
  });
  assert.deepEqual(
    parseFrameMessage({ channel: CHANNEL, kind: 'error', text: 'boom', file: 'util.js', line: 3, code: 'disposed' }),
    { kind: 'error', text: 'boom', file: 'util.js', line: 3, code: 'disposed' },
  );
  assert.deepEqual(
    parseFrameMessage({
      channel: CHANNEL,
      kind: 'error',
      text: 'x',
      file: '../x.js',
      line: 4,
      code: '"><img src=x onerror=alert(1)>',
    }),
    { kind: 'error', text: 'x', file: null, line: null, code: null },
  );
  assert.deepEqual(parseFrameMessage({ channel: CHANNEL, kind: 'error', text: 'x', file: 'main.js', line: -1 }), {
    kind: 'error',
    text: 'x',
    file: 'main.js',
    line: null,
    code: null,
  });
  assert.equal(parseFrameMessage({ channel: CHANNEL, kind: 'log', level: 'eval', text: 'x' }), null);
  assert.equal(parseFrameMessage({ channel: 'other', kind: 'done' }), null);
  assert.equal(parseFrameMessage({ channel: CHANNEL, kind: 'log', level: 'log', text: { toString: () => 'x' } }), null);
  assert.equal(parseFrameMessage('string'), null);
  assert.equal(parseFrameMessage(null), null);
  assert.equal(
    parseFrameMessage({ channel: CHANNEL, kind: 'log', level: 'log', text: 'y'.repeat(9000) }).text.length,
    4000,
  );
});

test("every template imports only its own files or entries in margoengine's import map", () => {
  const map = JSON.parse(readFileSync(new URL('../packages/margoengine/dist/importmap.json', import.meta.url), 'utf8'));
  assert.ok(templates.length >= 4);
  assert.equal(new Set(templates.map((t) => t.id)).size, templates.length);
  for (const template of templates) {
    const names = new Set(template.files.map((f) => f.name));
    assert.equal(template.files[0].name, 'main.js', template.id);
    const specifiers = template.files.flatMap((f) => [...f.code.matchAll(/from '([^']+)'/g)].map((m) => m[1]));
    assert.ok(specifiers.length, template.id);
    for (const specifier of specifiers)
      assert.ok(
        specifier.startsWith('./') ? names.has(specifier.slice(2)) : map.imports[specifier],
        `${template.id}: ${specifier}`,
      );
  }
});
