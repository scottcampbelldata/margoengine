// Pins importSCXML at the limits and refusals the older tests leave open: the 1 MiB size in characters and in UTF-8
// bytes, 10,000 elements and 128 nesting levels on the exact boundary, node kinds, attribute namespaces, datamodels,
// initial and history shapes, hook content, event names, transition order and root content.
import test from 'node:test';
import assert from 'node:assert/strict';
import { importSCXML } from '../dist/scxml.js';

const MAX = 1048576;
const NS = 'xmlns="http://www.w3.org/2005/07/scxml" xmlns:m="urn:margoengine:fsm:1"';
const xml = (content, attrs = '') => `<scxml ${NS} version="1.0"${attrs}>${content}</scxml>`;
const ok = (text) => importSCXML(text);
const bad = (text, what) =>
  assert.throws(
    () => importSCXML(text),
    (e) => e instanceof TypeError && /^Unsupported SCXML/.test(e.message),
    what,
  );
const bytes = (s) => new TextEncoder().encode(s).byteLength;

test('size: exactly 1 MiB of characters or of bytes is accepted, one more is refused', () => {
  const base = xml('<state id="a"/>');
  const pad = (n) => base.replace('</scxml>', ' '.repeat(n) + '</scxml>');
  assert.equal(pad(MAX - base.length).length, MAX);
  assert.equal(ok(pad(MAX - base.length)).initial, 'a');
  bad(pad(MAX - base.length + 1), 'one character over');
  // Two-byte characters in a comment: under the character limit, at or over the byte limit.
  const comment = (n, spaces) => base.replace('</scxml>', `<!--${'é'.repeat(n)}-->${' '.repeat(spaces)}</scxml>`);
  const free = MAX - base.length - 7;
  const exact = comment(Math.floor(free / 2), free % 2);
  assert.equal(bytes(exact), MAX);
  assert.ok(exact.length < MAX);
  assert.equal(ok(exact).initial, 'a');
  const over = comment(Math.floor(free / 2), (free % 2) + 1);
  assert.equal(bytes(over), MAX + 1);
  assert.ok(over.length < MAX);
  bad(over, 'one byte over');
  bad(`<!DOCTYPE scxml>${base}`, 'a DTD');
  bad(`<!ENTITY x "y">${base}`, 'an entity');
  assert.throws(() => importSCXML(42), TypeError);
});

test('elements: 10,000 are accepted and 10,001 refused; 128 nesting levels accepted and 129 refused', () => {
  const flat = (n) => xml(Array.from({ length: n }, (_, i) => `<state id="s${i}"/>`).join(''));
  assert.equal(Object.keys(ok(flat(9999)).states).length, 9999);
  bad(flat(10000), '10,001 elements with the root');
  const nest = (n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += `<state id="d${i}">`;
    for (let i = 0; i < n; i++) s += '</state>';
    return xml(s);
  };
  assert.equal(ok(nest(128)).states.d127.parent, 'd126');
  bad(nest(129), 'a state 129 levels below the root');
});

test('node kinds: comments are allowed; processing instructions and stray text or CDATA are refused', () => {
  assert.equal(ok(xml('<!-- note --><state id="a"><!-- inner --></state>')).initial, 'a');
  bad(xml('<?pi data?><state id="a"/>'), 'processing instruction');
  bad(xml('<state id="a">words</state>'), 'text');
  bad(xml('<state id="a"><![CDATA[words]]></state>'), 'CDATA');
  assert.equal(ok(xml('<state id="a">  \n  </state>')).initial, 'a');
});

test('attributes: a plain attribute with an extension name, or an extension the element does not take, is refused', () => {
  bad(xml('<state id="a" name="x"/>'), 'name without the namespace');
  bad(xml('<state id="a" m:after="1"/>'), 'after on a state');
  assert.equal(ok(xml('<state id="a" m:name="Alpha"/>')).initial, 'Alpha');
  bad(xml('<state id="a" m:wrapper="yes"/>'), 'native boolean');
});

test('datamodel: null and ecmascript are accepted, others refused', () => {
  assert.equal(ok(xml('<state id="a"/>', ' datamodel="null"')).initial, 'a');
  assert.equal(ok(xml('<state id="a"/>', ' datamodel="ecmascript"')).initial, 'a');
  bad(xml('<state id="a"/>', ' datamodel="xpath"'), 'xpath');
});

test('initial: attribute plus element, two elements, a bad marker or a bad transition list is refused', () => {
  const kids = '<state id="a"/><state id="b"/>';
  assert.equal(
    ok(xml(`<state id="p"><initial><transition target="b"/></initial>${kids}</state>`)).states.p.initial,
    'b',
  );
  bad(xml(`<state id="p" initial="a"><initial><transition target="b"/></initial>${kids}</state>`), 'both');
  bad(
    xml(
      `<state id="p"><initial><transition target="a"/></initial><initial><transition target="b"/></initial>${kids}</state>`,
    ),
    'two',
  );
  bad(xml(`<state id="p" m:initial="first">${kids}</state>`), 'marker');
  assert.equal(ok(xml(`<state id="p" m:initial="none">${kids}</state>`)).states.p.initial, undefined);
  assert.equal(ok(xml(`<state id="p">${kids}</state>`)).states.p.initial, 'a', 'first child inferred');
  bad(
    xml(`<state id="p"><initial><transition target="a"/><transition target="b"/></initial>${kids}</state>`),
    'two edges',
  );
  bad(xml(`<state id="p"><initial></initial>${kids}</state>`), 'no edge');
  bad(xml(`<state id="p"><initial><onentry/></initial>${kids}</state>`), 'not a transition');
});

test('history: two, a bad native kind or a default with other than one transition is refused', () => {
  const kids = '<state id="a"/><state id="b"/>';
  const h = (id, body) => `<history id="${id}">${body}</history>`;
  assert.equal(
    ok(xml(`<state id="p" initial="a">${h('h', '<transition target="a"/>')}${kids}</state>`)).states.p.history,
    'shallow',
  );
  bad(
    xml(
      `<state id="p" initial="a">${h('h', '<transition target="a"/>')}${h('k', '<transition target="a"/>')}${kids}</state>`,
    ),
    'two',
  );
  bad(xml(`<state id="p" initial="a" m:history="all">${kids}</state>`), 'native kind');
  assert.equal(ok(xml(`<state id="p" initial="a" m:history="deep">${kids}</state>`)).states.p.history, 'deep');
  bad(xml(`<state id="p" initial="a">${h('h', '')}${kids}</state>`), 'no default');
  bad(
    xml(`<state id="p" initial="a">${h('h', '<transition target="a"/><transition target="a"/>')}${kids}</state>`),
    'two defaults',
  );
  bad(xml(`<state id="p" initial="a">${h('h', '<onentry/>')}${kids}</state>`), 'not a transition');
});

test('hooks: a native hook with text or children is refused; a plain one is read', () => {
  assert.equal(ok(xml('<state id="a"><onentry><m:hook name="go"/></onentry></state>')).states.a.enter, 'go');
  bad(xml('<state id="a"><onentry><m:hook name="go">x</m:hook></onentry></state>'), 'text');
  bad(xml('<state id="a"><onentry><m:hook name="go"><m:hook name="in"/></m:hook></onentry></state>'), 'child');
  bad(xml('<state id="a"><onentry><m:other name="go"/></onentry></state>'), 'other native element');
});

test('events and order: empty, listed or wildcard events and a non-integer order are refused; order sorts', () => {
  const two = (t) => xml(`<state id="a">${t}</state><state id="b"/>`);
  bad(two('<transition event="" target="b"/>'), 'empty event');
  bad(two('<transition event="go stop" target="b"/>'), 'event list');
  bad(two('<transition event="go.*" target="b"/>'), 'wildcard');
  bad(two('<transition event="go" target="b" m:order="1.5"/>'), 'fraction');
  bad(two('<transition event="go" target="b" m:order="99999999999999999999"/>'), 'unsafe integer');
  const d = ok(two('<transition event="x" target="b" m:order="2"/><transition event="y" target="b" m:order="1"/>'));
  assert.deepEqual(
    d.transitions.map((t) => t.event),
    ['y', 'x'],
  );
});

test('root content other than states and one initial is refused; stay needs an internal self or ancestor target', () => {
  bad(xml('<state id="a"/><onentry/>'), 'onentry at the root');
  bad(xml('<state id="a"/><transition target="a"/>'), 'transition at the root');
  bad(
    xml('<state id="p" initial="a"><state id="a"><transition event="e" target="p" m:stay="true"/></state></state>'),
    'external stay',
  );
  assert.ok(
    ok(
      xml(
        '<state id="p" initial="a"><state id="a"><transition event="e" type="internal" target="p" m:stay="true"/></state></state>',
      ),
    ),
  );
  bad(
    xml(
      '<state id="p" initial="a"><state id="a"><transition event="e" type="internal" target="b" m:stay="true"/></state><state id="b"/></state>',
    ),
    'stay to a sibling',
  );
});
