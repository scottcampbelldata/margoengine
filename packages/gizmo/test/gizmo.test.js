import test from 'node:test';
import assert from 'node:assert/strict';
import {Gizmo, TransformControls, buildGizmo} from '../dist/index.js';
import {TransformControls as Original} from '@margoengine/controls';
test('standalone gizmo preserves the tested controls implementation and exports', () => {assert.equal(Gizmo, Original); assert.equal(TransformControls, Original); assert.equal(typeof buildGizmo, 'function');});
