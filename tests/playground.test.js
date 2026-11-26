// The playground's share links, version history, frame document and message schema (site/playground/share.js), and
// its templates against margoengine's import map. The page itself: tests/browser/playground.test.js.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import {
  CHANNEL,
  MAX_CODE_BYTES,
  MAX_LINK_CHARS,
  MAX_SNAPSHOTS,
  STORE_KEY,
  addSnapshot,
  codeFromHash,
  decodeCode,
  encodeCode,
  downloadDocument,
  parseFrameMessage,
  readStore,
  runMessage,
  scriptText,
  writeStore,
} from '../site/playground/share.js';
import { templates } from '../site/playground/templates.js';
import { headersFor, parseHeaders } from '../scripts/support/headers.mjs';

const linkError = (pattern) => (error) =>
  error.name === 'MargoError' && error.code === 'playground-link' && pattern.test(error.message);

test('a share link round-trips code exactly, Unicode and line endings included', async () => {
  for (const code of [
    "import {createStage} from 'margoengine';\r\nconsole.log('héllo, 世界 🎲');\n",
    templates[0].code,
    'x'.repeat(100_000),
  ]) {
    const text = await encodeCode(code);
    assert.match(text, /^[A-Za-z0-9_-]+$/, 'base64url without padding');
    assert.equal(await decodeCode(text), code);
  }
  // Deflate does the work: a template compresses well below its own length.
  assert.ok((await encodeCode(templates[0].code)).length < templates[0].code.length);
  assert.equal(codeFromHash(`#code=${await encodeCode('a')}&embed`), await encodeCode('a'));
  assert.equal(codeFromHash('#other=1'), null);
  assert.equal(codeFromHash(''), null);
});

test('share links are capped both ways and bad input rejects with a clear coded error', async () => {
  await assert.rejects(encodeCode('x'.repeat(MAX_CODE_BYTES + 1)), linkError(/at most 262144/));
  await assert.rejects(decodeCode('A'.repeat(MAX_LINK_CHARS + 1)), linkError(/limit is 65536/));
  await assert.rejects(decodeCode(''), linkError(/no code/));
  await assert.rejects(decodeCode('abc$%'), linkError(/not base64url/));
  await assert.rejects(decodeCode('abcde'), linkError(/not base64url/));
  // Valid base64url that is not deflate data.
  await assert.rejects(decodeCode('_____w'), linkError(/does not decompress/));
  // A truncated link: the deflate stream ends early.
  const whole = await encodeCode(templates[1].code);
  await assert.rejects(decodeCode(whole.slice(0, (whole.length >> 3) << 2)), linkError(/does not decompress/));
  // A small link that inflates past the cap (a decompression bomb) stops at the cap.
  const big = deflateRawSync(Buffer.alloc(MAX_CODE_BYTES * 8, 97)).toString('base64url');
  assert.ok(big.length < MAX_LINK_CHARS);
  await assert.rejects(decodeCode(big), linkError(/expands past 262144/));
  // Bytes that are not UTF-8.
  await assert.rejects(
    decodeCode(deflateRawSync(Buffer.from([0xff, 0xfe, 0xc0])).toString('base64url')),
    linkError(/UTF-8/),
  );
});

test('the version history keeps the newest snapshots first, skips repeats and caps its length', () => {
  let history = [];
  history = addSnapshot(history, '// First\na()', 1);
  history = addSnapshot(history, '// First\na()', 2);
  assert.equal(history.length, 1, 'the same code twice is one snapshot');
  history = addSnapshot(history, '\n\n  b()\n', 3);
  assert.deepEqual(
    history.map((s) => [s.time, s.title]),
    [
      [3, 'b()'],
      [1, 'First'],
    ],
  );
  for (let i = 0; i < MAX_SNAPSHOTS + 10; i++) history = addSnapshot(history, `v${i}`, 10 + i);
  assert.equal(history.length, MAX_SNAPSHOTS);
  assert.equal(history[0].code, `v${MAX_SNAPSHOTS + 9}`);
  assert.equal(history.at(-1).code, 'v10');
});

test('the store survives missing, malformed and full storage', () => {
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
      history: [{ code: 'a', time: 1, title: 'a' }, { code: 7 }],
    }),
  );
  assert.deepEqual(readStore(bad), {
    current: null,
    history: [{ code: 'a', time: 1, title: 'a' }],
  });
  const blocked = {
    getItem: () => {
      throw new DOMException('blocked', 'SecurityError');
    },
  };
  assert.deepEqual(readStore(blocked), { current: null, history: [] });

  const store = memory();
  const history = [3, 2, 1].reduce((h, i) => addSnapshot(h, `code ${i}`, i), []);
  assert.deepEqual(writeStore(store, { current: 'now', history }), history);
  assert.deepEqual(readStore(store), { current: 'now', history });
  // Full storage: the oldest snapshots go first until the state fits.
  const small = memory(JSON.stringify({ current: 'now', history: history.slice(0, 2) }).length);
  assert.deepEqual(writeStore(small, { current: 'now', history }), history.slice(0, 2));
  assert.equal(writeStore(memory(5), { current: 'now', history }), null);
});

test('the run message and the download carry the code safely', () => {
  const code = "console.log('</script><!-- x');\nthrow new Error('two');";
  assert.deepEqual(runMessage(code, 'http://127.0.0.1:5180/node_modules/'), {
    channel: CHANNEL,
    kind: 'run',
    code,
    packages: 'http://127.0.0.1:5180/node_modules/',
  });
  assert.equal(runMessage(code).packages, null);
  assert.throws(() => runMessage(code, '/node_modules/'), TypeError);
  assert.throws(() => runMessage(code, 'javascript:alert(1)//'), TypeError);
  const frameHtml = readFileSync(new URL('../site/playground/frame/index.html', import.meta.url), 'utf8');
  const html = downloadDocument(frameHtml, code);
  assert.equal(
    html.match(/<\/script>/gi).length,
    frameHtml.match(/<\/script>/gi).length + 1,
    'the code cannot end its element',
  );
  assert.ok(html.includes(scriptText(JSON.stringify(runMessage(code)))));
  assert.ok(html.indexOf('window.MARGO_PLAYGROUND') < html.indexOf("const CHANNEL = 'margo-playground'"));
  assert.throws(() => downloadDocument('<html></html>', code), /marker/);
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
  }
  const frame = policy('/playground/frame/');
  assert.ok(frame['script-src'].includes('https://cdn.jsdelivr.net') && frame['script-src'].includes('blob:'));
  // The page loads the frame by URL in a sandbox without allow-same-origin, never as srcdoc (which inherits the policy).
  const page = readFileSync(new URL('../site/playground/playground.js', import.meta.url), 'utf8');
  assert.match(page, /setAttribute\('sandbox', 'allow-scripts'\)/);
  assert.doesNotMatch(page, /\.srcdoc\b|'allow-same-origin'|allow-scripts allow-same-origin/);
});

test('only well-formed frame messages pass the schema', () => {
  assert.deepEqual(
    parseFrameMessage({
      channel: CHANNEL,
      kind: 'log',
      level: 'warn',
      text: 'hi',
    }),
    {
      kind: 'log',
      level: 'warn',
      text: 'hi',
    },
  );
  assert.deepEqual(
    parseFrameMessage({
      channel: CHANNEL,
      kind: 'error',
      text: 'boom',
      line: 3,
      code: 'disposed',
    }),
    {
      kind: 'error',
      text: 'boom',
      line: 3,
      code: 'disposed',
    },
  );
  assert.deepEqual(
    parseFrameMessage({
      channel: CHANNEL,
      kind: 'error',
      text: 'x',
      line: -1,
      code: '"><img src=x onerror=alert(1)>',
    }),
    { kind: 'error', text: 'x', line: null, code: null },
  );
  assert.equal(
    parseFrameMessage({
      channel: CHANNEL,
      kind: 'log',
      level: 'eval',
      text: 'x',
    }),
    null,
  );
  assert.equal(parseFrameMessage({ channel: 'other', kind: 'done' }), null);
  assert.equal(
    parseFrameMessage({
      channel: CHANNEL,
      kind: 'log',
      level: 'log',
      text: { toString: () => 'x' },
    }),
    null,
  );
  assert.equal(parseFrameMessage('string'), null);
  assert.equal(parseFrameMessage(null), null);
  assert.equal(
    parseFrameMessage({
      channel: CHANNEL,
      kind: 'log',
      level: 'log',
      text: 'y'.repeat(9000),
    }).text.length,
    4000,
  );
});

test("every template imports only entries in margoengine's import map", () => {
  const map = JSON.parse(readFileSync(new URL('../packages/margoengine/dist/importmap.json', import.meta.url), 'utf8'));
  assert.ok(templates.length >= 4);
  assert.equal(new Set(templates.map((t) => t.id)).size, templates.length);
  for (const template of templates) {
    const specifiers = [...template.code.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    assert.ok(specifiers.length, template.id);
    for (const specifier of specifiers) assert.ok(map.imports[specifier], `${template.id}: ${specifier}`);
  }
});
