// @margoengine/loaders/xml and the DTD: parameter entities, entities holding markup, attribute defaults, the external
// subset and external entities (read only through resolveDTD), against XML 1.0 Fifth Edition (W3C, 2008),
// https://www.w3.org/TR/xml/, sections 2.8, 3.3, 3.4, 4.1 to 4.5 and 5.1.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LoaderError } from '../dist/common.js';
import { readXML, readXMLTree, resolveDTD } from '../dist/xml.js';

const coded = (fn, code, pattern) =>
  assert.throws(fn, (e) => e instanceof LoaderError && e.code === code && pattern.test(e.message));
const first = (xml, options) => readXMLTree(xml, 'T', options).children[0];

test('regression: parameter entities in the internal subset are expanded between declarations (2.8, 4.4.8)', () => {
  const a = first(
    "<!DOCTYPE a [<!ENTITY % decls \"<!ENTITY who 'world'><!ENTITY % more '<!ENTITY end &#34;!&#34;>'>\">" +
      '%decls; %more;]><a>hello &who;&end;</a>',
  );
  assert.equal(a.text, 'hello world!');
  // The first declaration of a parameter entity binds too.
  assert.equal(
    first('<!DOCTYPE a [<!ENTITY % p "<!ENTITY e \'1\'>"><!ENTITY % p "<!ENTITY e \'2\'>">%p;]><a>&e;</a>').text,
    '1',
  );
  // WFC PEs in Internal Subset: not inside a declaration, nor inside an entity value.
  coded(
    () => first('<!DOCTYPE a [<!ENTITY % t "CDATA"><!ATTLIST a x %t; #IMPLIED>]><a/>'),
    'syntax',
    /inside a declaration of the internal subset/,
  );
  coded(
    () => first('<!DOCTYPE a [<!ENTITY % t "x"><!ENTITY e "%t;">]><a/>'),
    'syntax',
    /inside a declaration of the internal subset/,
  );
  // WFC Entity Declared and No Recursion for parameter entities.
  coded(() => first('<!DOCTYPE a [%nope;]><a/>'), 'syntax', /unknown parameter entity %nope;/);
  coded(() => first('<!DOCTYPE a [<!ENTITY % r "&#37;r;"> %r;]><a/>'), 'syntax', /%r; refers to itself/);
  // WFC PE Between Declarations: a parameter entity holds whole declarations.
  assert.throws(
    () => first('<!DOCTYPE a [<!ENTITY % p "<!ENTITY e"> %p; "x">]><a/>'),
    /unterminated declaration in the DTD/,
  );
});

test('regression: an entity holding markup is read as content and must hold whole elements (4.3.2, 4.4.2)', () => {
  const a = first('<!DOCTYPE a [<!ENTITY m "<b k=\'v\'>bold &amp; <i/></b> tail">]><a>x &m; y</a>');
  assert.equal(a.children.length, 1);
  assert.equal(a.children[0].name, 'b');
  assert.equal(a.children[0].attributes.k, 'v');
  assert.equal(a.children[0].text, 'bold & ');
  assert.equal(a.children[0].children[0].name, 'i');
  assert.equal(a.text, 'x  tail y');
  // Nested: an entity whose text refers to one holding markup; CDATA in an entity stays text.
  const nested = first(
    '<!DOCTYPE a [<!ENTITY i "<i/>"><!ENTITY w "[&i;]"><!ENTITY c "<![CDATA[<raw>]]>">]><a>&w;&c;</a>',
  );
  assert.equal(nested.children[0].name, 'i');
  assert.equal(nested.text, '[]<raw>');
  // The streamed order is the document's.
  const seen = [];
  readXML('<!DOCTYPE a [<!ENTITY m "<b>1</b>2">]><a>0&m;3</a>', {
    open: (n) => seen.push(`<${n}>`),
    close: (n) => seen.push(`</${n}>`),
    text: (t) => seen.push(t),
  });
  assert.deepEqual(seen, ['<a>', '0', '<b>', '1', '</b>', '2', '3', '</a>']);
  coded(() => first('<!DOCTYPE a [<!ENTITY m "<b>">]><a>&m;</b></a>'), 'syntax', /ends inside <b>/);
  coded(() => first('<!DOCTYPE a [<!ENTITY m "</a><a>">]><a>&m;</a>'), 'syntax', /closes an element opened outside it/);
  coded(() => first('<!DOCTYPE a [<!ENTITY e "<b>&e;</b>">]><a>&e;</a>'), 'syntax', /refers to itself/);
  // Markup nested 10 deep and 10 wide stops at the expansion limit.
  let subset = '<!ENTITY l0 "<b>' + 'x'.repeat(100) + '</b>">';
  for (let i = 1; i < 6; i++) subset += `<!ENTITY l${i} "${`&l${i - 1};`.repeat(10)}">`;
  coded(() => first(`<!DOCTYPE a [${subset}]><a>&l5;</a>`), 'limit', /expand past/);
});

test('regression: attribute declarations give defaults and normalize tokenized values (3.3, 3.3.3, 5.1)', () => {
  const doc =
    '<!DOCTYPE m [<!ENTITY u "mm"><!ATTLIST part unit CDATA "&u;" kind (a|b) "a" id ID #IMPLIED ' +
    'refs IDREFS #IMPLIED fixed CDATA #FIXED "  keep  ">' +
    '<!ATTLIST part unit CDATA "second loses"><!ATTLIST x:pt n NMTOKEN "1">]>' +
    '<m><part refs="  p1   p2 " id=" q "/><part unit="in" kind="b"/><x:pt/></m>';
  const [one, two, pt] = first(doc).children;
  assert.deepEqual({ ...one.attributes }, { refs: 'p1 p2', id: 'q', unit: 'mm', kind: 'a', fixed: '  keep  ' });
  assert.equal(two.attributes.unit, 'in');
  assert.equal(two.attributes.kind, 'b');
  assert.equal(pt.attributes.n, '1', 'declarations name elements as written, prefix included');
  // Entity replacement text in an attribute value is normalized too: its line feed becomes a space.
  assert.equal(first('<!DOCTYPE a [<!ENTITY nl "1&#10;2">]><a v="&nl;"/>').attributes.v, '1 2');
  assert.equal(first('<a v="1&#10;2"/>').attributes.v, '1\n2', 'a character reference in the value itself stays');
});

test('regression: without the external subset, undeclared entities are unsupported, not malformed (4.1, 5.1)', () => {
  coded(() => first('<!DOCTYPE a SYSTEM "a.dtd"><a>&x;</a>'), 'unsupported', /resolveDTD/);
  coded(() => first('<a>&x;</a>'), 'syntax', /unknown entity &x;/);
  // With standalone="yes" the internal subset must declare every entity used.
  coded(
    () => first('<?xml version="1.0" standalone="yes"?><!DOCTYPE a SYSTEM "a.dtd"><a>&x;</a>'),
    'syntax',
    /unknown entity/,
  );
  // After a parameter entity that was not read, later entity declarations are not processed (5.1)...
  const later = '<!DOCTYPE a [<!ENTITY % ext SYSTEM "ext.ent"> %ext; <!ENTITY late "L">]><a>&late;</a>';
  coded(() => first(later), 'unsupported', /not declared in the part of the DTD that was read/);
  // ... unless the document is standalone.
  assert.equal(first(`<?xml version="1.0" standalone='yes'?>${later}`).text, 'L');
  // External entities are never read without `external`.
  coded(() => first('<!DOCTYPE a [<!ENTITY e SYSTEM "e.xml">]><a>&e;</a>'), 'unsupported', /e\.xml.*was not read/);
  coded(
    () => first('<!DOCTYPE a [<!ENTITY e SYSTEM "e.xml">]><a v="&e;"/>'),
    'syntax',
    /attribute value refers to the external entity/,
  );
  coded(
    () => first('<!DOCTYPE a [<!NOTATION gif SYSTEM "g"><!ENTITY p SYSTEM "p.gif" NDATA gif>]><a>&p;</a>'),
    'syntax',
    /unparsed/,
  );
});

test('regression: the external subset and external entities are read from external (2.8, 3.4, 4.4.5)', () => {
  const dtd =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!ENTITY % draft "INCLUDE"><!ENTITY % final "IGNORE">\n' +
    '<![%draft;[<!ENTITY state "draft">]]><![%final;[<!ENTITY state "final"><![INCLUDE[<!ENTITY never "x">]]>]]>\n' +
    '<!ENTITY % len "CDATA"><!ATTLIST shape size %len; "10">\n' +
    '<!ENTITY % unit "mm"><!ENTITY label "size in %unit;">\n' +
    '<!ENTITY % common SYSTEM "sub/common.ent"> %common;\n' +
    '<!ENTITY chapter SYSTEM "sub/chapter.xml">\n' +
    '<!ENTITY state "internal wins over this">';
  const external = new Map([
    ['dtd/shapes.dtd', dtd],
    ['dtd/sub/common.ent', '<!ENTITY owner "lab">'],
    ['dtd/sub/chapter.xml', '<?xml encoding="UTF-8"?><c n="1">&owner;</c>'],
  ]);
  const xml =
    '<!DOCTYPE shapes SYSTEM "dtd/shapes.dtd" [<!ENTITY state "internal">]>' +
    '<shapes><shape/>&state; &label; &chapter;</shapes>';
  const root = first(xml, { external });
  assert.equal(root.children[0].attributes.size, '10');
  assert.equal(root.text, 'internal size in mm ');
  assert.equal(root.children[1].name, 'c');
  assert.equal(root.children[1].text, 'lab');
  coded(
    () => first('<!DOCTYPE s SYSTEM "x.dtd"><s>&never;</s>', { external: new Map([['x.dtd', dtd]]) }),
    'unsupported',
    /&never;/,
  );
  // Conditional sections belong to the external subset only.
  coded(() => first('<!DOCTYPE a [<![INCLUDE[<!ENTITY e "x">]]>]><a/>'), 'syntax', /conditional section/);
});

test('regression: resolveDTD reads what the DTD needs, opt in, with base, signal and limits', async () => {
  const files = {
    'https://example.test/dtd/main.dtd':
      '<!ENTITY % parts SYSTEM "parts.ent"> %parts; <!ENTITY book SYSTEM "../book.xml">',
    'https://example.test/dtd/parts.ent': '<!ENTITY bolt "M6 bolt"><!ATTLIST part unit CDATA "mm">',
    'https://example.test/book.xml': '<chapter>&bolt;</chapter>',
  };
  const asked = [];
  const resolve = async (id, { signal }) => {
    asked.push(id);
    assert.ok(signal === undefined || signal instanceof AbortSignal);
    if (!(id in files)) throw new Error(`404 ${id}`);
    return new TextEncoder().encode(files[id]);
  };
  const xml = '<!DOCTYPE parts SYSTEM "dtd/main.dtd"><parts><part/>&book;</parts>';
  const external = await resolveDTD(xml, { resolve, base: 'https://example.test/model.xml' });
  assert.deepEqual([...external.keys()].sort(), Object.keys(files).sort());
  assert.deepEqual(asked.slice(0, 1), ['https://example.test/dtd/main.dtd']);
  const parts = first(xml, { external, base: 'https://example.test/model.xml' });
  assert.equal(parts.children[0].attributes.unit, 'mm');
  assert.equal(parts.children[1].text, 'M6 bolt');
  // No DOCTYPE, or one with nothing external: nothing is read.
  assert.equal((await resolveDTD('<a/>', { resolve })).size, 0);
  assert.equal((await resolveDTD('<!DOCTYPE a [<!ENTITY e "x">]><a>&e;</a>', { resolve })).size, 0);
  // A failing read is a fetch error carrying the cause; limits and abort are coded.
  await assert.rejects(
    resolveDTD('<!DOCTYPE a SYSTEM "missing.dtd"><a/>', { resolve }),
    (e) => e instanceof LoaderError && e.code === 'fetch' && /404/.test(e.cause.message),
  );
  await assert.rejects(
    resolveDTD(xml, { resolve, base: 'https://example.test/model.xml', maxFiles: 2 }),
    (e) => e.code === 'limit',
  );
  await assert.rejects(
    resolveDTD(xml, { resolve, base: 'https://example.test/model.xml', maxCharacters: 50 }),
    (e) => e.code === 'limit',
  );
  await assert.rejects(resolveDTD(xml, { resolve, signal: AbortSignal.abort() }), (e) => e.code === 'aborted');
  // A plain string answer works, and relative paths join without a URL base.
  const local = await resolveDTD('<!DOCTYPE a SYSTEM "d/a.dtd"><a/>', {
    resolve: (id) => (id === 'd/a.dtd' ? '<!ENTITY % m SYSTEM "m.ent">%m;' : '<!ENTITY z "z">'),
  });
  assert.deepEqual([...local.keys()], ['d/a.dtd', 'd/m.ent']);
});

test('regression: parameter entity expansion is bounded, and readXML still takes a depth number', () => {
  let subset = '<!ENTITY % l0 "' + 'x'.repeat(100) + '">';
  for (let i = 1; i < 6; i++) subset += `<!ENTITY % l${i} "${`%l${i - 1};`.repeat(10)}">`;
  // In the internal subset a PE reference inside an entity value is an error; in the external one it expands.
  coded(
    () => first(`<!DOCTYPE a SYSTEM "x.dtd"><a/>`, { external: new Map([['x.dtd', `${subset}<!ENTITY e "%l5;">`]]) }),
    'limit',
    /expand past/,
  );
  coded(
    () =>
      first(`<!DOCTYPE a SYSTEM "x.dtd"><a/>`, { external: new Map([['x.dtd', '<!ENTITY e "x">']]), maxExpansion: -1 }),
    'range',
    /maxExpansion/,
  );
  assert.throws(() => readXML('<a><b/></a>', { open() {}, close() {} }, 'T', 1), /nest deeper than 1/);
  assert.throws(() => readXMLTree('<a><b/></a>', 'T', { maxDepth: 1 }), /nest deeper than 1/);
});
