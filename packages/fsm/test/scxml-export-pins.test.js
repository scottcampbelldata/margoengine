// Pins exportSCXML at its limits, which match the importer's: 10,000 elements (counted before validation, so a huge
// document fails fast, and again on the output, hooks included), 1 MiB in characters and in UTF-8 bytes, nesting
// (64 levels of regions before validation, then 128 output levels), generated ids, and the extension attributes.
// Also the importer's size message, native history kinds and region wrapper attributes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportSCXML, importSCXML } from '../dist/scxml.js';

const MAX = 1048576;
const fails = (fn, pattern, what) => assert.throws(fn, (e) => e instanceof TypeError && pattern.test(e.message), what);
const ELEMENTS = /output exceeds 10,000 elements/;
const flat = (n, transitions = 0, extra = {}) => {
  const states = {};
  for (let i = 0; i < n; i++) states['s' + i] = {};
  const list = Array.from({ length: transitions }, (_, i) => ({ from: 's0', to: 's0', event: 'e' + i }));
  return { version: 1, initial: 's0', states, ...(transitions ? { transitions: list } : {}), ...extra };
};
const bytes = (s) => new TextEncoder().encode(s).byteLength;

test('elements: 10,000 export and import again, one more is refused, transitions counted', () => {
  assert.equal(Object.keys(importSCXML(exportSCXML(flat(9999))).states).length, 9999);
  fails(() => exportSCXML(flat(10000)), ELEMENTS, '10,000 states and the root');
  assert.equal(importSCXML(exportSCXML(flat(4999, 5000))).transitions.length, 5000);
  fails(() => exportSCXML(flat(5000, 5000)), ELEMENTS, 'one transition over');
});

test('size is checked before validation: an invalid document over the limit reports its size', () => {
  fails(() => exportSCXML(flat(10000, 0, { initial: 'nowhere' })), ELEMENTS, 'no transitions key');
  fails(() => exportSCXML(flat(5000, 5000, { initial: 'nowhere' })), ELEMENTS, 'with transitions');
  fails(() => exportSCXML(flat(9999, 0, { initial: 'nowhere' })), /initial: Unknown state/, 'at the limit');
  fails(() => exportSCXML(flat(4999, 5000, { initial: 'nowhere' })), /initial: Unknown state/, 'at the limit');
  fails(() => exportSCXML(flat(9998, 1, { initial: 'nowhere' })), /initial: Unknown state/, 'one transition');
});

test('the output count includes hook elements: 3,333 states with an enter hook fit, one more state does not', () => {
  const hooks = (n) => {
    const states = {};
    for (let i = 0; i < n; i++) states['s' + i] = { enter: 'h' };
    return { version: 1, initial: 's0', states };
  };
  assert.equal(importSCXML(exportSCXML(hooks(3333))).states.s0.enter, 'h');
  fails(() => exportSCXML({ ...hooks(3333), states: { ...hooks(3333).states, extra: {} } }), ELEMENTS);
});

test('1 MiB of output in characters, or in UTF-8 bytes, is allowed and one more is refused', () => {
  const one = (name) => ({ version: 1, initial: name, states: { [name]: {} } });
  // ASCII names are their own id, written twice (initial and id): length = c + 2 L; a second name fixes the parity.
  const ascii = (l, m) =>
    exportSCXML({ version: 1, initial: 'a'.repeat(l), states: { ['a'.repeat(l)]: {}, ['b'.repeat(m)]: {} } });
  const base = ascii(1, 1).length - 3;
  const l = Math.floor((MAX - base - 1) / 2);
  const m = MAX - base - 2 * l;
  assert.equal(ascii(l, m).length, MAX);
  assert.equal(importSCXML(ascii(l, m)).initial, 'a'.repeat(l));
  fails(() => ascii(l, m + 1), /output exceeds 1 MiB/, 'one character over');
  // Two-byte names get a generated id and keep the name in m:name: characters c + L, bytes c + 2 L.
  const wide = (l, m) =>
    exportSCXML({ version: 1, initial: 'x', states: { x: {}, ['é'.repeat(l)]: {}, ['b'.repeat(m)]: {} } });
  const small = wide(1, 1);
  const cb = bytes(small) - 2 - 1;
  const w = Math.floor((MAX - cb - 1) / 2);
  const rest = MAX - cb - 2 * w;
  const exact = wide(w, rest);
  assert.equal(bytes(exact), MAX);
  assert.ok(exact.length < MAX);
  assert.equal(Object.keys(importSCXML(exact).states).length, 3);
  fails(() => wide(w, rest + 1), /output exceeds 1 MiB/, 'one byte over');
  assert.equal(exportSCXML(one('a')).length < MAX, true);
});

test('nesting: 126 hierarchy levels and 62 nested regions (41 under a parent) export; deeper ones fail with their own message', () => {
  const chain = (k) => {
    const states = {};
    for (let i = 0; i < k; i++) states['s' + i] = i ? { parent: 's' + (i - 1) } : {};
    return { version: 1, initial: 's0', states };
  };
  assert.equal(importSCXML(exportSCXML(chain(126))).states.s125.parent, 's124');
  fails(() => exportSCXML(chain(127)), /overly nested hierarchy/);
  const nest = (n) => {
    let region = { states: { leaf: {} }, initial: 'leaf' };
    for (let i = 0; i < n; i++) region = { states: { h: { regions: { r: region } } }, initial: 'h' };
    return { version: 1, ...region };
  };
  assert.equal(importSCXML(exportSCXML(nest(62))).initial, 'h');
  fails(() => exportSCXML(nest(63)), /overly nested hierarchy/);
  fails(() => exportSCXML(nest(64)), /overly nested hierarchy/, '64 region levels pass the first check');
  fails(() => exportSCXML(nest(65)), /cyclic or overly nested document/, '65 are refused before validation');
  // A holder one level down in its region's hierarchy: each region level then costs one output level more.
  const under = (n) => {
    let region = { states: { leaf: {} }, initial: 'leaf' };
    for (let i = 0; i < n; i++)
      region = { states: { top: { initial: 'h' }, h: { parent: 'top', regions: { r: region } } }, initial: 'top' };
    return { version: 1, ...region };
  };
  assert.equal(importSCXML(exportSCXML(under(41))).states.h.parent, 'top');
  fails(() => exportSCXML(under(42)), /overly nested hierarchy/);
  const cyclic = { states: { h: {} }, initial: 'h' };
  cyclic.states.h.regions = { r: cyclic };
  fails(() => exportSCXML({ version: 1, ...cyclic }), /cyclic or overly nested document/);
});

test('generated ids count from margo0; extension attributes only where they carry something', () => {
  const text = exportSCXML({ version: 1, initial: 'a b', states: { 'a b': {}, 'c d': {} } });
  assert.match(text, /<state id="margo0" m:name="a b">/);
  assert.match(text, /<state id="margo1" m:name="c d">/);
  const plain = exportSCXML({ version: 1, initial: 'a', states: { a: {} } });
  assert.equal(plain.includes('m:transitions'), false, 'no transitions key, no marker');
  assert.equal(importSCXML(plain).transitions, undefined);
  const none = exportSCXML({ version: 1, initial: 'a', states: { a: {} }, transitions: [] }, { extensions: false });
  assert.equal(none.includes('m:'), false, 'without extensions no marker is written');
  const empty = exportSCXML({ version: 1, initial: 'a', states: { a: {} }, transitions: [] });
  assert.match(empty, /m:transitions="empty"/);
  assert.deepEqual(importSCXML(empty).transitions, []);
  const open = exportSCXML({ version: 1, initial: 'p', states: { p: {}, c: { parent: 'p' } } });
  assert.match(open, /<state id="p" m:initial="none">/);
  assert.equal(importSCXML(open).states.p.initial, undefined);
});

test('import: the size refusal names the size, native history takes shallow and deep, wrappers take only theirs', () => {
  const NS = 'xmlns="http://www.w3.org/2005/07/scxml" xmlns:m="urn:margoengine:fsm:1"';
  const xml = (content) => `<scxml ${NS} version="1.0">${content}</scxml>`;
  const SIZE = /input is over 1 MiB or contains a DTD/;
  fails(() => importSCXML(42), SIZE, 'not a string');
  const base = xml('<state id="a"/>');
  fails(
    () => importSCXML(base.replace('</scxml>', ' '.repeat(MAX - base.length + 1) + '</scxml>')),
    SIZE,
    'characters',
  );
  const free = MAX - base.length - 7;
  const over = base.replace(
    '</scxml>',
    `<!--${'é'.repeat(Math.floor(free / 2))}-->${' '.repeat((free % 2) + 1)}</scxml>`,
  );
  assert.equal(bytes(over), MAX + 1);
  fails(() => importSCXML(over), SIZE, 'bytes');
  for (const kind of ['shallow', 'deep'])
    assert.equal(importSCXML(xml(`<state id="p" m:history="${kind}"><state id="c"/></state>`)).states.p.history, kind);
  const wrapped = (attrs) =>
    xml(`<parallel id="q"><state id="r" m:name="r" m:wrapper="true"${attrs}><state id="x"/></state></parallel>`);
  assert.equal(importSCXML(wrapped('')).states.q.regions.r.initial, 'x');
  fails(() => importSCXML(wrapped(' m:history="deep"')), /^Unsupported SCXML/, 'an extension a wrapper does not take');
  fails(() => importSCXML(wrapped(' foo="1"')), /^Unsupported SCXML/, 'a plain attribute a wrapper does not take');
});
