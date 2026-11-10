import { MargoError } from '@margoengine/math/errors';
import { safeStorage, type SafeStorage, type SafeStorageOptions } from './safe.js';
import type { SaveStorage } from './storage.js';

/** Options for {@link signedStorage}; unsigned legacy data is never accepted. */
export interface SignedStorageOptions extends Omit<SafeStorageOptions, 'legacy'> {
  /** WebCrypto provider. Default globalThis.crypto.subtle, resolved on first use. */
  subtle?: SubtleCrypto;
}

const header = new Uint8Array([77, 83, 73, 71, 1]),
  tagBytes = 32;
const invalid = (key: string): MargoError =>
  new MargoError('failed', `Save '${key}' failed HMAC authentication; use the correct key or restore a trusted backup`);

// Fixed format/version domain, key byte length, exact JS key code units (UTF-16BE), then the entire safe frame.
function message(key: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(header.length + 4 + key.length * 2 + payload.length),
    view = new DataView(bytes.buffer);
  bytes.set(header);
  view.setUint32(header.length, key.length * 2);
  for (let i = 0; i < key.length; i++) view.setUint16(header.length + 4 + i * 2, key.charCodeAt(i));
  bytes.set(payload, header.length + 4 + key.length * 2);
  return bytes;
}

/**
 * Two-copy safeStorage with HMAC-SHA-256 authentication of every copy, its physical key and generation included.
 * Key is a secret HMAC/SHA-256 CryptoKey with sign+verify usages, or at least 32 random bytes (copied on creation).
 * Import and crypto operations are lazy; keys are never saved. Every read uses WebCrypto.verify before safeStorage sees bytes.
 * A forged/torn newest copy is reported through onRecover and falls back to the older authenticated copy.
 * Authentication does not encrypt saves or prevent replay of an older valid copy under the same physical key.
 * @throws TypeError for an unsuitable key or storage; supply an HMAC-SHA-256 signing/verifying key and a SaveStorage.
 * @throws MargoError 'unsupported' without WebCrypto, 'failed' when no authenticated copy remains. Restore a trusted backup.
 */
export function signedStorage(
  storage: SaveStorage,
  key: CryptoKey | Uint8Array,
  options: SignedStorageOptions = {},
): SafeStorage {
  if (
    !storage ||
    !['read', 'write', 'delete', 'keys'].every((name) => typeof storage[name as keyof SaveStorage] === 'function')
  )
    throw new TypeError('signedStorage needs a SaveStorage; pass memoryStorage or another storage adapter');
  const raw = key instanceof Uint8Array ? key.slice() : undefined;
  const validKey = (candidate: CryptoKey): boolean => {
    const algorithm = candidate?.algorithm as HmacKeyAlgorithm | undefined;
    return (
      candidate?.type === 'secret' &&
      algorithm?.name === 'HMAC' &&
      algorithm.hash?.name === 'SHA-256' &&
      algorithm.length >= 256 &&
      candidate.usages.includes('sign') &&
      candidate.usages.includes('verify')
    );
  };
  if (raw ? raw.length < 32 : !validKey(key as CryptoKey))
    throw new TypeError(
      'signedStorage key must be 32 or more random bytes or a >=256-bit HMAC-SHA-256 CryptoKey with sign and verify usages; generate a suitable key',
    );
  let imported: Promise<CryptoKey> | undefined;
  const crypto = (): SubtleCrypto => {
    const provider = options.subtle ?? globalThis.crypto?.subtle;
    if (!provider)
      throw new MargoError('unsupported', 'WebCrypto is unavailable; use a secure context or supply options.subtle');
    return provider;
  };
  const signingKey = (provider: SubtleCrypto): Promise<CryptoKey> => {
    imported ??= raw
      ? provider.importKey('raw', raw as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, [
          'sign',
          'verify',
        ])
      : Promise.resolve(key as CryptoKey);
    return imported;
  };
  const { subtle: _subtle, ...safeOptions } = options;
  return safeStorage(
    {
      async read(name, call) {
        call?.signal?.throwIfAborted();
        const stored = await storage.read(name, call);
        call?.signal?.throwIfAborted();
        if (stored === null) return null;
        if (stored.length < header.length + tagBytes || !header.every((byte, i) => byte === stored[i]))
          throw invalid(name);
        const payload = stored.slice(header.length + tagBytes),
          provider = crypto(),
          secret = await signingKey(provider);
        call?.signal?.throwIfAborted();
        const valid = await provider.verify(
          'HMAC',
          secret,
          stored.slice(header.length, header.length + tagBytes),
          message(name, payload),
        );
        call?.signal?.throwIfAborted();
        if (!valid) throw invalid(name);
        return payload;
      },
      async write(name, bytes, call) {
        call?.signal?.throwIfAborted();
        const payload = bytes.slice(),
          provider = crypto(),
          secret = await signingKey(provider);
        call?.signal?.throwIfAborted();
        const signature = new Uint8Array(await provider.sign('HMAC', secret, message(name, payload)));
        call?.signal?.throwIfAborted();
        const framed = new Uint8Array(header.length + tagBytes + payload.length);
        framed.set(header);
        framed.set(signature, header.length);
        framed.set(payload, header.length + tagBytes);
        await storage.write(name, framed, call);
      },
      delete: (name, call) => storage.delete(name, call),
      keys: (call) => storage.keys(call),
    },
    { ...safeOptions, legacy: false },
  );
}
