/** Decodes an RFC 2397 data: URI to its exact bytes (base64 or percent-encoded), refusing more than `maximum`. */
export function dataURI(uri: string, maximum: number): Uint8Array | undefined {
  if (!uri.startsWith('data:')) return undefined;
  const comma = uri.indexOf(',');
  if (comma < 0) throw new TypeError('Metadata data URI has no comma; provide a complete encoded resource');
  const payload = uri.slice(comma + 1);
  if (uri.slice(0, comma).includes(';base64')) {
    const clean = payload.replace(/\s/g, ''),
      size = Math.floor((clean.length * 3) / 4) - (clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0);
    if (size > maximum)
      throw new RangeError(
        'Metadata data URI exceeds maximumBytes; reduce the embedded resource or raise its byte limit',
      );
    const text = atob(clean);
    return Uint8Array.from(text, (c) => c.charCodeAt(0));
  }
  const bytes = new Uint8Array(Math.min(maximum, payload.length * 3));
  let at = 0;
  for (let i = 0; i < payload.length; ) {
    let part: Uint8Array;
    if (payload[i] === '%') {
      const hex = payload.slice(i + 1, i + 3);
      if (!/^[\da-f]{2}$/i.test(hex))
        throw new TypeError('Metadata data URI has an invalid escape; percent-encode complete bytes');
      part = Uint8Array.of(parseInt(hex, 16));
      i += 3;
    } else {
      const point = payload.codePointAt(i)!;
      part = new TextEncoder().encode(String.fromCodePoint(point));
      i += point > 65535 ? 2 : 1;
    }
    if (at + part.length > bytes.length)
      throw new RangeError(
        'Metadata data URI exceeds maximumBytes; reduce the embedded resource or raise its byte limit',
      );
    bytes.set(part, at);
    at += part.length;
  }
  return bytes.subarray(0, at);
}
