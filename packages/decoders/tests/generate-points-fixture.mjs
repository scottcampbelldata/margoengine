// Regenerate with draco3d@1.5.7 extracted outside node_modules; no encoder dependency is needed at test time.
// node packages/decoders/tests/generate-points-fixture.mjs test-results/draco-fixture-encoder/package
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url),
  directory = resolve(process.argv[2]);
assert.equal(JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')).version, '1.5.7');
const module = await require(resolve(directory, 'draco_encoder_nodejs.js'))();

// The source arrays of survey.drc, repeated in tests/draco-points.test.js: a scan-like cloud with generic attributes.
const SURVEY = 1000,
  position = (i) => [i % 10, Math.floor(i / 10) % 10, Math.floor(i / 100)],
  intensity = (i) => i / 4,
  classification = (i) => i % 7,
  returns = (i) => 40000 + i,
  depth = (i) => i - 500;

function encode(cloud, encoder) {
  const output = new module.DracoInt8Array();
  encoder.SetSpeedOptions(10, 10);
  const length = encoder.EncodePointCloudToDracoBuffer(cloud, false, output);
  assert.ok(length > 0);
  const bytes = Uint8Array.from({ length }, (_, i) => output.GetValue(i));
  module.destroy(output);
  return bytes;
}

function named(builder, cloud, attribute, name) {
  const metadata = new module.Metadata(),
    writer = new module.MetadataBuilder();
  writer.AddStringEntry(metadata, 'name', name);
  builder.SetMetadataForAttribute(cloud, attribute, metadata);
}

const fill = (Array, width, count, value) => {
  const array = new Array(count * width);
  for (let i = 0; i < count; i++) array.set([value(i)].flat(), i * width);
  return array;
};
const survey = new module.PointCloud(),
  builder = new module.PointCloudBuilder();
builder.AddFloatAttribute(survey, module.POSITION, SURVEY, 3, fill(Float32Array, 3, SURVEY, position));
named(builder, survey, builder.AddFloatAttribute(survey, module.GENERIC, SURVEY, 1, fill(Float32Array, 1, SURVEY, intensity)), 'intensity');
named(builder, survey, builder.AddUInt8Attribute(survey, module.GENERIC, SURVEY, 1, fill(Uint8Array, 1, SURVEY, classification)), 'classification');
builder.AddUInt16Attribute(survey, module.GENERIC, SURVEY, 1, fill(Uint16Array, 1, SURVEY, returns));
builder.AddInt32Attribute(survey, module.GENERIC, SURVEY, 1, fill(Int32Array, 1, SURVEY, depth));
const colours = builder.AddUInt8Attribute(survey, module.COLOR, SURVEY, 3, fill(Uint8Array, 3, SURVEY, (i) => [i & 255, 0, 255]));
builder.SetNormalizedFlagForAttribute(survey, colours, true);
await writeFile(new URL('./fixtures/draco-points/survey.drc', import.meta.url), encode(survey, new module.Encoder()));

// More points than 16-bit indices reach, on a line, so the file stays small.
const WIDE = 70000,
  wide = new module.PointCloud();
builder.AddUInt32Attribute(wide, module.POSITION, WIDE, 1, fill(Uint32Array, 1, WIDE, (i) => i));
await writeFile(new URL('./fixtures/draco-points/wide.drc', import.meta.url), encode(wide, new module.Encoder()));
