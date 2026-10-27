// A missing third argument must decode ordinary images like the options overload. The positional buffers/images
// overload still accepts caller-decoded images, including an undefined buffers argument with later positional args.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGLTFAsync } from '../dist/index.js';
import { KTX2Decoder } from '../../decoders/dist/index.js';
import { materialQuad } from '../../../tests/support/materials-fixture.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';

const png = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==',
    'base64',
  ),
);
const dataURI = (bytes, type) => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;

function fixture() {
  const value = materialQuad();
  value.doc.buffers.forEach((def, index) => {
    const buffer = value.buffers[index];
    def.uri = dataURI(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), 'application/octet-stream');
  });
  value.doc.images = [{ uri: dataURI(png, 'image/png') }];
  value.doc.textures = [{ source: 0 }];
  value.doc.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
  return value;
}

/** Pack the ordinary image into a GLB bufferView, so both embedded source representations are exercised. */
function glb({ doc, buffers }) {
  doc = structuredClone(doc);
  const imageBuffer = buffers.length;
  buffers = [...buffers, png];
  doc.images = [{ bufferView: doc.bufferViews.length, mimeType: 'image/png' }];
  doc.bufferViews.push({ buffer: imageBuffer, byteLength: png.length });
  const offsets = [];
  let length = 0;
  for (const buffer of buffers) {
    offsets.push(length);
    length += (buffer.byteLength + 3) & ~3;
  }
  for (const view of doc.bufferViews) {
    view.byteOffset = (view.byteOffset ?? 0) + offsets[view.buffer];
    view.buffer = 0;
  }
  doc.buffers = [{ byteLength: length }];
  const text = JSON.stringify(doc),
    json = new TextEncoder().encode(text.padEnd((text.length + 3) & ~3)),
    out = new Uint8Array(28 + json.length + length),
    view = new DataView(out.buffer);
  for (const [offset, value] of [
    [0, 0x46546c67],
    [4, 2],
    [8, out.length],
    [12, json.length],
    [16, 0x4e4f534a],
    [20 + json.length, length],
    [24 + json.length, 0x004e4942],
  ])
    view.setUint32(offset, value, true);
  out.set(json, 20);
  buffers.forEach((buffer, index) => {
    out.set(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), 28 + json.length + offsets[index]);
  });
  return out;
}

/** Node has no browser image decoder; only that browser boundary and GPU setup are substituted. */
async function decodedImages(run, decode) {
  return headlessModels(async () => {
    const images = [];
    globalThis.createImageBitmap = async (source, options) => {
      if (decode) return decode(source, options, images);
      const image = {
        width: 128,
        height: 128,
        bytes: new Uint8Array(await source.arrayBuffer()),
        options,
        closed: 0,
        close() {
          this.closed++;
        },
      };
      images.push(image);
      return image;
    };
    return run(images);
  });
}

for (const [form, input] of [
  ['document/data URI', () => fixture().doc],
  ['JSON/data URI', () => JSON.stringify(fixture().doc)],
  ['GLB ArrayBuffer/bufferView', () => glb(fixture()).buffer],
  [
    'GLB offset view/bufferView',
    () => {
      const bytes = glb(fixture()),
        backing = new Uint8Array(bytes.length + 16).fill(0xff);
      backing.set(bytes, 8);
      return new DataView(backing.buffer, 8, bytes.length);
    },
  ],
])
  for (const [call, args] of [
    ['omitted', []],
    ['undefined', [undefined]],
    ['explicit', [{}]],
  ])
    test(`async ${call} options decode PNG from ${form} and release it with the model`, () =>
      decodedImages(async (images) => {
        const engine = await headless();
        let model;
        try {
          model = await parseGLTFAsync(engine, input(), ...args);
          const image = model.image(0);
          assert.deepEqual(image.bytes, png);
          assert.deepEqual([image.width, image.height], [128, 128]);
          assert.deepEqual(image.options, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
          assert.equal(model.primitives[0].material.maps[0].index, 0);
          assert.equal(images.length, 1);
          assert.equal(image.closed, 0);
        } finally {
          model?.dispose();
          engine.dispose();
        }
        assert.deepEqual(
          images.map((image) => image.closed),
          [1],
        );
      }));

test('positional arrays and undefined buffers retain supplied bitmaps and fifth-argument options', () =>
  decodedImages(async (decoded) => {
    for (const form of ['buffers', 'undefined with images', 'undefined with images and options']) {
      const { doc, buffers } = fixture(),
        engine = await headless(),
        image = {
          width: 128,
          height: 128,
          closed: 0,
          close() {
            this.closed++;
          },
        };
      let model;
      try {
        // This URI cannot be decoded: the supplied bitmap must be used instead.
        doc.images[0].uri = 'data:image/png;base64,AAAA';
        model =
          form === 'undefined with images'
            ? await parseGLTFAsync(engine, doc, undefined, [image])
            : await parseGLTFAsync(engine, doc, form === 'buffers' ? buffers : undefined, [image], { maxNodes: 1 });
        assert.equal(model.image(0), image);
        assert.equal(decoded.length, 0);
      } finally {
        model?.dispose();
        engine.dispose();
      }
      assert.equal(image.closed, 1);
    }
    const controller = new AbortController();
    controller.abort();
    const engine = await headless();
    try {
      await assert.rejects(parseGLTFAsync(engine, fixture().doc, undefined, [], { signal: controller.signal }), {
        name: 'AbortError',
      });
      await assert.rejects(parseGLTFAsync(engine, fixture().doc, undefined, [], { maxNodes: 0 }), /maxNodes/);
    } finally {
      engine.dispose();
    }
  }));

test('explicit positional empty arrays do not decode ordinary images implicitly', () =>
  decodedImages(async (images) => {
    const { doc, buffers } = fixture(),
      engine = await headless();
    let model;
    try {
      model = await parseGLTFAsync(engine, doc, buffers);
      assert.throws(() => model.image(0), /Missing decoded glTF image/);
      assert.equal(images.length, 0);
    } finally {
      model?.dispose();
      engine.dispose();
    }
  }));

test('default parsing rejects a later invalid image and closes already decoded images before allocating scene nodes', () =>
  decodedImages(
    async (images) => {
      const { doc } = fixture(),
        engine = await headless(),
        count = engine.meshes.size;
      doc.images.push({ uri: dataURI(Uint8Array.of(0), 'image/png') });
      try {
        await assert.rejects(parseGLTFAsync(engine, doc), {
          name: 'TypeError',
          message: /glTF image 1.*check the file/,
        });
        assert.deepEqual(
          images.map((image) => image.closed),
          [1],
        );
        assert.equal(engine.meshes.size, count);
      } finally {
        engine.dispose();
      }
    },
    async (source, _options, images) => {
      const bytes = new Uint8Array(await source.arrayBuffer());
      if (bytes.length === 1) throw new DOMException('Invalid PNG', 'InvalidStateError');
      const image = {
        width: 128,
        height: 128,
        closed: 0,
        close() {
          this.closed++;
        },
      };
      images.push(image);
      return image;
    },
  ));

test('options abort during image decoding closes the bitmap and creates no model', () =>
  decodedImages(async (images) => {
    const controller = new AbortController(),
      engine = await headless(),
      count = engine.meshes.size,
      decode = globalThis.createImageBitmap;
    globalThis.createImageBitmap = async (...args) => {
      const image = await decode(...args);
      controller.abort();
      return image;
    };
    try {
      await assert.rejects(parseGLTFAsync(engine, fixture().doc, { signal: controller.signal }), {
        name: 'AbortError',
      });
      assert.deepEqual(
        images.map((image) => image.closed),
        [1],
      );
      assert.equal(engine.meshes.size, count);
    } finally {
      engine.dispose();
    }
  }));

test('decoded image budget rejection closes the image before attaching it', () =>
  decodedImages(async (images) => {
    const engine = await headless(),
      count = engine.meshes.size;
    try {
      // The 128x128 RGBA bitmap exceeds 4x this otherwise sufficient source budget.
      await assert.rejects(parseGLTFAsync(engine, fixture().doc, { maxDownloadBytes: 4096 }), /decoded size limit/);
      assert.deepEqual(
        images.map((image) => image.closed),
        [1],
      );
      assert.equal(engine.meshes.size, count);
    } finally {
      engine.dispose();
    }
  }));

test('default parser releases a decoded bitmap when the geometry fails to attach', () =>
  decodedImages(async (images) => {
    const { doc } = fixture(),
      engine = await headless(),
      count = engine.meshes.size;
    doc.meshes[0].primitives[0].mode = 7;
    try {
      await assert.rejects(parseGLTFAsync(engine, doc), /Invalid glTF primitive mode/);
      assert.deepEqual(
        images.map((image) => image.closed),
        [1],
      );
      assert.equal(engine.meshes.size, count);
    } finally {
      engine.dispose();
    }
  }));

function basisImage() {
  const bytes = new Uint8Array(80),
    view = new DataView(bytes.buffer);
  bytes.set([171, 75, 84, 88, 32, 50, 48, 187, 13, 10, 26, 10]);
  for (const [offset, value] of [
    [20, 4],
    [24, 4],
    [36, 1],
    [40, 1],
  ])
    view.setUint32(offset, value, true);
  return bytes;
}
const transcoded = () => ({
  width: 4,
  height: 4,
  target: 'rgba8',
  format: 'rgba8unorm',
  srgb: false,
  hasAlpha: false,
  mipmaps: [{ data: new Uint8Array(64), width: 4, height: 4, byteLength: 64 }],
});

test('default parser decodes mixed PNG/Basis images and releases its automatic transcoder on success and failure', () =>
  decodedImages(async (images) => {
    const transcode = KTX2Decoder.prototype.transcode,
      dispose = KTX2Decoder.prototype.dispose;
    let released = 0;
    KTX2Decoder.prototype.dispose = function () {
      released++;
      dispose.call(this);
    };
    try {
      for (const fail of [false, true]) {
        const { doc } = fixture(),
          engine = await headless();
        doc.images.push({ uri: dataURI(basisImage(), 'image/ktx2'), mimeType: 'image/ktx2' });
        doc.textures.push({ extensions: { KHR_texture_basisu: { source: 1 } } });
        doc.materials[0].normalTexture = { index: 1 };
        KTX2Decoder.prototype.transcode = async () => {
          if (fail) throw new Error('Basis decoder failed');
          return transcoded();
        };
        let model;
        try {
          if (fail) await assert.rejects(parseGLTFAsync(engine, doc), /Basis decoder failed/);
          else {
            model = await parseGLTFAsync(engine, doc);
            assert.deepEqual(model.image(0).bytes, png);
            assert.deepEqual([model.image(1).width, model.image(1).height], [4, 4]);
          }
        } finally {
          model?.dispose();
          engine.dispose();
        }
      }
      assert.equal(released, 2);
      assert.deepEqual(
        images.map((image) => image.closed),
        [1, 1],
      );
    } finally {
      KTX2Decoder.prototype.transcode = transcode;
      KTX2Decoder.prototype.dispose = dispose;
    }
  }));

test('options parser never disposes a caller-owned Basis transcoder', () =>
  decodedImages(async (images) => {
    const { doc } = fixture(),
      engine = await headless(),
      decoder = {
        transcode: async () => transcoded(),
        dispose() {
          throw new Error('Caller still owns decoder');
        },
      };
    doc.images.push({ uri: dataURI(basisImage(), 'image/ktx2'), mimeType: 'image/ktx2' });
    doc.textures.push({ extensions: { KHR_texture_basisu: { source: 1 } } });
    let model;
    try {
      model = await parseGLTFAsync(engine, doc, { ktx2: decoder });
      assert.equal(model.image(1).width, 4);
    } finally {
      model?.dispose();
      engine.dispose();
    }
    assert.deepEqual(
      images.map((image) => image.closed),
      [1],
    );
  }));

test('ordinary images decode up to eight at once, in image order, and a failure closes every bitmap', () =>
  decodedImages(
    async (images) => {
      // FlightHelmet's textures decoded one after another (each awaited before the next began), so p-gltf-parse paid
      // the sum of the decodes; createImageBitmap runs off the main thread, so they now overlap.
      for (const failAt of [-1, 5]) {
        const { doc } = fixture(),
          engine = await headless();
        images.length = 0;
        doc.images = Array.from({ length: 12 }, (_, k) => ({
          uri: dataURI(k === failAt ? Uint8Array.of(0) : Uint8Array.of(...png, k), 'image/png'),
        }));
        let model;
        try {
          if (failAt >= 0) await assert.rejects(parseGLTFAsync(engine, doc), /glTF image 5.*check the file/);
          else {
            model = await parseGLTFAsync(engine, doc);
            for (let k = 0; k < 12; k++) assert.equal(model.image(k).bytes.at(-1), k);
          }
        } finally {
          model?.dispose();
          engine.dispose();
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(decodedImages.peak, 8);
        assert.ok(images.length >= (failAt >= 0 ? 5 : 12));
        assert.ok(images.every((image) => image.closed === 1));
        decodedImages.peak = 0;
      }
    },
    async (source, _options, images) => {
      decodedImages.flight = (decodedImages.flight ?? 0) + 1;
      decodedImages.peak = Math.max(decodedImages.peak ?? 0, decodedImages.flight);
      const bytes = new Uint8Array(await source.arrayBuffer());
      await new Promise((resolve) => setTimeout(resolve, 2));
      decodedImages.flight--;
      if (bytes.length === 1) throw new DOMException('Invalid PNG', 'InvalidStateError');
      const image = {
        width: 128,
        height: 128,
        bytes,
        closed: 0,
        close() {
          this.closed++;
        },
      };
      images.push(image);
      return image;
    },
  ));
