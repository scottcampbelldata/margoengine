import test from 'node:test';
import assert from 'node:assert/strict';
import { importSCXML, exportSCXML } from '../dist/scxml.js';
import { loadMachine, validateMachine } from '../dist/document.js';

const parse = text => importSCXML(text);
const xml = content => `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0">${content}</scxml>`;
const plain = value => JSON.parse(JSON.stringify(value));

test('standard namespace, implicit/explicit initials and symbolic hooks/guards map to working documents', () => {
  const document = parse(`<s:scxml xmlns:s="http://www.w3.org/2005/07/scxml" version="1.0" initial="p">
    <s:state id="p"><s:initial><s:transition target="a"/></s:initial>
      <s:state id="a"><s:onexit><s:script>leave()</s:script></s:onexit><s:transition event="go" target="b" cond="ready()"/></s:state>
      <s:state id="b"/>
    </s:state></s:scxml>`);
  assert.deepEqual(validateMachine(document), []); assert.equal(document.states.p.initial, 'a');
  let exits = 0;
  const machine = loadMachine(document, {}, { hooks: { leave: () => exits++ }, guards: { ready: () => true } });
  machine.send('go'); assert.equal(machine.state, 'b'); assert.equal(exits, 1);
});

test('standard history defaults and pseudo-state targets map to remembered parent transitions', () => {
  const document = parse(xml(`<state id="p" initial="a"><history id="h" type="deep"><transition target="a"/></history>
    <state id="a"><transition event="go" target="b"/></state><state id="b"/>
    <transition event="pause" target="paused"/></state><state id="paused"><transition event="resume" target="h"/></state>`));
  assert.equal(document.states.p.history, 'deep');
  const machine = loadMachine(document, {}); machine.send('go'); machine.send('pause'); machine.send('resume');
  assert.equal(machine.state, 'b');
  assert.throws(() => parse(xml('<state id="p" initial="a"><history id="h"><transition target="b"/></history><state id="a"/><state id="b"/></state>')), /differs/);
});

test('standard parallel region wrappers retain their hooks and active child paths', () => {
  const document = parse(xml(`<parallel id="both"><state id="legs" initial="stand"><state id="stand"><transition event="walk" target="walking"/></state><state id="walking"/></state>
    <state id="arms"><state id="rest"/></state></parallel>`));
  const machine = loadMachine(document, {}); machine.send('walk');
  assert.equal(machine.states.both.regions.machines.legs.state, 'walking');
  assert.equal(machine.states.both.regions.machines.arms.state, 'rest');
});

test('extensions round-trip all native field kinds, repeated region-local ids, symbols and transition order', () => {
  const document = { version: 1, initial: 'p', states: {
    p: { initial: 'a', history: 'deep' }, a: { parent: 'p', enter: 'hook with <&"\n', update: 'tick', exit: 'exit' },
    'state with spaces': {},
    both: { regionHistory: true, regions: { left: { initial: 'a', states: { a: {}, b: {} }, transitions: [{ from: 'a', to: 'b', event: 'go' }] },
      right: { initial: 'a', states: { a: {} }, transitions: [] } } },
  }, transitions: [{ from: 'both', to: 'p', event: 'stop' }, { from: 'a', to: 'state with spaces', after: .5, duration: .2, guard: 'ready with spaces' },
    { from: 'state with spaces', to: 'both', event: 'go' }] };
  const text = exportSCXML(document); const restored = parse(text);
  assert.deepEqual(plain(restored), document);
  assert.match(text, /urn:margoengine:fsm:1/);
  assert.match(text, /&amp;/);
  assert.deepEqual(validateMachine(restored), []);
});

test('plain export of the common event subset uses only standard XML elements and round-trips', () => {
  const document = { version: 1, initial: 'a', states: { a: { enter: 'enter' }, b: {} }, transitions: [{ from: 'a', to: 'b', event: 'go', guard: 'ready' }] };
  const text = exportSCXML(document, { extensions: false });
  assert.doesNotMatch(text, /xmlns:m/); assert.deepEqual(plain(parse(text)), document);
  assert.throws(() => exportSCXML({ version: 1, initial: 'a', states: { a: {}, b: {} }, transitions: [{ from: 'a', to: 'b', after: 1 }] }, { extensions: false }), /extensions/);
});

test('unsupported content, entity declarations, invalid XML and cross-region references reject without execution', () => {
  for (const content of [
    '<final id="done"/>', '<state id="a"><invoke src="https://example.invalid"/></state>',
    '<state id="a"><onentry><script>globalThis.touched = true</script></onentry></state>',
    '<state id="a"><transition target="a"/></state>', '<state id="a"><transition event="one two" target="a"/></state>',
    '<state id="a" typo="lost"/>', '<state id="a"/><state id="a"/>',
    '<parallel id="p"><state id="one"><state id="a"><transition event="go" target="b"/></state></state><state id="two"><state id="b"/></state></parallel>',
    '<state id="a"><transition event="go" target="a"><raise event="go"/></transition></state>',
    '<state xmlns="urn:wrong" id="a"/>',
  ]) assert.throws(() => parse(xml(content)), TypeError, content);
  assert.throws(() => parse('<!DOCTYPE scxml [<!ENTITY ext SYSTEM "file:///secret">]>' + xml('<state id="a"/>')), /DTD/);
  assert.throws(() => parse(xml('<state id="a">')), /malformed/);
  // Security: markup-shaped file text stays data. HTML-only syntax is malformed XML, and escaped markup in a hook body
  // is not a binding name, so neither reaches a document or a script.
  for (const hostile of [
    '<state id="a"><onentry><script><img src=x onerror="globalThis.touched=1"></script></onentry></state>',
    '<state id="a"><onentry><script>&lt;img src=x onerror=globalThis.touched=1&gt;</script></onentry></state>',
    '<state id="a"><onentry><script><![CDATA[</script><script>globalThis.touched=1</script>]]></script></onentry></state>',
    '<state id="a" onclick="globalThis.touched=1"/>',
    '<state id="&quot;&gt;&lt;script&gt;"/>',
  ]) assert.throws(() => parse(xml(hostile)), TypeError, hostile);
  assert.equal(globalThis.touched, undefined);
});

test('prototype-like ids, control-character rejection, input budgets and the built-in XML reader', () => {
  const document = parse(xml('<state id="__proto__"><transition event="go" target="constructor"/></state><state id="constructor"/>'));
  assert.equal(loadMachine(document, {}).send('go'), true);
  // Node has no DOMParser global: the strict built-in reader needs none, and the deprecated parser option is ignored.
  assert.equal(globalThis.DOMParser, undefined);
  assert.deepEqual(plain(importSCXML(xml('<state id="a"/>'), { parser: { parseFromString: () => { throw new Error('used'); } } })), { version: 1, initial: 'a', states: { a: {} } });
  assert.throws(() => parse(' '.repeat(1048577)), /1 MiB/);
  assert.throws(() => exportSCXML({ version: 1, initial: 'bad\0', states: { 'bad\0': {} } }), /XML 1.0/);
  const deep = Array.from({ length: 130 }, (_v, i) => `<state id="a${i}">`).join('') + '</state>'.repeat(130);
  assert.throws(() => parse(xml(deep)), /nesting/);
});

test('export bounds match the importer and shared region definitions are not treated as cycles', () => {
  const inner = { initial: 'a', states: { a: {} } };
  const document = { version: 1, initial: 'p', states: { p: { regions: { left: inner, right: inner } } } };
  assert.doesNotThrow(() => parse(exportSCXML(document)));
  const states = Object.fromEntries(Array.from({ length: 10001 }, (_v, i) => [`s${i}`, {}]));
  assert.throws(() => exportSCXML({ version: 1, initial: 's0', states }), /10,000/);
});
