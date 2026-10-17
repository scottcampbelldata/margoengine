// Dispersion export follows the live physical material, while optional unloaded glTF metadata remains lossless.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Material, createMesh } from '@margoengine/materials';
import { parseGLTF } from '@margoengine/gltf-pro';
import { extendedMaterials } from '@margoengine/gltf-pro/extended';
import { exportModel } from '../dist/model.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';
import { readGLB, validate, validator } from './helpers.js';

const triangle = {
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2],
};
const extension = (json) => json.materials[0].extensions?.KHR_materials_dispersion;

test('exportModel writes a live physical owner dispersion added without constructor metadata', () =>
  headlessModels(async () => {
    const native = createMesh(await headless(), triangle, new Material({ transmission: 1 })),
      // A prepared owner isolates writer support from the public Material constructor support.
      owner = { transmissive: true, dispersion: 2.5 },
      source = { ...native, material: owner };
    assert.equal(native.primitives[0].material.extensions.KHR_materials_dispersion, undefined);
    const bytes = await exportModel(source, { binary: true }),
      { json } = readGLB(bytes);
    assert.deepEqual(extension(json), { dispersion: 2.5 });
    assert.ok(json.extensionsUsed.includes('KHR_materials_dispersion'));
    owner.dispersion = 0.25;
    assert.deepEqual(extension((await exportModel(source)).json), { dispersion: 0.25 });
    owner.dispersion = 0;
    const reset = (await exportModel(source)).json;
    assert.equal(extension(reset), undefined, 'un-authored default zero needs no extension');
    assert.ok(!reset.extensionsUsed?.includes('KHR_materials_dispersion'));
  }));

test('exportModel preserves explicit zero dispersion metadata and reads subsequent owner changes', () =>
  headlessModels(async () => {
    const native = createMesh(await headless(), triangle, new Material({ transmission: 1 })),
      owner = { transmissive: true, dispersion: 0 },
      source = { ...native, material: owner };
    native.primitives[0].material.extensions.KHR_materials_dispersion = {};
    assert.deepEqual(extension((await exportModel(source)).json), { dispersion: 0 });
    owner.dispersion = 1.75;
    assert.deepEqual(extension((await exportModel(source)).json), { dispersion: 1.75 });
    owner.dispersion = 0;
    assert.deepEqual(extension((await exportModel(source)).json), { dispersion: 0 });
  }));

test('exportModel reads live native dispersion without an owner', () =>
  headlessModels(async () => {
    const native = createMesh(await headless(), triangle, new Material({ transmission: 1 })),
      fixture = await exportModel(native, { embed: false });
    fixture.json.materials[0].extensions.KHR_materials_dispersion = { dispersion: 0.125 };
    const source = parseGLTF(await headless(), fixture.json, [fixture.bin.buffer], [], {
        materials: extendedMaterials,
      }),
      material = source.primitives[0].material;
    material.dispersion = 2.25;
    assert.deepEqual(extension((await exportModel(source)).json), { dispersion: 2.25 });
    material.dispersion = 0;
    assert.deepEqual(extension((await exportModel(source)).json), { dispersion: 0 });
  }));

test('exportModel keeps unloaded optional dispersion metadata instead of replacing it with zero', () =>
  headlessModels(async () => {
    const source = createMesh(await headless(), triangle, new Material()),
      fixture = await exportModel(source, { embed: false });
    fixture.json.materials[0].extensions = {
      KHR_materials_transmission: { transmissionFactor: 1 },
      KHR_materials_volume: { thicknessFactor: 0.5 },
      KHR_materials_dispersion: { dispersion: 2.75 },
    };
    fixture.json.extensionsUsed = ['KHR_materials_transmission', 'KHR_materials_volume', 'KHR_materials_dispersion'];
    const loaded = parseGLTF(await headless(), fixture.json, [fixture.bin.buffer]);
    assert.equal(loaded.primitives[0].material.physical, undefined, 'optional material decoder is absent');
    assert.deepEqual(extension((await exportModel(loaded)).json), { dispersion: 2.75 });
    fixture.json.materials[0].extensions.KHR_materials_dispersion = {};
    const zero = parseGLTF(await headless(), fixture.json, [fixture.bin.buffer]);
    assert.deepEqual(extension((await exportModel(zero)).json), { dispersion: 0 });
  }));

test('exportModel leaves ordinary nonphysical materials on the existing export path', () =>
  headlessModels(async () => {
    const native = createMesh(await headless(), triangle, new Material()),
      source = { ...native, material: { dispersion: 2 } },
      { json } = await exportModel(source);
    assert.equal(extension(json), undefined);
    assert.ok(!json.extensionsUsed?.includes('KHR_materials_dispersion'));
  }));

test('exportModel roundtrips explicit zero and live dispersion from a real Material constructor', () =>
  headlessModels(async () => {
    const material = new Material({ transmission: 1, thickness: 0.5, dispersion: 0 }),
      source = createMesh(await headless(), triangle, material);
    assert.deepEqual(extension((await exportModel(source)).json), { dispersion: 0 });
    material.dispersion = 2.5;
    const bytes = await exportModel(source, { binary: true }),
      { json, bin } = readGLB(bytes),
      loaded = parseGLTF(
        await headless(),
        json,
        [bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength)],
        [],
        {
          materials: extendedMaterials,
        },
      );
    assert.deepEqual(extension(json), { dispersion: 2.5 });
    assert.equal(loaded.primitives[0].material.dispersion, 2.5);
    loaded.primitives[0].material.dispersion = 0;
    assert.deepEqual(extension((await exportModel(loaded)).json), { dispersion: 0 });
    if (validator) {
      const report = await validate(bytes);
      assert.equal(report.errors, 0, JSON.stringify(report.messages));
    }
  }));

test('exportModel includes a real live setter on another physical constructor without dispersion metadata', () =>
  headlessModels(async () => {
    const material = new Material({ transmission: 1, thickness: 0.5 }),
      source = createMesh(await headless(), triangle, material);
    assert.equal(extension((await exportModel(source)).json), undefined);
    material.dispersion = 1.5;
    assert.deepEqual(extension((await exportModel(source)).json), { dispersion: 1.5 });
    material.dispersion = 0;
    assert.equal(extension((await exportModel(source)).json), undefined);
  }));
