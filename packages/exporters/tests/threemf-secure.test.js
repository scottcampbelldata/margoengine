// export3MF's secure content structure, by the 3MF Secure Content Extension specification
// (https://github.com/3MFConsortium/spec_securecontent), read back through `parse3MFKeystore`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse3MF, readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { parse3MFKeystore } from '@margoengine/loaders/threemf-secure';
import { export3MF } from '@margoengine/exporters/threemf';
import { encodeZIP } from '../dist/archive.js';

const geometry = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
  indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2],
};
const source = { nodes: [{ name: 'part', geometry }] };
const parts = async (file) => {
  const out = {};
  for (const entry of readZipDirectory(file)) out[entry.name] = await readZipEntry(file, entry);
  return out;
};
const text = (bytes) => new TextDecoder().decode(bytes);
const OAEP = 'http://www.w3.org/2009/xmlenc11#rsa-oaep';
const keyUUID = 'cb9b46cd-c5be-4f58-b2e3-69edb44ff5fe';

test('encrypted parts are listed in a key store, and AES-GCM content decrypts back to the plain part', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
    iv = crypto.getRandomValues(new Uint8Array(12)),
    plain = new Map(),
    file = await export3MF(source, {
      production: { separateParts: true },
      secureContent: {
        consumers: [{ id: 'HP#MOP44B#SG5693454', keyId: 'KEK_xxx', publicKey: '-----BEGIN PUBLIC KEY-----' }],
        groups: [
          {
            keyUUID,
            access: [
              {
                consumer: 0,
                wrappingAlgorithm: OAEP,
                mgfAlgorithm: 'http://www.w3.org/2009/xmlenc11#mgf1sha256',
                digestMethod: 'http://www.w3.org/2001/04/xmlenc#sha256',
                wrappedKey: new Uint8Array([1, 2, 3]),
              },
            ],
          },
        ],
        async encrypt({ path, data }) {
          plain.set(path, data.slice());
          const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
          return { group: 0, data: sealed.slice(0, -16), tag: sealed.slice(-16), iv };
        },
      },
    }),
    all = await parts(file),
    path = [...plain.keys()][0];
  assert.equal(plain.size, 1, 'only the object part may be encrypted here');
  assert.match(path, /^\/3D\/Objects\/object\d+\.model$/);
  // The cipher file: '%3McF', version 0.0, a zero byte, and a 12-byte header (appendix D).
  assert.deepEqual([...all[path.slice(1)].subarray(0, 12)], [37, 51, 77, 99, 70, 0, 0, 0, 12, 0, 0, 0]);
  const model = text(all['3D/3dmodel.model']);
  assert.ok(model.includes('xmlns:sc="http://schemas.microsoft.com/3dmanufacturing/securecontent/2019/04"'));
  assert.match(model, /requiredextensions="p sc"/);
  assert.ok(
    text(all['[Content_Types].xml']).includes(
      '<Override PartName="/Secure/keystore.xml" ContentType="application/vnd.ms-package.3dmanufacturing-keystore+xml"/>',
    ),
  );
  const root = text(all['_rels/.rels']);
  for (const type of ['http://schemas.microsoft.com/3dmanufacturing/2019/04/keystore', '/relationships/mustpreserve'])
    assert.ok(root.includes(type));
  assert.ok(
    text(all['3D/_rels/3dmodel.model.rels']).includes(
      `<Relationship Target="${path}" Id="enc0" Type="http://schemas.openxmlformats.org/package/2006/relationships/encryptedfile"/>`,
    ),
  );

  const store = await parse3MFKeystore(file),
    [group] = store.groups,
    [resource] = group.resources;
  assert.deepEqual(store.consumers, [
    { id: 'HP#MOP44B#SG5693454', keyId: 'KEK_xxx', publicKey: '-----BEGIN PUBLIC KEY-----' },
  ]);
  assert.equal(group.keyUUID, keyUUID);
  assert.deepEqual([...group.access[0].wrappedKey], [1, 2, 3]);
  assert.equal(group.access[0].wrappingAlgorithm, OAEP);
  assert.equal(resource.path, path);
  assert.equal(resource.algorithm, 'http://www.w3.org/2009/xmlenc11#aes256-gcm');
  assert.equal(resource.compression, 'none');
  const opened = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: resource.iv },
    key,
    Buffer.concat([resource.content, resource.tag]),
  );
  assert.deepEqual(new Uint8Array(opened), plain.get(path));
  await assert.rejects(parse3MF(file), { code: 'unsupported', message: /parse3MFKeystore/ });
});

test('a package without a key store gives none, and bad keys are refused by the writer', async () => {
  assert.equal(await parse3MFKeystore(await export3MF(source)), undefined);
  const write = (secureContent) => export3MF(source, { production: { separateParts: true }, secureContent });
  const encrypt = ({ data }) => ({ group: 0, data });
  await assert.rejects(write({ groups: [], encrypt }), { message: /groups/ });
  await assert.rejects(write({ groups: [{ keyUUID: 'ABC' }], encrypt }), { message: /UUID/ });
  await assert.rejects(write({ groups: [{}], encrypt: ({ data }) => ({ group: 1, data }) }), { message: /index/ });
  await assert.rejects(
    write({
      groups: [{ access: [{ consumer: 0, wrappingAlgorithm: OAEP, wrappedKey: new Uint8Array(1) }] }],
      encrypt,
    }),
    { message: /consumer/ },
  );
});

test('broken key stores are refused by the reader', async () => {
  const good = await parts(
    await export3MF(source, {
      production: { separateParts: true },
      secureContent: { groups: [{ keyUUID }], encrypt: ({ data }) => ({ group: 0, data }) },
    }),
  );
  const path = Object.keys(good).find((name) => name.startsWith('3D/Objects/') && !name.endsWith('.rels'));
  const changed = (name, change) =>
    encodeZIP(Object.entries({ ...good, [name]: change(good[name]) }).map(([n, data]) => ({ name: n, data })));
  const edited = (name, from, to) => changed(name, (data) => new TextEncoder().encode(text(data).replace(from, to)));
  const broken = [
    [edited('Secure/keystore.xml', keyUUID, 'not-a-uuid'), /invalid UUID/],
    [edited('Secure/keystore.xml', `path="/${path}"`, 'path="/3D/3dmodel.model"'), /must not be encrypted/],
    [edited('Secure/keystore.xml', /(<resourcedata .*<\/resourcedata>)/, '$1$1'), /listed twice/],
    [edited('3D/_rels/3dmodel.model.rels', '/encryptedfile', '/other'), /no encrypted-file relationship/],
    [changed(path, (data) => data.subarray(1)), /cipher file/],
  ];
  for (const [file, message] of broken) await assert.rejects(parse3MFKeystore(await file), { message });
});
