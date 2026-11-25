import test from 'node:test';
import assert from 'node:assert/strict';
import { exportUSDZ } from '../dist/usdz.js';
import { readZipDirectory, readZipEntry } from '@margoengine/loaders';

const quad = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: [0, 1, 2, 0, 2, 3],
};
const scene = {
  nodes: [
    { name: 'Cube', geometry: quad },
    { name: 'Lid', geometry: quad },
  ],
};
const usda = async (archive) => new TextDecoder().decode(await readZipEntry(archive, readZipDirectory(archive)[0]));

test("a tap behaviour is written in the Preliminary_Behavior form of Apple's USDZ schemas", async () => {
  const text = await usda(
    exportUSDZ(scene, {
      behaviors: [
        {
          triggers: [{ type: 'tap', targets: ['Cube'] }],
          actions: [
            { type: 'emphasize', targets: ['Cube'], motion: 'flip', duration: 0.5 },
            {
              type: 'group',
              actions: [
                { type: 'wait', duration: 1 },
                { type: 'hide', targets: [1] },
              ],
              repeat: 1,
            },
          ],
        },
      ],
    }),
  );
  assert.match(text, /def Preliminary_Behavior "Behavior_0"/);
  assert.match(text, /rel triggers = \[<Trigger_0_0>\]/);
  assert.match(text, /def Preliminary_Trigger "Trigger_0_0" \( inherits = <\/TapGestureTrigger> \)/);
  assert.match(text, /rel affectedObjects = \[<\/Margo\/Mesh_0>\]/);
  assert.match(text, /def Preliminary_Action "Action_0" \( inherits = <\/EmphasizeAction> \)/);
  assert.match(text, /uniform token motionType = "flip"/);
  assert.match(text, /uniform double duration = 0\.5/);
  assert.match(text, /inherits = <\/GroupAction>/);
  assert.match(text, /uniform token type = "serial"/);
  assert.match(text, /uniform uint performCount = 1/);
  assert.match(text, /inherits = <\/WaitAction>/);
  assert.match(
    text,
    /inherits = <\/VisibilityAction>[\s\S]*rel affectedObjects = \[<\/Margo\/Mesh_1>\][\s\S]*uniform token type = "hide"/,
  );
  // the group's children are nested inside it, where its relative `rel actions` paths resolve
  const group = text.slice(text.indexOf('"Action_1"'));
  assert.ok(group.indexOf('"Action_2"') > 0 && group.indexOf('"Action_3"') > group.indexOf('"Action_2"'));
  assert.match(text, /rel actions = \[<Action_0>, <Action_1>\]/);
});

test('no behaviours, no Behaviors scope; the meshes still load', async () => {
  const plain = exportUSDZ(scene);
  assert.ok(!(await usda(plain)).includes('Preliminary'));
  const withBehavior = exportUSDZ(scene, {
    behaviors: [
      { triggers: [{ type: 'tap', targets: ['Cube'] }], actions: [{ type: 'emphasize', targets: ['Cube'] }] },
    ],
  });
  assert.match(await usda(withBehavior), /motionType = "flip"/);
});

test('bad behaviours are refused', () => {
  const tap = { type: 'tap', targets: ['Cube'] };
  const flip = { type: 'emphasize', targets: ['Cube'] };
  const bad = (behaviors) => assert.throws(() => exportUSDZ(scene, { behaviors }), RangeError);
  bad([{ triggers: [], actions: [flip] }]);
  bad([{ triggers: [tap], actions: [] }]);
  bad([{ triggers: [{ type: 'tap', targets: ['Nope'] }], actions: [flip] }]);
  bad([{ triggers: [{ type: 'tap', targets: [9] }], actions: [flip] }]);
  bad([{ triggers: [{ type: 'tap', targets: [] }], actions: [flip] }]);
  bad([{ triggers: [{ type: 'proximity' }], actions: [flip] }]);
  bad([{ triggers: [tap], actions: [{ type: 'wait', duration: -1 }] }]);
  bad([{ triggers: [tap], actions: [{ type: 'emphasize', targets: ['Cube'], motion: 'a"b' }] }]);
  bad([{ triggers: [tap], actions: [{ type: 'group', actions: [] }] }]);
  bad([{ triggers: [tap], actions: [{ type: 'group', actions: [flip], repeat: 1.5 }] }]);
  bad([{ triggers: [tap], actions: [{ type: 'spin' }] }]);
});
