import assert from 'node:assert/strict';
import test from 'node:test';
import { ConstraintsInteractionRecorder } from '../examples/kinematics-constraints-recorder.js';
import { createConstraintDemo } from '../examples/kinematics-constraints-controller.js';

function cell(recording, row, name) {
  const index = recording.columns.indexOf(name);
  assert.notEqual(index, -1, name);
  return recording.frames[row][index];
}

test('recording is opt-in and disabled calls do not inspect controller or event-like inputs', () => {
  const recorder = new ConstraintsInteractionRecorder({ capacity: 3 });
  const unreadable = new Proxy({}, { get() { throw new Error('Unexpected read'); } });
  assert.equal(recorder.recording, false);
  assert.equal(recorder.recordFrame(unreadable, NaN), false);
  assert.equal(recorder.mark(unreadable, unreadable, NaN), false);
  assert.equal(recorder.stop(), false);
  const json = JSON.parse(recorder.serialize());
  assert.equal(json.totalFrames, 0);
  assert.deepEqual(json.frames, []);
  assert.deepEqual(json.actions, []);
  assert.match(json.semantics.clearance, /not continuous/);
  assert.match(json.semantics.coverage, /not every browser pointer event/);
  assert.equal(json.controllerRevision, 'contact-normal-2');
  assert.match(json.semantics.outwardDetour, /full-chain package guards/);
});

test('actual controller trajectories and settings are copied without changing solver results', () => {
  const recorded = createConstraintDemo();
  const reference = createConstraintDemo();
  const recorder = new ConstraintsInteractionRecorder({ capacity: 200 });
  recorder.start(1000);
  const expectedHand = [];
  const expectedStatus = [];
  for (let frame = 0; frame < 180; frame++) {
    if (frame === 60) {
      for (const controller of [recorded, reference]) {
        controller.configure({ scene: 'mixed', minClearance: 0.012, damping: 0.08 });
        controller.solveOptions.searchBudget = 32;
        controller.solveOptions.swivelSpeedLimit = 0.7;
        controller.setClock('fixed120');
        controller.setYawAssist(true);
      }
      recorder.mark('scene', 'mixed', 1000 + frame * 16);
    }
    if (frame === 120) {
      recorded.setPaused(true);
      reference.setPaused(true);
      recorder.mark('pause', true, 1000 + frame * 16);
    }
    const x = 0.35 + Math.sin(frame * 0.04) * 0.6;
    const y = 0.9 + Math.cos(frame * 0.035) * 0.4;
    for (const controller of [recorded, reference]) {
      controller.setInteractiveTarget(x, y);
      controller.step(1 / 60);
    }
    const prior = [...recorded.currentHand, ...recorded.currentElbow, recorded.acceptedPole];
    assert.equal(recorder.recordFrame(recorded, 1000 + frame * 16), true);
    assert.deepEqual([...recorded.currentHand, ...recorded.currentElbow, recorded.acceptedPole], prior);
    assert.deepEqual([...recorded.currentHand], [...reference.currentHand]);
    assert.deepEqual([...recorded.currentElbow], [...reference.currentElbow]);
    assert.equal(recorded.result.status, reference.result.status);
    expectedHand.push([...recorded.currentHand]);
    expectedStatus.push(recorded.result.status);
  }
  recorder.stop(4000);
  const json = JSON.parse(recorder.serialize());
  assert.equal(json.totalFrames, 180);
  assert.equal(json.overwrittenFrames, 0);
  for (let frame = 0; frame < 180; frame++) {
    assert.equal(json.frames[frame].length, json.columns.length);
    assert.deepEqual(['handX', 'handY', 'handZ'].map(name => cell(json, frame, name)), expectedHand[frame]);
    assert.equal(cell(json, frame, 'status'), expectedStatus[frame]);
    assert.equal(cell(json, frame, 'scene'), frame >= 60 ? 1 : 0);
    assert.equal(cell(json, frame, 'clock'), frame >= 60 ? 2 : 0);
    assert.equal(cell(json, frame, 'paused'), frame >= 120 ? 1 : 0);
    assert.equal(cell(json, frame, 'searchBudget'), frame >= 60 ? 32 : 128);
  }
  assert.equal(cell(json, 100, 'requiredClearanceMeters'), 0.012);
  assert.equal(cell(json, 100, 'dampingSeconds'), 0.08);
  assert.equal(cell(json, 100, 'swivelSpeedLimitRadiansPerSecond'), 0.7);
  assert.equal(cell(json, 100, 'allowedPoleStepRadians'), 0.7 / 120);
  assert.equal(cell(json, 100, 'yawAssist'), 1);
  assert.equal(cell(json, 100, 'upperLengthMeters'), recorded.upperLength);
  assert.equal(cell(json, 100, 'lowerLengthMeters'), recorded.lowerLength);
  assert.equal(cell(json, 100, 'elbowRadiusMeters'), recorded.elbowRadius);
  assert.equal(cell(json, 100, 'forearmRadiusMeters'), recorded.forearmRadius);
  assert.equal(cell(json, 150, 'acceptedHandStepMeters'), 0);
  assert.equal(cell(json, 150, 'acceptedPoleStepRadians'), 0);
  assert.ok(json.columns.includes('lastSolveRootX'));
  assert.ok(json.columns.includes('commandTargetX'));
  assert.equal(cell(json, 150, 'outwardDetour'), 0);
  assert.match(json.semantics.requestedPoleAngle, /Not supplied/);
});

test('bounded rings preserve newest data in chronological order and disclose overwrites', () => {
  const controller = createConstraintDemo();
  const recorder = new ConstraintsInteractionRecorder({ capacity: 3, actionCapacity: 3 });
  recorder.start(500);
  for (let frame = 0; frame < 5; frame++) {
    controller.setTarget(0.8 + frame / 100, 0.7, 0.14);
    controller.step(1 / 60);
    recorder.mark('pointerdown', frame, 501 + frame * 10);
    recorder.recordFrame(controller, 502 + frame * 10);
  }
  assert.equal(recorder.full, true);
  assert.equal(recorder.frameCount, 3);
  assert.equal(recorder.overwrittenFrames, 2);
  recorder.stop(550);
  const json = JSON.parse(recorder.serialize());
  assert.deepEqual(json.frames.map(row => row[0]), [2, 3, 4]);
  assert.deepEqual(json.frames.map(row => row[1]), [22, 32, 42]);
  assert.equal(json.totalFrames, 5);
  assert.equal(json.overwrittenFrames, 2);
  assert.equal(json.totalActions, 7);
  assert.equal(json.overwrittenActions, 4);
  assert.deepEqual(json.actions.map(action => action.type), ['pointerdown', 'pointerdown', 'stop']);
  assert.deepEqual(json.actions.map(action => action.value), [3, 4, 0]);
  assert.equal(json.durationMs, 50);
});

test('exports stay immutable across live buffer edits, ring overwrites, clear and new sessions', () => {
  const controller = createConstraintDemo();
  const recorder = new ConstraintsInteractionRecorder({ capacity: 2 });
  recorder.start(10);
  recorder.recordFrame(controller, 11);
  assert.throws(() => recorder.serialize(), /Stop recording/);
  recorder.stop(12);
  const text = recorder.serialize();
  const original = JSON.parse(text);
  controller.currentHand.fill(123);
  assert.equal(recorder.serialize(), text);
  recorder.clear();
  assert.equal(recorder.frameCount, 0);
  assert.equal(recorder.durationMs, 0);
  recorder.start(20);
  for (let frame = 0; frame < 4; frame++) recorder.recordFrame(controller, 21 + frame);
  recorder.stop(25);
  assert.notEqual(recorder.serialize(), text);
  assert.deepEqual(JSON.parse(text), original);
  assert.notEqual(cell(original, 0, 'handX'), 123);
});

test('actions retain only bounded numeric values and fixed setting labels', () => {
  const recorder = new ConstraintsInteractionRecorder();
  recorder.start(0);
  recorder.mark('scene', 'mixed', 1);
  recorder.mark('clock', 'fixed60', 2);
  recorder.mark('yaw', true, 3);
  recorder.mark('gap', 0.008, 4);
  assert.throws(() => recorder.mark('pointermove', 1, 5), /Unknown recording action/);
  assert.throws(() => recorder.mark('scene', 'arbitrary user text', 5), /Unknown recording action value/);
  assert.throws(() => recorder.mark('pointerdown', { target: 'DOM object' }, 5), TypeError);
  assert.throws(() => recorder.mark('gap', Infinity, 5), TypeError);
  recorder.stop(6);
  const json = JSON.parse(recorder.serialize());
  assert.deepEqual(json.actions.slice(1, -1).map(action => action.value), ['mixed', 'fixed60', true, 0.008]);
  assert.equal(json.totalActions, 6);
});

test('invalid controller shapes are counted; numerical failures are preserved explicitly', () => {
  const controller = createConstraintDemo();
  const recorder = new ConstraintsInteractionRecorder();
  recorder.start(1);
  assert.equal(recorder.recordFrame(null, 2), false);
  assert.equal(recorder.recordFrame({ ...controller, rawTarget: ['1', 2, 3] }, 3), false);
  controller.result.clearance = NaN;
  controller.result.poleAngle = -0;
  controller.currentElbow[0] = -Infinity;
  assert.equal(recorder.recordFrame(controller, 4), true);
  recorder.stop(5);
  const json = JSON.parse(recorder.serialize());
  assert.equal(json.invalidFrames, 2);
  assert.equal(json.totalFrames, 1);
  assert.equal(cell(json, 0, 'candidateClearanceMeters'), 'NaN');
  assert.equal(cell(json, 0, 'candidatePoleRadians'), '-0');
  assert.equal(cell(json, 0, 'elbowX'), '-Infinity');
});

test('capacity and timestamps are guarded without corrupting an active recording', () => {
  for (const invalid of [0, -1, 2.5, NaN, Infinity, 36001])
    assert.throws(() => new ConstraintsInteractionRecorder({ capacity: invalid }), RangeError);
  assert.throws(() => new ConstraintsInteractionRecorder({ actionCapacity: 8193 }), RangeError);
  const recorder = new ConstraintsInteractionRecorder({ capacity: 3 });
  assert.throws(() => { recorder.capacity = 1000; }, TypeError);
  assert.throws(() => recorder.start(NaN), RangeError);
  recorder.start(20);
  assert.equal(recorder.start(100), false);
  assert.throws(() => recorder.recordFrame(createConstraintDemo(), 19), RangeError);
  assert.throws(() => recorder.stop(Infinity), RangeError);
  assert.equal(recorder.recording, true);
  recorder.stop(21);
  assert.equal(recorder.durationMs, 1);
});
