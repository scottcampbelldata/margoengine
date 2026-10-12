import test from 'node:test';
import assert from 'node:assert/strict';
import {exportUSDZ} from '../dist/index.js';
import {exportUSDZ as Original} from '@margoengine/exporters';
test('standalone USDZ serializer preserves the tested exporter and input validation', () => {assert.equal(exportUSDZ, Original); assert.throws(() => exportUSDZ({nodes: []}), /mesh|scene|nodes/i);});
