// The unencrypted structure of the 3MF Consortium's Secure Content Extension
// (https://github.com/3MFConsortium/spec_securecontent), which `export3MF` loads for its `secureContent` option: the
// key store, the cipher file header and the relationships. It encrypts nothing and handles no key; the caller does.

/** One reader of the encrypted parts. */
export interface ThreeMFConsumer {
  /** The consumer's identifier, unique in the file. */
  id: string;
  /** Which of its keys wraps the content keys. */
  keyId?: string;
  /** That public key in PEM form (RFC 7468). */
  publicKey?: string;
}

/** A group's content key, already wrapped for one consumer. */
export interface ThreeMFAccessRight {
  /** The consumer's index in `consumers`. */
  consumer: number;
  /** The wrapping algorithm's URI, such as `'http://www.w3.org/2009/xmlenc11#rsa-oaep'`. */
  wrappingAlgorithm: string;
  mgfAlgorithm?: string;
  digestMethod?: string;
  /** The wrapped content key's bytes. */
  wrappedKey: Uint8Array;
}

/** The parts that share one content key. */
export interface ThreeMFKeyGroup {
  /** The key's UUID. Default a random one. */
  keyUUID?: string;
  /** Default none: the key travels by other means. */
  access?: readonly ThreeMFAccessRight[];
}

/** What the caller made of one part. */
export interface ThreeMFEncryptedPart {
  /** The index in `groups` of the key it is encrypted with. */
  group: number;
  /** The encrypted bytes alone; the writer adds the cipher file header. */
  data: Uint8Array;
  /** The content encryption algorithm's URI. Default AES-256-GCM's. */
  algorithm?: string;
  /** `'deflate'` says the bytes were raw-deflated before they were encrypted. Default `'none'`. */
  compression?: 'none' | 'deflate';
  iv?: Uint8Array;
  tag?: Uint8Array;
  /** Additional authenticated data. */
  aad?: Uint8Array;
}

/** `export3MF`'s `secureContent` option. */
export interface ThreeMFSecureContent {
  /** The key store's UUID, new each time its content changes. Default a random one. */
  uuid?: string;
  consumers?: readonly ThreeMFConsumer[];
  groups: readonly ThreeMFKeyGroup[];
  /**
   * Called once for each part that may be encrypted, which is every one but the root model, the relationships and the
   * content types: model parts of their own, slice parts, textures and the thumbnail, with the plain bytes. Return the
   * encrypted part, or nothing to leave it plain.
   */
  encrypt: (part: {
    path: string;
    data: Uint8Array;
  }) => ThreeMFEncryptedPart | undefined | Promise<ThreeMFEncryptedPart | undefined>;
}

const SECURE = 'http://schemas.microsoft.com/3dmanufacturing/securecontent/2019/04',
  KEYSTORE = 'http://schemas.microsoft.com/3dmanufacturing/2019/04/keystore',
  PACKAGE = 'http://schemas.openxmlformats.org/package/2006/relationships/',
  AES = 'http://www.w3.org/2009/xmlenc11#aes256-gcm',
  UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

const fail = (message: string): never => {
  throw new RangeError(`3MF secure content ${message}`);
};
const base64 = (bytes: Uint8Array, what: string): string => {
  if (!(bytes instanceof Uint8Array)) throw new TypeError(`3MF secure content ${what} must be bytes`);
  let text = '';
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
};
/** Version 0 of the cipher file: the magic number, version 0.0, a zero, the header's length of 12, then the content. */
function cipherFile(content: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + content.length);
  out.set([0x25, 0x33, 0x4d, 0x63, 0x46, 0, 0, 0, 12, 0, 0, 0]);
  out.set(content, 12);
  return out;
}

/**
 * Encrypts what the caller asks of a package's parts, in place: each chosen part is replaced by its cipher file, every
 * relationship to it is joined by an encrypted-file one, and the key store is added.
 */
export async function secureParts(
  parts: { name: string; data: Uint8Array }[],
  { uuid, consumers = [], groups, encrypt }: ThreeMFSecureContent,
  tools: { escaped(text: string): string; uuid(): string; signal?: AbortSignal },
): Promise<void> {
  const { escaped, signal } = tools;
  if (typeof encrypt !== 'function' || !Array.isArray(groups) || !groups.length)
    throw new TypeError('3MF secure content needs groups and an encrypt function');
  const identified = (value: string | undefined): string => {
      const given = value ?? tools.uuid();
      return UUID.test(given) ? given : fail('UUIDs are lower-case, in the 8-4-4-4-12 form');
    },
    attribute = (name: string, value: string | undefined): string =>
      value === undefined ? '' : ` ${name}="${escaped(value)}"`,
    ids = new Set<string>(),
    listed = consumers.map(({ id, keyId, publicKey }) => {
      if (typeof id !== 'string' || !id || ids.has(id)) fail('consumers need identifiers, none used twice');
      ids.add(id);
      const key = publicKey === undefined ? '' : `<keyvalue>${escaped(publicKey)}</keyvalue>`;
      return `<consumer consumerid="${escaped(id)}"${attribute('keyid', keyId)}>${key}</consumer>`;
    }),
    keys = (groups as readonly ThreeMFKeyGroup[]).map(({ keyUUID, access = [] }) => {
      const rights = access.map(({ consumer, wrappingAlgorithm, mgfAlgorithm, digestMethod, wrappedKey }) => {
        if (!Number.isInteger(consumer) || consumer < 0 || consumer >= consumers.length)
          fail('access rights name a consumer by its index');
        if (typeof wrappingAlgorithm !== 'string' || !wrappingAlgorithm) fail('access rights need an algorithm');
        return (
          `<accessright consumerindex="${consumer}"><kekparams wrappingalgorithm="${escaped(wrappingAlgorithm)}"` +
          `${attribute('mgfalgorithm', mgfAlgorithm)}${attribute('digestmethod', digestMethod)}/>` +
          `<cipherdata><xenc:CipherValue>${base64(wrappedKey, 'wrappedKey')}</xenc:CipherValue></cipherdata></accessright>`
        );
      });
      return { uuid: identified(keyUUID), rights: rights.join(''), resources: [] as string[] };
    });
  const encrypted = new Set<string>();
  for (const part of parts) {
    const { name } = part;
    if (name === '[Content_Types].xml' || name === '3D/3dmodel.model' || name.endsWith('.rels')) continue;
    signal?.throwIfAborted();
    const path = `/${name}`,
      made = await encrypt({ path, data: part.data });
    if (!made) continue;
    const { group, data, algorithm = AES, compression = 'none', iv, tag, aad } = made;
    if (!keys[group]) fail('encrypted parts name a group by its index');
    if (compression !== 'none' && compression !== 'deflate') fail("compression must be 'none' or 'deflate'");
    if (!(data instanceof Uint8Array)) throw new TypeError('3MF secure content data must be bytes');
    const values = Object.entries({ iv, tag, aad })
      .map(([element, bytes]) => (bytes ? `<${element}>${base64(bytes, element)}</${element}>` : ''))
      .join('');
    keys[group].resources.push(
      `<resourcedata path="${escaped(path)}"><cekparams encryptionalgorithm="${escaped(algorithm)}" compression="${compression}">${values}</cekparams></resourcedata>`,
    );
    part.data = cipherFile(data);
    encrypted.add(path);
  }
  const encoder = new TextEncoder(),
    decoder = new TextDecoder(),
    edit = (name: string, change: (text: string) => string): void => {
      const part = parts.find((p) => p.name === name)!;
      part.data = encoder.encode(change(decoder.decode(part.data)));
    },
    related = (target: string, type: string, id: string): string =>
      `<Relationship Target="${target}" Id="${id}" Type="${type}"/>`;
  // Each relationship to an encrypted part is joined by one that says so, in the same file (section 3.3).
  for (const { name } of parts.filter((p) => p.name.endsWith('.rels')))
    edit(name, (text) => {
      const added = [...text.matchAll(/<Relationship Target="([^"]+)"/g)]
        .filter(([, target]) => encrypted.has(target))
        .map(([, target], i) => related(target, `${PACKAGE}encryptedfile`, `enc${i}`));
      return text.replace('</Relationships>', `${added.join('')}</Relationships>`);
    });
  edit('_rels/.rels', (text) =>
    text.replace(
      '</Relationships>',
      `${related('/Secure/keystore.xml', KEYSTORE, 'keystore')}${related('/Secure/keystore.xml', `${PACKAGE}mustpreserve`, 'keep')}</Relationships>`,
    ),
  );
  edit('[Content_Types].xml', (text) =>
    text.replace(
      '</Types>',
      '<Override PartName="/Secure/keystore.xml" ContentType="application/vnd.ms-package.3dmanufacturing-keystore+xml"/></Types>',
    ),
  );
  const body = keys
    .map((key) => `<resourcedatagroup keyuuid="${key.uuid}">${key.rights}${key.resources.join('')}</resourcedatagroup>`)
    .join('');
  parts.push({
    name: 'Secure/keystore.xml',
    data: encoder.encode(
      `<?xml version="1.0" encoding="UTF-8"?>\n<keystore xmlns="${SECURE}" xmlns:xenc="http://www.w3.org/2001/04/xmlenc#" UUID="${identified(uuid)}">${listed.join('')}${body}</keystore>\n`,
    ),
  });
}
