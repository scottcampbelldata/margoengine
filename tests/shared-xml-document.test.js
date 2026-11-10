import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXMLDocument } from '../packages/shared/xml-document.js';
import { escapeXML } from '../packages/shared/xml-escape.js';

const SVG = 'http://www.w3.org/2000/svg';

test('XML reader resolves default and prefixed namespaces, attributes, text, CDATA and source offsets', () => {
  const text =
    '<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">' +
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="urn:x" width="2">\r\n<x:a x:k="1&#10;2" k=\'a\tb\'>t&lt;&amp;<![CDATA[<raw>]]><!-- c --></x:a><g id="g"/></svg>';
  const doc = parseXMLDocument(text),
    root = doc.documentElement,
    [a, g] = root.children;
  assert.equal(root.namespaceURI, SVG);
  assert.equal(root.getAttribute('width'), '2');
  assert.equal(a.localName, 'a');
  assert.equal(a.prefix, 'x');
  assert.equal(a.namespaceURI, 'urn:x');
  assert.equal(a.getAttributeNS('urn:x', 'k'), '1\n2', 'character references are not normalised');
  assert.equal(a.getAttribute('k'), 'a b', 'literal tabs in attribute values become spaces');
  assert.equal(a.getAttributeNS(null, 'k'), 'a b');
  assert.equal(a.textContent, 't<&<raw>');
  assert.deepEqual(
    a.childNodes.map((n) => n.nodeType),
    [3, 4, 8],
  );
  assert.equal(root.childNodes[0].data, '\n', 'CRLF becomes LF in text');
  assert.equal(doc.getElementById('g'), g);
  assert.equal(g.namespaceURI, SVG);
  assert.equal(text.slice(g.start, g.end), '<g id="g"/>');
  assert.equal(text.slice(root.contentStart, root.contentStart + 2), '\r\n');
  assert.equal(doc.getElementsByTagNameNS('urn:x', 'a')[0], a);
  assert.equal(root.attributes.find((n) => n.name === 'xmlns').namespaceURI, 'http://www.w3.org/2000/xmlns/');
});

test('XML reader refuses malformed and hostile documents instead of guessing', () => {
  for (const [text, reason] of [
    ['<a><b></a>', /does not match/],
    ['<a>', /ends inside/],
    ['<a/><b/>', /more than one root/],
    ['x<a/>', /outside the root/],
    ['<a b="1" b="2"/>', /duplicate attribute/],
    ['<a xmlns:p="u" xmlns:q="u" p:b="1" q:b="2"/>', /same name/],
    ['<p:a/>', /not declared/],
    ['<a b=1/>', /not quoted/],
    ['<a b="<"/>', /"<" in the value/],
    ['<a b="1"c="2"/>', /white space/],
    ['<a>&foo;</a>', /undefined entity/],
    ['<a>&amp</a>', /unterminated entity/],
    ['<a>&#0;</a>', /invalid character reference/],
    ['<a>&#xD800;</a>', /invalid character reference/],
    ['<a>\u0001</a>', /U\+1 is not allowed/],
    ['<a>]]></a>', /"]]>" in text/],
    ['<a><!-- a -- b --></a>', /inside a comment/],
    ['<!DOCTYPE a [<!ENTITY e "x">]><a>&e;</a>', /internal subset/],
    ['<a/><?xml version="1.0"?>', /must start/],
    ['<a xmlns:xml="urn:other"/>', /invalid namespace declaration/],
    ['<a xmlns:p=""/>', /invalid namespace declaration/],
    ['<1a/>', /invalid element/],
    ['', /no root/],
  ])
    assert.throws(() => parseXMLDocument(text), reason, text);
  assert.throws(() => parseXMLDocument('<a><a><a/></a></a>', { maxDepth: 2 }), /deeper than 2/);
  assert.throws(() => parseXMLDocument('<a><b/><c/></a>', { maxElements: 2 }), /more than 2 elements/);
  assert.throws(
    () =>
      parseXMLDocument('<a', {
        fail: (reason) => {
          throw new RangeError(`own: ${reason}`);
        },
      }),
    /^RangeError: own: unterminated start tag <a> \(line 1\)$/,
  );
});

test('XML reader keeps markup-shaped file text as data and prefixes such as __proto__ as plain names', () => {
  const hostile = '"><script>alert(1)</script><img src=x onerror=alert(1)>';
  const doc = parseXMLDocument(`<a t="${escapeXML(hostile)}" xmlns:__proto__="urn:p">${escapeXML(hostile)}</a>`);
  assert.equal(doc.documentElement.getAttribute('t'), hostile);
  assert.equal(doc.documentElement.textContent, hostile);
  assert.equal(doc.documentElement.children.length, 0);
  assert.equal({}.polluted, undefined);
  const p = parseXMLDocument('<a xmlns:__proto__="urn:p"><__proto__:b/></a>').documentElement.children[0];
  assert.equal(p.namespaceURI, 'urn:p');
  assert.equal(escapeXML(`&<>"'`), '&amp;&lt;&gt;&quot;&apos;');
});
