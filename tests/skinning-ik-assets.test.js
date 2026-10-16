import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { validateBytes } from "gltf-validator";
import { GLTFAsset } from "../packages/gltf-pro/dist/index.js";

const assets = new URL("../examples/assets/", import.meta.url);
function readGLB(name) {
  const bytes = readFileSync(new URL(name, assets));
  assert.equal(bytes.toString("ascii", 0, 4), "glTF");
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const jsonLength = bytes.readUInt32LE(12),
    binaryOffset = 20 + jsonLength,
    doc = JSON.parse(bytes.toString("utf8", 20, binaryOffset));
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  assert.equal(bytes.readUInt32LE(binaryOffset + 4), 0x004e4942);
  return {
    bytes,
    doc,
    asset: new GLTFAsset(doc, [bytes.subarray(binaryOffset + 8)]),
  };
}
const main = readGLB("skinning-ik.glb"),
  orb = readGLB("skinning-ik-orb.glb"),
  doc = main.doc;

for (const [name, model] of [
  ["workshop", main],
  ["orb", orb],
])
  test(`Light Keeper ${name} passes Khronos validation without errors or warnings`, async () => {
    const report = await validateBytes(new Uint8Array(model.bytes), {
      uri: `${name}.glb`,
      maxIssues: 1000,
    });
    const problems = report.issues.messages.filter(
      (issue) => issue.severity < 2,
    );
    assert.equal(report.issues.numErrors, 0, JSON.stringify(problems));
    assert.equal(report.issues.numWarnings, 0, JSON.stringify(problems));
    assert.match(model.doc.asset.copyright, /Scott Campbell.*MIT License/);
    assert.ok(
      !(model.doc.extensionsUsed ?? []).includes("KHR_draco_mesh_compression"),
    );
  });

test("the exported arm is a direct skinned chain with unit-scale joints and ancestors", () => {
  const indices = ["UpperArm", "Forearm", "Hand"].map((name) => {
    const matches = doc.nodes.flatMap((node, index) =>
      node.name === name ? [index] : [],
    );
    assert.equal(matches.length, 1, `expected one ${name} joint`);
    return matches[0];
  });
  assert.ok(doc.nodes[indices[0]].children.includes(indices[1]));
  assert.ok(doc.nodes[indices[1]].children.includes(indices[2]));
  assert.equal(doc.skins.length, 1);
  const joints = doc.skins[0].joints;
  for (const index of indices) assert.ok(joints.includes(index));
  assert.equal(
    doc.accessors[doc.skins[0].inverseBindMatrices].count,
    joints.length,
  );
  const parents = new Map(
    doc.nodes.flatMap((node, parent) =>
      (node.children ?? []).map((child) => [child, parent]),
    ),
  );
  for (const joint of joints)
    for (let index = joint; index !== undefined; index = parents.get(index)) {
      const node = doc.nodes[index];
      assert.ok(
        !node.matrix,
        `${node.name} must retain local TRS for animation`,
      );
      assert.ok(
        (node.scale ?? [1, 1, 1]).every((value) => Math.abs(value - 1) < 1e-6),
        node.name,
      );
    }
  assert.ok(
    doc.animations?.some((clip) => clip.channels.length > 0),
    "the exported rig needs an idle clip",
  );
});

test("the actual skin has blended vertices within the animation package four-influence limit", () => {
  let skinned = 0,
    blended = 0;
  for (const mesh of doc.meshes)
    for (const primitive of mesh.primitives) {
      const attributes = primitive.attributes;
      assert.ok(
        attributes.JOINTS_1 === undefined && attributes.WEIGHTS_1 === undefined,
      );
      if (attributes.JOINTS_0 === undefined) continue;
      const weights = main.asset.accessor(attributes.WEIGHTS_0, "VEC4"),
        joints = main.asset.accessor(attributes.JOINTS_0, "VEC4");
      assert.equal(weights.length, joints.length);
      assert.equal(
        weights.length / 4,
        doc.accessors[attributes.POSITION].count,
      );
      for (let vertex = 0; vertex < weights.length; vertex += 4) {
        const active = new Set();
        let sum = 0;
        for (let slot = 0; slot < 4; slot++) {
          const weight = weights[vertex + slot],
            joint = joints[vertex + slot];
          assert.ok(Number.isFinite(weight) && weight >= 0);
          assert.ok(
            Number.isInteger(joint) &&
              joint >= 0 &&
              joint < doc.skins[0].joints.length,
          );
          sum += weight;
          if (weight > 1e-5) active.add(joint);
        }
        assert.ok(Math.abs(sum - 1) < 1e-4);
        skinned++;
        if (active.size > 1) blended++;
      }
    }
  assert.ok(skinned > 0, "a rigid prop is not a skinning demonstration");
  assert.ok(blended > 0, "skin must contain genuine multi-joint deformation");
});

test("used PBR color, roughness and normal maps are embedded with valid UVs and tangents", () => {
  assert.ok(doc.images.length > 0);
  for (const image of doc.images) {
    assert.ok(Number.isInteger(image.bufferView), image.name);
    assert.equal(image.uri, undefined, image.name);
    assert.ok(doc.bufferViews[image.bufferView].byteLength > 100, image.name);
  }
  for (const id of ["wood_table_worn", "concrete_floor_worn_001"]) {
    const materials = doc.materials.filter(
      (material) =>
        material.extras?.texture_source === `https://polyhaven.com/a/${id}`,
    );
    assert.ok(
      materials.length > 0,
      `${id} must remain credited on its exported materials`,
    );
    for (const material of materials) {
      assert.equal(material.extras.texture_license, "CC0");
      assert.ok(
        material.normalTexture &&
          material.pbrMetallicRoughness.baseColorTexture &&
          material.pbrMetallicRoughness.metallicRoughnessTexture,
        `${id} needs all three PBR maps`,
      );
    }
  }
  let fullyTextured = 0;
  for (const mesh of doc.meshes)
    for (const primitive of mesh.primitives) {
      const material = doc.materials[primitive.material],
        pbr = material.pbrMetallicRoughness ?? {},
        maps = [
          pbr.baseColorTexture,
          pbr.metallicRoughnessTexture,
          material.normalTexture,
        ];
      if (maps.every(Boolean)) fullyTextured++;
      for (const map of maps.filter(Boolean)) {
        const texture = doc.textures[map.index];
        assert.ok(doc.images[texture.source]);
        const uv =
          doc.accessors[primitive.attributes[`TEXCOORD_${map.texCoord ?? 0}`]];
        assert.equal(uv?.type, "VEC2", `${material.name} needs matching UVs`);
        assert.equal(
          uv.count,
          doc.accessors[primitive.attributes.POSITION].count,
        );
      }
      if (material.normalTexture)
        assert.ok(primitive.attributes.TANGENT !== undefined, material.name);
    }
  assert.ok(fullyTextured > 0);
  const mirror = orb.doc.materials[0].pbrMetallicRoughness;
  assert.ok(
    (mirror.metallicFactor ?? 1) > 0.95 && mirror.roughnessFactor < 0.06,
    "the orb must retain its mirror finish",
  );
});

test("editable source, approved reference, and licensed upstream files remain reproducible", () => {
  for (const path of [
    "source/skinning-ik.blend",
    "source/skinning_ik/build_robot.py",
    "source/skinning_ik/workshop.py",
    "source/skinning_ik/surface_textures.py",
    "source/skinning_ik/visual-target.png",
  ])
    assert.ok(statSync(new URL(path, assets)).size > 100, path);
  const source = new URL("source/skinning_ik/textures/polyhaven/", assets),
    manifest = JSON.parse(readFileSync(new URL("manifest.json", source))),
    environment = JSON.parse(readFileSync(new URL("environment.json", source)));
  assert.equal(manifest.license, "CC0-1.0");
  for (const asset of manifest.assets)
    for (const map of asset.maps) {
      const hash = createHash("sha256")
        .update(readFileSync(new URL(map.file, source)))
        .digest("hex");
      assert.equal(hash, map.sha256, map.file);
    }
  assert.equal(environment.license, "CC0-1.0");
  assert.equal(environment.asset_id, "artist_workshop");
  const hdr = readFileSync(new URL("skinning-ik-workshop.hdr", assets));
  assert.equal(
    createHash("sha256").update(hdr).digest("hex"),
    environment.sha256,
  );
});

test("the exact case-back dedication is baked onto the existing rear polygons", () => {
  const text = "Margo Engine ♡\nMade for Margie",
    materialIndex = doc.materials.findIndex(
      (material) =>
        material.name === "Workshop / instrument case baked dedication",
    );
  assert.ok(materialIndex >= 0);
  const material = doc.materials[materialIndex];
  assert.equal(material.extras.dedication, text);
  assert.equal(material.pbrMetallicRoughness.metallicFactor, 0);
  const uses = doc.nodes.flatMap((node) =>
    node.mesh === undefined
      ? []
      : doc.meshes[node.mesh].primitives
          .filter((primitive) => primitive.material === materialIndex)
          .map((primitive) => ({ node, primitive })),
  );
  assert.equal(uses.length, 1);
  assert.equal(uses[0].node.name, "Workshop / fitted tool cases");
  assert.equal(
    doc.accessors[uses[0].primitive.indices].count,
    6,
    "the mark uses the existing two rear triangles",
  );
  const image =
    doc.images[
      doc.textures[material.pbrMetallicRoughness.baseColorTexture.index].source
    ];
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.name, "lk_instrument_case_back_dedication");
  const provenance = JSON.parse(
      readFileSync(
        new URL("source/skinning_ik/dedication/provenance.json", assets),
      ),
    ),
    pixels = readFileSync(
      new URL(
        "source/skinning_ik/dedication/lk_instrument_case_back_dedication.png",
        assets,
      ),
    );
  assert.equal(provenance.text, text);
  assert.deepEqual(provenance.imageSize, [1024, 512]);
  assert.equal(
    createHash("sha256").update(pixels).digest("hex"),
    provenance.imageSha256,
  );
});
