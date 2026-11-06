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
