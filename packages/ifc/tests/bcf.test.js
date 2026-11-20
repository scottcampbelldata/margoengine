import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IfcAPI } from 'web-ifc';
import { readZipDirectory } from '@margoengine/loaders/common';
import { openIFC } from '../dist/index.js';
import { readIFCData } from '../dist/data.js';
import {
  readBCF,
  writeBCF,
  parseBCFViewpoint,
  writeBCFViewpoint,
  viewpointFromBCFJSON,
  viewpointToBCFJSON,
  viewFromBCF,
  bcfFromView,
  newBCFGuid,
} from '../dist/bcf.js';

// buildingSMART BCF-XML test cases (tests/fixtures/bcf/NOTICE.md), against the Architectural.ifc they were made on.
const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/bcf/${name}`, import.meta.url)));
const api = new IfcAPI();
await api.Init();
const model = openIFC(api, fixture('Architectural.ifc'));
const data = readIFCData(model);
model.close();
const SPACE = data.byGlobalId.get('1bbI761TbBCOoIa5Kt6PXt');
const PLATE = data.byGlobalId.get('32HeOfyn55zOiSkf6rlfHs');
const close = (a, b, eps = 1e-9) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < eps);

test('official BCF 3.0 and 2.1 cases: one visible space, one visible curtain-wall plate', async () => {
  for (const name of ['v30-single-visible-space.bcf', 'v21-single-visible-space.bcf']) {
    const archive = await readBCF(fixture(name));
    const view = viewFromBCF(archive.topics[0].viewpoints[0], data);
    assert.deepEqual(view.visible, [SPACE], name);
    assert.equal(view.unresolved.length, 0);
    assert.equal(view.visible.length + view.hidden.length, 220);
  }
  for (const name of ['v30-one-part-visible.bcf', 'v21-one-part-visible.bcf']) {
    const archive = await readBCF(fixture(name));
    const [topic] = archive.topics;
    assert.equal(topic.title, 'One plate visible');
    // The markup's viewpoint GUID wins over the .bcfv's own (the 2.1 case names another one inside the file).
    assert.equal(topic.viewpoints[0].guid, 'e5c663c1-ad6f-4067-b861-65b7584e4cfa');
    assert.ok(topic.viewpoints[0].snapshot.data.length > 1000 && topic.viewpoints[0].snapshot.format === 'png');
    assert.deepEqual(viewFromBCF(topic.viewpoints[0], data).visible, [PLATE]);
  }
  const v21 = (await readBCF(fixture('v21-one-part-visible.bcf'))).topics[0];
  assert.equal(v21.viewpoints[0].camera.aspectRatio, 1, 'BCF 2.1 has no AspectRatio: 1, as BCF 3.0 asks');
  assert.equal(v21.assignedTo, undefined, 'an empty element is absent');
  assert.equal(v21.index, 0);
});

test('cameras convert to engine axes: orthogonal height, aspect, Z-up direction becomes -Y', async () => {
  const archive = await readBCF(fixture('v30-orthogonal-camera.bcf'));
  const vp = archive.topics[0].viewpoints[0];
  assert.equal(vp.camera.type, 'orthogonal');
  const view = viewFromBCF(vp, data, { origin: [1, 2, 3], targetDistance: 5 });
  const c = view.camera;
  assert.ok(close(c.direction, [0, -1, 0]) && close(c.up, [-1, 0, 0]));
  assert.ok(close(c.position, [vp.camera.position[0] - 1, vp.camera.position[2] - 2, -vp.camera.position[1] - 3]));
  assert.ok(close(c.target, [c.position[0], c.position[1] - 5, c.position[2]]));
  assert.equal(c.height, vp.camera.viewToWorldScale);
  assert.equal(c.aspect, vp.camera.aspectRatio);
  // The two spaces and the openings are hidden by the hints; everything else is shown.
  assert.ok(view.hidden.includes(SPACE) && view.visible.length > 200);
  assert.ok(view.hidden.every((id) => /^Ifc(Space|OpeningElement)$/.test(data.elements.get(id).type)));
});

test('a container listed in exceptions or colouring applies to its parts (aggregation), not to contained elements', () => {
  const wall = data.elements.get(PLATE).aggregate;
  assert.equal(data.elements.get(wall).type, 'IfcCurtainWall');
  const parts = [...data.elements.values()].filter((e) => e.aggregate === wall).map((e) => e.id);
  assert.ok(parts.length > 3);
  const guid = data.elements.get(wall).globalId;
  const vp = parseBCFViewpoint(
    `<VisualizationInfo Guid="${newBCFGuid()}"><Components><Selection><Component IfcGuid="${guid}"/></Selection>` +
      `<Visibility DefaultVisibility="false"><Exceptions><Component IfcGuid="${guid}"/><Component IfcGuid="0000000000000000000000"/></Exceptions></Visibility>` +
      `<Coloring><Color Color="80FF0000"><Components><Component IfcGuid="${guid}"/></Components></Color></Coloring></Components>` +
      '<PerspectiveCamera><CameraViewPoint><X>0</X><Y>0</Y><Z>0</Z></CameraViewPoint><CameraDirection><X>1</X><Y>0</Y><Z>0</Z></CameraDirection>' +
      '<CameraUpVector><X>0</X><Y>0</Y><Z>1</Z></CameraUpVector><FieldOfView>60</FieldOfView><AspectRatio>2</AspectRatio></PerspectiveCamera></VisualizationInfo>',
  );
  const view = viewFromBCF(vp, data);
  assert.deepEqual(view.visible, [wall, ...parts].sort((a, b) => a - b));
  assert.deepEqual(view.selected, view.visible);
  assert.deepEqual(view.colors.get(parts[0]), [1, 0, 0, 128 / 255]);
  assert.equal(view.colors.size, parts.length + 1);
  assert.deepEqual(view.unresolved, [{ ifcGuid: '0000000000000000000000' }]);
  // A storey in the exceptions shows the storey, not the elements contained in it.
  const storey = [...data.elements.values()].find((e) => e.type === 'IfcBuildingStorey');
  const only = viewFromBCF({ ...vp, exceptions: [{ ifcGuid: storey.globalId }], coloring: [], selection: [] }, data);
  assert.deepEqual(only.visible, [storey.id]);
});

test('bcfFromView encodes with the BCF 3.0 rules and viewFromBCF reads the same view back', () => {
  const products = [...viewFromBCF({ ...blank(), defaultVisibility: true, spacesVisible: true, openingsVisible: true }, data).visible];
  assert.equal(products.length, 220);
  // Only one space shown: the official case's encoding (DefaultVisibility false, hints false, the space as exception).
  const one = bcfFromView({ hidden: products.filter((id) => id !== SPACE) }, data);
  assert.equal(one.defaultVisibility, false);
  assert.equal(one.spacesVisible, false);
  assert.deepEqual(one.exceptions, [{ ifcGuid: '1bbI761TbBCOoIa5Kt6PXt' }]);
  // One wall hidden, spaces and openings hidden: default true, the hints hide spaces and openings, one exception.
  const wall = [...data.elements.values()].find((e) => e.type === 'IfcWallStandardCase').id;
  const hiddenSet = products.filter((id) => id === wall || /^Ifc(Space|OpeningElement)$/.test(data.elements.get(id).type));
  const vp = bcfFromView(
    {
      hidden: hiddenSet,
      selected: [PLATE],
      colors: new Map([[PLATE, [0, 0.5, 1, 0.25]]]),
      camera: { position: [10, 5, -3], target: [0, 1, 0], fov: 45, aspect: 16 / 9 },
      clippingPlanes: [[0, -1, 0, 3]],
      lines: [{ start: [0, 0, 0], end: [1, 2, 3] }],
    },
    data,
    { origin: [100, 0, -50] },
  );
  assert.equal(vp.defaultVisibility, true);
  assert.equal(vp.spacesVisible, false);
  assert.equal(vp.openingsVisible, false);
  assert.deepEqual(vp.exceptions, [{ ifcGuid: data.elements.get(wall).globalId }]);
  assert.deepEqual(vp.coloring, [{ color: '400080FF', components: [{ ifcGuid: '32HeOfyn55zOiSkf6rlfHs' }] }]);
  assert.match(vp.guid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // IFC axes: engine (10, 5, -3) + origin (100, 0, -50) = (110, 5, -53) is IFC (110, 53, 5).
  assert.ok(close(vp.camera.position, [110, 53, 5]));
  // The clipped side: the plane keeps y <= 3 in engine axes, so BCF's direction (into the clipped side) is IFC +Z.
  assert.ok(close(vp.clippingPlanes[0].direction, [0, 0, 1]));
  const back = viewFromBCF(parseBCFViewpoint(writeBCFViewpoint(vp)), data, { origin: [100, 0, -50] });
  assert.deepEqual(back.hidden, [...hiddenSet].sort((a, b) => a - b));
  assert.deepEqual(back.selected, [PLATE]);
  assert.deepEqual(back.colors.get(PLATE), [0, 128 / 255, 1, 64 / 255]);
  assert.ok(close(back.camera.position, [10, 5, -3]));
  const d = Math.hypot(10, 4, 3);
  assert.ok(close(back.camera.direction, [-10 / d, -4 / d, 3 / d]));
  assert.equal(back.camera.fov, 45);
  assert.ok(close(back.clippingPlanes[0], [0, -1, 0, 3]));
  assert.ok(close(back.lines[0].end, [1, 2, 3]));
  // A camera looking straight down with the default up still gets a valid, perpendicular up vector.
  const down = bcfFromView({ camera: { position: [0, 10, 0], target: [0, 0, 0] } }, data).camera;
  assert.ok(Math.abs(down.up[0] * down.direction[0] + down.up[1] * down.direction[1] + down.up[2] * down.direction[2]) < 1e-12);
});

function blank() {
  return {
    guid: newBCFGuid(),
    selection: [],
    defaultVisibility: false,
    exceptions: [],
    spacesVisible: false,
    spaceBoundariesVisible: false,
    openingsVisible: false,
    coloring: [],
    lines: [],
    clippingPlanes: [],
    bitmaps: [],
  };
}

test('archives round-trip through writeBCF: markup, comments, documents, snippets, related topics, extensions', async () => {
  for (const name of [
    'v30-related-topics.bcf',
    'v30-due-date.bcf',
    'v30-document-reference-external.bcf',
    'v30-single-visible-space.bcf',
    'v21-internal-bim-snippet.bcf',
    'v21-related-topics.bcf',
  ]) {
    const first = await readBCF(fixture(name));
    const version = first.version === '3.0' ? '3.0' : '2.1';
    const bytes = writeBCF(first, { version });
    const again = await readBCF(bytes);
    assert.deepEqual(again.topics, first.topics, name);
    assert.deepEqual(again.project, first.project, name);
    if (version === '3.0') assert.deepEqual(again.extensions, first.extensions, name);
    // Folders have their own entries and every path uses forward slashes, as the BCF zip guide asks.
    const names = readZipDirectory(bytes).map((e) => e.name);
    for (const t of first.topics) assert.ok(names.includes(`${t.guid}/`) && names.includes(`${t.guid}/markup.bcf`));
  }
  const related = await readBCF(fixture('v30-related-topics.bcf'));
  assert.equal(related.topics.length, 2);
  const b = related.topics.find((t) => t.title === 'Related topic B');
  assert.deepEqual(b.relatedTopics, ['c69c8879-bd4a-4182-a759-f3c8c5b47c94']);
  assert.equal(b.serverAssignedId, '3');
  assert.equal(b.files.length, 2);
  assert.equal(b.comments[0].author, 'Architect@example.com');
  const snippet = (await readBCF(fixture('v21-internal-bim-snippet.bcf'))).topics[0].bimSnippet;
  assert.equal(snippet.type, 'JSON');
  assert.ok(snippet.data.length > 0 && !snippet.isExternal);
  const external = (await readBCF(fixture('v30-document-reference-external.bcf'))).topics[0];
  assert.match(external.documentReferences[0].url, /markup\.xsd/);
  const due = (await readBCF(fixture('v30-due-date.bcf'))).topics[0];
  assert.ok(due.dueDate);
  // A BCF 3.0 archive written as 2.1 keeps every field 2.1 has.
  const down = await readBCF(writeBCF(related, { version: '2.1' }));
  assert.equal(down.version, '2.1');
  assert.deepEqual(
    down.topics.map(({ serverAssignedId, ...t }) => t),
    related.topics.map(({ serverAssignedId, ...t }) => t),
  );
});

test('viewpoints: BCF 3.0 and 2.1 XML, BCF-API JSON with snapshots and bitmaps, BCF 1.0 components', () => {
  const vp = {
    ...blank(),
    camera: { type: 'perspective', position: [1, 2, 3], direction: [0, 1, 0], up: [0, 0, 1], fieldOfView: 50, aspectRatio: 1.5 },
    selection: [{ ifcGuid: '1bbI761TbBCOoIa5Kt6PXt', originatingSystem: 'Tool <A&B>' }],
    exceptions: [{ authoringToolId: '4711' }],
    spacesVisible: true,
    coloring: [{ color: 'FF0000', components: [{ ifcGuid: '32HeOfyn55zOiSkf6rlfHs' }] }],
    lines: [{ start: [0, 0, 0], end: [1, 1, 1] }],
    clippingPlanes: [{ location: [0, 0, 2], direction: [0, 0, 1] }],
    bitmaps: [{ format: 'jpg', reference: 'note.jpg', location: [1, 1, 1], normal: [0, 0, 1], up: [0, 1, 0], height: 2 }],
  };
  assert.deepEqual(parseBCFViewpoint(writeBCFViewpoint(vp)), vp);
  const v21 = writeBCFViewpoint(vp, { version: '2.1' });
  assert.ok(!v21.includes('AspectRatio') && !v21.includes('<Components><Component') && /<Components><ViewSetupHints/.test(v21));
  assert.deepEqual(parseBCFViewpoint(v21), { ...vp, camera: { ...vp.camera, aspectRatio: 1 } });
  const withImages = {
    ...vp,
    snapshot: { format: 'png', data: new Uint8Array([137, 80, 78, 71, 0, 255]) },
    bitmaps: [{ ...vp.bitmaps[0], data: new Uint8Array([255, 216, 255]) }],
    index: 2,
  };
  const json = JSON.parse(JSON.stringify(viewpointToBCFJSON(withImages)));
  assert.equal(json.perspective_camera.field_of_view, 50);
  assert.equal(json.components.visibility.view_setup_hints.spaces_visible, true);
  assert.equal(json.snapshot.snapshot_data, 'iVBORwD/');
  const back = viewpointFromBCFJSON(json);
  assert.deepEqual(back.snapshot, withImages.snapshot);
  assert.deepEqual(back.bitmaps[0].data, withImages.bitmaps[0].data);
  assert.deepEqual({ ...back, bitmaps: [] }, { ...withImages, bitmaps: [] });
  // BCF 1.0: Selected, Visible and Color on each Component.
  const legacy = parseBCFViewpoint(
    '<VisualizationInfo><Components><Component IfcGuid="1bbI761TbBCOoIa5Kt6PXt" Selected="true" Visible="false" Color="00FF00"/></Components></VisualizationInfo>',
  );
  assert.equal(legacy.defaultVisibility, true);
  assert.deepEqual(legacy.exceptions, [{ ifcGuid: '1bbI761TbBCOoIa5Kt6PXt' }]);
  assert.deepEqual(legacy.selection, legacy.exceptions);
  assert.equal(legacy.coloring[0].color, '00FF00');
  // AuthoringToolId resolves against the element's Tag when no IfcGuid matches.
  const elements = new Map(data.elements);
  elements.set(PLATE, { ...data.elements.get(PLATE), tag: '4711' });
  const view = viewFromBCF({ ...blank(), exceptions: [{ authoringToolId: '4711' }] }, { ...data, elements });
  assert.deepEqual(view.visible, [PLATE]);
});

test('malformed or incomplete input rejects with a named LoaderError', async () => {
  assert.throws(() => parseBCFViewpoint('<VisualizationInfo><Components>'), { name: 'LoaderError', code: 'syntax' });
  assert.throws(() => parseBCFViewpoint('<Markup/>'), { code: 'syntax' });
  assert.throws(
    () => parseBCFViewpoint('<VisualizationInfo><PerspectiveCamera><CameraViewPoint><X>a</X></CameraViewPoint></PerspectiveCamera></VisualizationInfo>'),
    { code: 'syntax' },
  );
  assert.throws(() => writeBCFViewpoint(blank()), { code: 'range' }, 'BCF 3.0 needs a camera');
  assert.match(writeBCFViewpoint(blank(), { version: '2.1' }), /<VisualizationInfo Guid=/);
  assert.throws(() => writeBCFViewpoint({ ...blank(), guid: 'ABC' }, { version: '2.1' }), { code: 'range' });
  assert.throws(() => writeBCF({ topics: [{ guid: newBCFGuid(), title: '' }] }), { code: 'range' });
  await assert.rejects(readBCF(new Uint8Array([1, 2, 3])), { name: 'LoaderError' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readBCF(fixture('v30-due-date.bcf'), { signal: controller.signal }), { code: 'aborted' });
  assert.throws(() => bcfFromView({ selected: [123456789] }, data), { code: 'range' });
});
