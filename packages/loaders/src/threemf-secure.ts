// Reads the unencrypted structure of the 3MF Consortium's Secure Content Extension
// (https://github.com/3MFConsortium/spec_securecontent): the key store, the encrypted-file relationships and the cipher
// file headers. It decrypts nothing and handles no key; the caller does.
import { LoaderError } from './types.js';
import { throwIfAborted, toBytes, type BinaryInput } from './util.js';
import { readZipDirectory, readZipEntry, type ZipEntry, type ZipOptions } from './zip.js';
import { decodeXML, readXML } from './xml.js';

const F = '3MF';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Options of {@link parse3MFKeystore}: the zip limits and an AbortSignal. */
export interface ThreeMFKeystoreOptions extends Pick<ZipOptions, 'maxEntries' | 'maxEntryBytes' | 'maxRatio'> {
  signal?: AbortSignal;
}

/** A content key wrapped for one consumer. */
export interface ThreeMFKeyAccess {
  /** The consumer's index in `consumers`. */
  consumer: number;
  wrappingAlgorithm: string;
  mgfAlgorithm?: string;
  digestMethod?: string;
  wrappedKey: Uint8Array;
}

/** An encrypted part and what decrypting it needs. */
export interface ThreeMFEncryptedResource {
  /** Its path in the package. */
  path: string;
  algorithm: string;
  compression: 'none' | 'deflate';
  iv?: Uint8Array;
  tag?: Uint8Array;
  aad?: Uint8Array;
  /** The encrypted bytes, after the cipher file's header. */
  content: Uint8Array;
}

/** The result of {@link parse3MFKeystore}. */
export interface ThreeMFKeystore {
  uuid: string;
  consumers: { id: string; keyId?: string; publicKey?: string }[];
  groups: { keyUUID: string; access: ThreeMFKeyAccess[]; resources: ThreeMFEncryptedResource[] }[];
}

const bad = (message: string): never => {
  throw new LoaderError(F, 'syntax', message);
};
const required = (a: Record<string, string>, key: string, element: string): string =>
  a[key] ?? bad(`<${element}> without ${key}`);
const normalize = (path: string): string => path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
const bytesOf = (text: string, what: string): Uint8Array => {
  try {
    return Uint8Array.from(atob(text.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  } catch {
    return bad(`${what} is not base64`);
  }
};

/**
 * Reads a 3MF package's key store, or undefined when it has none. Each encrypted part's bytes come without the cipher
 * file header; unwrapping the keys and decrypting are the caller's.
 *
 * @throws LoaderError for a key store the extension rules out: a bad UUID, an access right with no such consumer, a part
 * listed twice, missing, without an encrypted-file relationship or without a version 0 cipher header, an encrypted root
 * model or relationships part, and ZIP or XML faults.
 */
export async function parse3MFKeystore(
  input: BinaryInput,
  options: ThreeMFKeystoreOptions = {},
): Promise<ThreeMFKeystore | undefined> {
  const bytes = toBytes(input, F),
    byPath = new Map<string, ZipEntry>();
  for (const entry of readZipDirectory(bytes, options)) byPath.set(normalize(entry.name), entry);
  const read = async (path: string): Promise<Uint8Array> => {
    throwIfAborted(options.signal, F);
    const entry = byPath.get(normalize(path));
    if (!entry) throw new LoaderError(F, 'syntax', `package part "${path.slice(0, 128)}" is missing`);
    return readZipEntry(bytes, entry, options);
  };
  /** The targets of encrypted-file relationships, from any relationships part. */
  const marked = new Set<string>();
  let location: string | undefined, root: string | undefined;
  for (const path of byPath.keys()) {
    if (!path.endsWith('.rels')) continue;
    readXML(
      decodeXML(await read(path)),
      {
        open(name, a) {
          if (name !== 'Relationship' || !a.Target) return;
          if (a.Type?.endsWith('/encryptedfile')) marked.add(normalize(a.Target));
          else if (path === '_rels/.rels' && a.Type?.endsWith('/keystore')) location = a.Target;
          else if (path === '_rels/.rels' && a.Type?.endsWith('/3dmodel')) root = normalize(a.Target);
        },
        close() {},
      },
      F,
    );
  }
  if (location === undefined) return undefined;
  const store: ThreeMFKeystore = { uuid: '', consumers: [], groups: [] },
    listed = new Set<string>(),
    identified = (value: string): string => (UUID.test(value) ? value : bad(`invalid UUID ${value.slice(0, 40)}`));
  let text = '',
    consumer: ThreeMFKeystore['consumers'][number] | undefined,
    group: ThreeMFKeystore['groups'][number] | undefined,
    access: ThreeMFKeyAccess | undefined,
    resource: ThreeMFEncryptedResource | undefined;
  readXML(
    decodeXML(await read(location)),
    {
      open(name, a) {
        text = '';
        if (name === 'keystore') store.uuid = identified(required(a, 'UUID', name));
        else if (name === 'consumer') {
          consumer = { id: required(a, 'consumerid', name), ...(a.keyid === undefined ? {} : { keyId: a.keyid }) };
          if (store.consumers.some((c) => c.id === consumer!.id)) bad(`consumer ${consumer.id.slice(0, 64)} twice`);
          store.consumers.push(consumer);
        } else if (name === 'resourcedatagroup') {
          group = { keyUUID: identified(required(a, 'keyuuid', name)), access: [], resources: [] };
          store.groups.push(group);
        } else if (name === 'accessright') {
          const at = Number(required(a, 'consumerindex', name));
          if (!group || !store.consumers[at]) bad('an access right names no consumer of the key store');
          access = { consumer: at, wrappingAlgorithm: '', wrappedKey: new Uint8Array(0) };
          group!.access.push(access);
        } else if (name === 'kekparams' && access) {
          access.wrappingAlgorithm = required(a, 'wrappingalgorithm', name);
          if (a.mgfalgorithm !== undefined) access.mgfAlgorithm = a.mgfalgorithm;
          if (a.digestmethod !== undefined) access.digestMethod = a.digestmethod;
        } else if (name === 'resourcedata') {
          const path = required(a, 'path', name),
            key = normalize(path);
          if (!group || listed.has(key)) bad(`resource ${path.slice(0, 128)} is listed twice or outside a group`);
          if (key === root || key.endsWith('.rels'))
            bad(`the root model and relationships parts must not be encrypted: ${path.slice(0, 128)}`);
          if (!marked.has(key)) bad(`resource ${path.slice(0, 128)} has no encrypted-file relationship`);
          listed.add(key);
          resource = { path, algorithm: '', compression: 'none', content: new Uint8Array(0) };
          group!.resources.push(resource);
        } else if (name === 'cekparams' && resource) {
          resource.algorithm = required(a, 'encryptionalgorithm', name);
          const compression = a.compression ?? 'none';
          if (compression !== 'none' && compression !== 'deflate') bad('compression must be none or deflate');
          resource.compression = compression as ThreeMFEncryptedResource['compression'];
        }
      },
      close(name) {
        if (name === 'keyvalue' && consumer) consumer.publicKey = text.trim();
        else if (name === 'CipherValue' && access) access.wrappedKey = bytesOf(text, name);
        else if ((name === 'iv' || name === 'tag' || name === 'aad') && resource) resource[name] = bytesOf(text, name);
        else if (name === 'consumer') consumer = undefined;
        else if (name === 'accessright') {
          if (!access?.wrappingAlgorithm || !access.wrappedKey.length)
            bad('an access right needs kekparams and a CipherValue');
          access = undefined;
        } else if (name === 'resourcedata') {
          if (!resource?.algorithm) bad('a resource needs cekparams');
          resource = undefined;
        } else if (name === 'resourcedatagroup') group = undefined;
        text = '';
      },
      text(value) {
        text += value;
      },
    },
    F,
  );
  if (!store.uuid) bad('the key store part holds no keystore element');
  for (const { resources } of store.groups)
    for (const found of resources) {
      const file = await read(found.path),
        header = file.length >= 12 ? new DataView(file.buffer, file.byteOffset).getUint32(8, true) : 0;
      if ([0x25, 0x33, 0x4d, 0x63, 0x46, 0, 0, 0].some((v, i) => file[i] !== v) || header < 12 || header > file.length)
        bad(`${found.path.slice(0, 128)} is not a version 0 3MF cipher file`);
      found.content = file.subarray(header);
    }
  return store;
}
