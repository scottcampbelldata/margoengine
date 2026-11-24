// @margoengine/loaders/xml: the entry formats outside this package read XML through.
import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeXML, readXML, readXMLTree } from '../dist/xml.js';

test('readXMLTree gives the elements under a nameless root, prefixes gone and entities read', () => {
  const root = readXMLTree('<?xml version="1.0"?><!-- note --><a:robot name="x &amp; y"><link/>text<link id="2"/></a:robot>', 'T');
  assert.equal(root.name, '');
  const robot = root.children[0];
  assert.equal(robot.name, 'robot');
  assert.equal(robot.attributes.name, 'x & y');
  assert.equal(robot.children.length, 2);
  assert.equal(robot.children[1].attributes.id, '2');
  assert.equal(robot.text, 'text');
});

test('readXML streams in order and a broken document names the format', () => {
  const seen = [];
  readXML('<a><b>c</b></a>', {
    open: (name) => seen.push(`open ${name}`),
    close: (name) => seen.push(`close ${name}`),
    text: (text) => seen.push(text),
  });
  assert.deepEqual(seen, ['open a', 'open b', 'c', 'close b', 'close a']);
  assert.throws(() => readXMLTree('<a><b></a>', 'Scene file'), /Scene file/);
  assert.throws(() => readXMLTree('<a>', 'Scene file'), /document ends inside <a>/);
});

test('decodeXML reads UTF-8 and follows a UTF-16 byte order mark', () => {
  assert.equal(decodeXML(new TextEncoder().encode('<a/>')), '<a/>');
  assert.equal(decodeXML(new Uint8Array([0xff, 0xfe, 0x3c, 0, 0x61, 0, 0x2f, 0, 0x3e, 0])), '<a/>');
});

// XML 1.0 Fifth Edition (W3C, 2008), https://www.w3.org/TR/xml/, read line by line against xml.ts.
test('a DOCTYPE internal subset declares entities the document then uses (4.2, 5.1)', () => {
  const svg =
    '<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd" [\n' +
    '  <!ENTITY ns_svg "http://www.w3.org/2000/svg">\n  <!ENTITY ns_flows \'http://ns.example/Flows/1.0/\'>\n' +
    '  <!-- a > inside a comment -->\n  <!ENTITY wrap "[&ns_svg;]">\n  <!ENTITY ns_svg "second declaration loses">\n' +
    ']>\n<svg xmlns="&ns_svg;" a="&wrap;">&ns_flows;</svg>';
  const root = readXMLTree(svg, 'SVG');
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].attributes.xmlns, 'http://www.w3.org/2000/svg');
  assert.equal(root.children[0].attributes.a, '[http://www.w3.org/2000/svg]');
  assert.equal(root.children[0].text, 'http://ns.example/Flows/1.0/');
  assert.throws(() => readXMLTree('<!DOCTYPE a [<!ENTITY e "&e;">]><a>&e;</a>', 'T'), /refers to itself/);
  assert.throws(() => readXMLTree('<!DOCTYPE a [<!ENTITY e "<b/>">]><a x="&e;"/>', 'T'), /< in an attribute/);
  // Nested expansion past 1 Mi characters stops (each level is ten of the one below).
  let subset = '<!ENTITY l0 "' + 'x'.repeat(100) + '">';
  for (let i = 1; i < 6; i++) subset += `<!ENTITY l${i} "${`&l${i - 1};`.repeat(10)}">`;
  assert.throws(() => readXMLTree(`<!DOCTYPE a [${subset}]><a>&l5;</a>`, 'T'), /expand past/);
  assert.throws(() => readXMLTree('<!DOCTYPE a [<!ENTITY e "x">', 'T'), /unterminated DOCTYPE/);
});

test('line ends and attribute whitespace are normalized; character references must name a Char (2.2, 2.11, 3.3.3)', () => {
  const root = readXMLTree('<a v="1\r\n2\t3\n4">x\r\ny\rz&#13;</a>', 'T');
  assert.equal(root.children[0].attributes.v, '1 2 3 4');
  assert.equal(root.children[0].text, 'x\ny\nz\r');
  assert.equal(readXMLTree('<a v="&#10;"/>', 'T').children[0].attributes.v, '\n');
  for (const bad of ['&#0;', '&#xD800;', '&#xFFFE;', '&#x110000;', '&#8;'])
    assert.throws(() => readXMLTree(`<a>${bad}</a>`, 'T'), /invalid character reference/);
});

test('decodeXML follows the encoding of the XML declaration (4.3.3)', () => {
  const latin = new Uint8Array([...new TextEncoder().encode('<?xml version="1.0" encoding="ISO-8859-1"?><a>'), 0xe9, ...new TextEncoder().encode('</a>')]);
  assert.equal(readXMLTree(decodeXML(latin), 'T').children[0].text, 'é');
  assert.equal(decodeXML(new TextEncoder().encode("<?xml version='1.0' encoding='UTF-8'?><a>é</a>")).endsWith('é</a>'), true);
  assert.throws(() => decodeXML(new TextEncoder().encode('<?xml version="1.0" encoding="x-no-such"?><a/>')), /cannot be decoded/);
});
