// The porting guides. Fixtures use a made-up library, Acme, so this package names no other engine (clean-room gate);
// the shipped-guide test reads the library name and the row count from the docs themselves.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMargoServer } from '../dist/index.js';
import {
  createPortingTool,
  formatPorting,
  headingAnchor,
  loadPortingGuides,
  lookupPorting,
  parsePortingGuide,
  portingGuidesFromCorpus,
} from '../dist/porting.js';
import { corpus, repository } from './support.js';

const matrix = `# Acme 9 parity matrix

## Summary

| Status | Count | Meaning |
| --- | --- | --- |
| COVERED | 2 | ignored: not under Matrix |

## Matrix

### 1. Controls

| Acme | Status | Margo | Shows it | Notes |
| --- | --- | --- | --- | --- |
| OrbitControls, MapControls | COVERED | controls \`OrbitControls\` (\`@margoengine/controls/orbit\`) | [page](https://margoengine.com/demos/orbit.html) | Damping on. |
| ArcballControls | COVERED † | controls \`ArcballControls\` | | |

### 2. Lights

| Acme | Status | Margo | Shows it | Notes |
| --- | --- | --- | --- | --- |
| PointLight shadows | PARTIAL | shadows \`PointShadows\` | | Cube maps only. |
| StereoCamera | NOT PLANNED | | | Use xr. |

## What is missing

| Row | What is missing | What to do |
| --- | --- | --- |
| Meshlets | PARTIAL | ignored: three columns |
`;

const guide = `# Coming from Acme

## Contents

- [Controls](#controls)

## Controls

Orbit around a target.

\`\`\`js
const controls = new OrbitControls(camera, canvas);
\`\`\`

\`\`\`ts
OrbitControls.attach(engine);
\`\`\`

## Lights and shadows

\`\`\`ts
// ## not a heading inside a fence
PointShadows.attach(engine);
\`\`\`
`;

const sources = { matrix: 'docs/acme-parity.md', guide: 'docs/from-acme.md' };

test('parsePortingGuide reads the library, the Matrix rows by area and the guide sections with their code', () => {
  const parsed = parsePortingGuide(matrix, guide, sources);
  assert.equal(parsed.library, 'Acme 9', 'the title names the version');
  assert.equal(parsed.matrix, 'docs/acme-parity.md');
  assert.deepEqual(
    parsed.rows.map((row) => [row.area, row.from, row.status]),
    [
      ['Controls', 'OrbitControls, MapControls', 'COVERED'],
      ['Controls', 'ArcballControls', 'COVERED'],
      ['Lights', 'PointLight shadows', 'PARTIAL'],
      ['Lights', 'StereoCamera', 'NOT PLANNED'],
    ],
  );
  assert.equal(parsed.rows[0].page, 'https://margoengine.com/demos/orbit.html');
  assert.equal(parsed.rows[0].margo, 'controls `OrbitControls` (`@margoengine/controls/orbit`)');
  assert.equal(parsed.rows[1].page, undefined);
  assert.deepEqual(
    parsed.sections.map((section) => [section.title, section.anchor]),
    [
      ['Controls', '#controls'],
      ['Lights and shadows', '#lights-and-shadows'],
    ],
    'Contents is skipped and a ## line inside a code fence is not a heading',
  );
  assert.equal(parsed.sections[0].from, 'const controls = new OrbitControls(camera, canvas);');
  assert.equal(parsed.sections[0].margo, 'OrbitControls.attach(engine);');
  assert.equal(parsed.sections[1].from, undefined);
  assert.throws(() => parsePortingGuide(undefined), { name: 'TypeError', message: /errors#mcp/ });
  assert.throws(() => parsePortingGuide('# no table'), { name: 'RangeError', message: /Status, Margo, Shows it/ });
});

test('portingGuidesFromCorpus finds each matrix page and joins its "Coming from" guide', () => {
  const docs = [
    { path: 'docs/notes.md', title: 'Notes', text: '# Notes\n\n## Matrix\n\nNo table here.\n' },
    { path: sources.guide, title: 'Coming from Acme', text: guide },
    { path: sources.matrix, title: 'Acme 9 parity matrix', text: matrix },
  ];
  const [found, ...rest] = portingGuidesFromCorpus({ docs });
  assert.equal(rest.length, 0, 'a page without the matrix table is not a guide');
  assert.equal(found.library, 'Acme 9');
  assert.equal(found.matrix, sources.matrix);
  assert.equal(found.guide, sources.guide);
  assert.equal(found.sections.length, 2);
});

test('headingAnchor makes the anchors GitHub gives headings', () => {
  assert.equal(headingAnchor('Renderer, scene, camera and resize'), 'renderer-scene-camera-and-resize');
  assert.equal(headingAnchor('Large coordinates (floating origin)'), 'large-coordinates-floating-origin');
  assert.equal(headingAnchor('Caching and offline (`ACME.Cache`)'), 'caching-and-offline-acmecache');
});

test('lookupPorting puts the row that names the class first and attaches the section with its code', () => {
  const parsed = parsePortingGuide(matrix, guide, sources);
  const [first, second] = lookupPorting(parsed, 'ACME.OrbitControls');
  assert.equal(first.row.from, 'OrbitControls, MapControls', 'the upper-case namespace is ignored');
  assert.equal(first.section.title, 'Controls');
  assert.equal(second.row.from, 'ArcballControls', 'a row that shares the Controls part comes after');
  assert.ok(first.score > second.score);
  const shadows = lookupPorting(parsed, 'point light shadow');
  assert.equal(shadows[0].row.from, 'PointLight shadows', 'words and plurals match a PascalCase name');
  assert.equal(shadows[0].section.title, 'Lights and shadows');
  assert.equal(lookupPorting(parsed, 'StereoCamera')[0].section, undefined, 'no section shares enough words');
  assert.deepEqual(lookupPorting(parsed, 'the and of'), [], 'stop words alone match nothing');
  assert.deepEqual(lookupPorting(parsed, 'Acme'), [], 'the library name alone matches nothing');
  assert.equal(lookupPorting(parsed, 'controls', 1).length, 1);
  assert.throws(() => lookupPorting(parsed, ' '), { name: 'TypeError' });
});

test('the shipped guide has every matrix row and maps the common names', async () => {
  const shipped = await loadPortingGuides();
  assert.ok(shipped.length >= 1);
  const [main] = shipped;
  assert.ok(main.matrix && main.guide, 'the shipped guide records its matrix and guide pages');
  const source = readFileSync(join(repository, main.matrix), 'utf8');
  const name = main.library.split(' ')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const total = new RegExp(`(\\d+) ${name} features in \\d+ areas`).exec(source)?.[1];
  assert.ok(total, 'the matrix Summary counts its rows');
  assert.equal(main.rows.length, Number(total), 'one row per feature the matrix Summary counts');
  const expect = {
    OrbitControls: [/OrbitControls/, 'Controls'],
    InstancedMesh: [/^InstancedMesh$/, 'Instancing'],
    Raycaster: [/^Raycaster$/, 'Raycasting and picking'],
    EffectComposer: [/EffectComposer/, 'Post-processing'],
    AnimationMixer: [/AnimationMixer/, 'Animation'],
    TextGeometry: [/TextGeometry/, 'Lines, points, text and labels'],
  };
  for (const [query, [row, section]] of Object.entries(expect)) {
    const [best] = lookupPorting(main, query);
    assert.match(best.row.from, row, query);
    assert.equal(best.section?.title, section, `${query} links the guide section`);
    assert.ok(best.section.margo.length > 10, `${query} carries Margo code`);
  }
  assert.equal(lookupPorting(main, 'StereoCamera')[0].row.status, 'NOT PLANNED');
});

test('port_to_margo answers with the row, the code and structured matches, and rejects bad arguments', async () => {
  const parsed = parsePortingGuide(matrix, guide, sources);
  const tool = createPortingTool([parsed]);
  assert.equal(tool.name, 'port_to_margo');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(tool.inputSchema.properties.from.enum, ['Acme 9']);
  const context = { signal: new AbortController().signal };
  const result = await tool.run({ name: 'OrbitControls', limit: 1 }, context);
  const text = result.content[0].text;
  assert.match(text, /1\. OrbitControls, MapControls {2}\[COVERED, Controls\]/);
  assert.match(text, /Margo: controls `OrbitControls`/);
  assert.match(text, /Guide: docs\/from-acme\.md#controls \(Controls\)/);
  assert.match(text, /Acme 9:\n```js\nconst controls = new OrbitControls\(camera, canvas\);\n```/);
  assert.match(text, /```ts\nOrbitControls\.attach\(engine\);\n```/);
  assert.match(text, /Source: docs\/acme-parity\.md$/);
  assert.equal(result.structuredContent.library, 'Acme 9');
  assert.equal(result.structuredContent.matches.length, 1);
  assert.equal(result.structuredContent.matches[0].guide.page, 'docs/from-acme.md#controls');
  assert.equal((await tool.run({ name: 'OrbitControls', from: 'acme' }, context)).structuredContent.library, 'Acme 9');
  const none = await tool.run({ name: 'qwertyuiop' }, context);
  assert.deepEqual(none.structuredContent.matches, []);
  assert.equal(none.content[0].text, formatPorting(parsed, 'qwertyuiop', []));
  assert.match(none.content[0].text, /^No Acme 9 row matches "qwertyuiop"/);
  assert.throws(() => tool.run({}, context), { name: 'TypeError', message: /name is required/ });
  assert.throws(() => tool.run({ name: 'x', from: 3 }, context), { name: 'TypeError', message: /from must be a string/ });
  assert.throws(() => tool.run({ name: 'x', from: 'Other' }, context), {
    name: 'RangeError',
    message: /No porting guide for "Other"; there are guides for Acme 9/,
  });
  assert.throws(() => tool.run({ name: 'x', limit: 1.5 }, context), { name: 'TypeError' });
  assert.throws(() => tool.run({ name: 'x', limit: 99 }, context), { name: 'RangeError' });
  assert.throws(() => createPortingTool([]), { name: 'TypeError', message: /at least one guide/ });
});

test('the Margo server lists port_to_margo and answers it over JSON-RPC', async () => {
  using server = await createMargoServer({ corpus, projectRoot: repository });
  const listed = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.ok(listed.result.tools.some((tool) => tool.name === 'port_to_margo'));
  const answer = await server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'port_to_margo', arguments: { name: 'GLTFLoader' } },
  });
  assert.equal(answer.result.isError, undefined);
  assert.match(answer.result.content[0].text, /GLTFLoader/);
  assert.match(answer.result.content[0].text, /@margoengine\/gltf|loadGLTF|addGLTF/);
});

test('loadPortingGuides rejects a missing file with a coded error and honours an aborted signal', async () => {
  await assert.rejects(loadPortingGuides(join(repository, 'no-such-porting.json')), { code: 'failed' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadPortingGuides(join(repository, 'package.json'), controller.signal), { name: 'AbortError' });
});
