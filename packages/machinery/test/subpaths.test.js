// The section, spatial and react subpaths an app imports on their own are the same modules the root entry re-exports
// (runtime.test.js and section-toggle.test.js test their behaviour through the root), so an app that mixes the two
// import styles never holds two copies of a class.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as root from '@margoengine/machinery';
import { SectionPlanes, boxSection } from '@margoengine/machinery/section';
import { AssemblyBVH } from '@margoengine/machinery/spatial';

test('section and spatial subpaths export the root entry classes themselves', () => {
  assert.equal(SectionPlanes, root.SectionPlanes);
  assert.equal(boxSection, root.boxSection);
  assert.equal(AssemblyBVH, root.AssemblyBVH);
  // A box section is its six inward planes.
  assert.equal(boxSection([-1, -1, -1], [1, 1, 1]).length, 6);
});

test('the react subpath exports a SectionPlanes component built on the section plugin', async () => {
  const react = await import('@margoengine/machinery/react');
  assert.equal(typeof react.SectionPlanes, 'object'); // a forwardRef component
  assert.equal(typeof react.SectionPlanes.render, 'function');
  assert.notEqual(react.SectionPlanes, SectionPlanes);
});
