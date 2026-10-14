// HANDOFF 1f.j: parseUSDInWorker's worker (dist/workers/usdz.js) + modelFromPrepared build the same model as
// parseUSDZ/parseUSDC/parseUSDA + create, compared byte for byte (see tests/support/pbr-snapshot.js).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { crc32 } from "@margoengine/loaders";
import { parseUSDA, parseUSDC, parseUSDZ } from "../dist/index.js";
import { modelFromPrepared } from "../../gltf-pro/dist/worker.js";
import { exportUSDZ } from "../../exporters/dist/index.js";
import { torusKnotGeometry, toGeometry } from "../../geometry/dist/index.js";
import { runParseWorker, assertSameBytes } from "../../../tests/support/parse-worker.js";
import { headless, headlessModels, snapshot } from "../../../tests/support/pbr-snapshot.js";

const worker = new URL("../dist/workers/usdz.js", import.meta.url);
const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url));
// Stored (method 0) ZIP, entries in order.
function zip(files) {
  let offset = 0;
  const locals = [], directory = [];
  for (const [name, data] of files) {
    const filename = Buffer.from(name), header = Buffer.alloc(30), central = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt32LE(crc32(data), 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(header, filename, data); directory.push(central, filename); offset += header.length + filename.length + data.length;
  }
  const cd = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const usda = async () => (await fixture("triangle.usda")).toString("utf8").replace(/\r\n/g, "\n");
async function textured() {
  const shader = (name, file) => `        def Shader "${name}"\n        {\n            uniform token info:id = "UsdUVTexture"\n            asset inputs:file = @${file}@\n        }\n`;
  const text = (await usda())
    .replace("color3f inputs:diffuseColor = (0.2, 0.4, 0.6)", "color3f inputs:diffuseColor.connect = </Root/Material/Diffuse.outputs:rgb>\n            normal3f inputs:normal.connect = </Root/Material/Normal.outputs:rgb>")
    .replace('    def Material "Material"\n    {\n', '    def Material "Material"\n    {\n' + shader("Diffuse", "color.png") + shader("Normal", "normal.png"));
  return zip([["scene.usda", Buffer.from(text)], ["color.png", Buffer.from([137, 80, 78, 71, 1])], ["normal.png", Buffer.from([137, 80, 78, 71, 2])]]);
}
for (const [name, load, parse] of [
  ["USDA text", usda, parseUSDA],
  ["USDC Crate", () => fixture("triangle.usdc"), parseUSDC],
  ["USDZ with textures", textured, parseUSDZ],
  ["USDZ 50k-triangle torus knot (exporters)", () => exportUSDZ({ nodes: [{ geometry: toGeometry(torusKnotGeometry(1, 0.3, 500, 50)) }] }), parseUSDZ],
]) test(`worker-parsed USD equals main-thread parse + create: ${name}`, () => headlessModels(async () => {
  const input = await load(), copy = () => typeof input === "string" ? input : new Uint8Array(input).slice();
  const main = await (await parse(copy())).create(await headless());
  const message = { input: typeof input === "string" ? input : copy().buffer, options: {} };
  assertSameBytes(snapshot(modelFromPrepared(await headless(), await runParseWorker(worker, message))), snapshot(main));
}));

test("USD worker errors keep their message", () => headlessModels(async () => {
  await assert.rejects(runParseWorker(worker, { input: new Uint8Array(zip([["scene.usda", Buffer.from(await usda())]])).buffer, options: { maxBytes: 20 } }), /budget/);
}));
