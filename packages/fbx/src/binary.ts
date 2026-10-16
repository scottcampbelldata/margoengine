import { invalid, type ParseBudget } from './document.js';
import type { FBXNode, FBXValue } from './document.js';

export const binaryMagic = new TextEncoder().encode('Kaydara FBX Binary  \0\x1a\0');
const decoder = new TextDecoder();
const widths: Record<string, number> = { Y: 2, C: 1, I: 4, F: 4, D: 8, L: 8 };

/** FBX arrays retain 32-bit headers even when the node header uses uint64. */
export async function parseBinary(
  bytes: Uint8Array,
  budget: ParseBudget,
): Promise<{ roots: FBXNode[]; version: number }> {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = 23;
  function need(length: number, limit = bytes.length): void {
    if (!Number.isSafeInteger(length) || length < 0 || cursor > limit - length) invalid('truncated binary record');
  }
  function u32(limit = bytes.length): number {
    need(4, limit);
    const value = data.getUint32(cursor, true);
    cursor += 4;
    return value;
  }
  const version = u32();
  if (version < 7400 || version > 7700) invalid(`unsupported version ${version}`);
  const wide = version >= 7500,
    headerBytes = wide ? 25 : 13;
  function field(limit: number): number {
    if (!wide) return u32(limit);
    need(8, limit);
    const value = data.getBigUint64(cursor, true);
    cursor += 8;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid('unsafe node header');
    return Number(value);
  }
  async function inflate(payload: Uint8Array, length: number): Promise<Uint8Array> {
    if (typeof DecompressionStream !== 'function') throw new Error('FBX deflate decoding requires DecompressionStream');
    const output = new Uint8Array(length);
    const chunk =
      payload.buffer instanceof ArrayBuffer
        ? new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
        : new Uint8Array(payload);
    if (!(payload.buffer instanceof ArrayBuffer)) budget.reserve(payload.byteLength);
    const stream = new ReadableStream<BufferSource>({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const reader = stream.pipeThrough(new DecompressionStream('deflate')).getReader();
    const cancel = () => {
      void reader.cancel(budget.signal?.reason).catch(() => {});
    };
    budget.signal?.addEventListener('abort', cancel, { once: true });
    let offset = 0;
    try {
      while (true) {
        budget.check();
        const { value, done } = await reader.read();
        budget.check();
        if (done) break;
        if (value.length > length - offset) invalid('deflate output exceeds declared array size');
        output.set(value, offset);
        offset += value.length;
      }
      if (offset !== length) invalid('deflate output differs from declared array size');
      return output;
    } catch (error) {
      void reader.cancel(error).catch(() => {});
      budget.check();
      if (error instanceof Error && error.message.startsWith('Invalid FBX')) throw error;
      return invalid('invalid deflate stream');
    } finally {
      budget.signal?.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  }
  async function readProperty(limit: number): Promise<FBXValue> {
    budget.check();
    need(1, limit);
    const type = String.fromCharCode(bytes[cursor++]);
    const width = widths[type];
    if (width) {
      need(width, limit);
      const offset = cursor;
      cursor += width;
      switch (type) {
        case 'Y':
          return data.getInt16(offset, true);
        case 'C':
          return data.getUint8(offset) ? 1 : 0;
        case 'I':
          return data.getInt32(offset, true);
        case 'F':
          return data.getFloat32(offset, true);
        case 'D':
          return data.getFloat64(offset, true);
        default:
          return data.getBigInt64(offset, true);
      }
    }
    if (type === 'S' || type === 'R') {
      const length = u32(limit);
      need(length, limit);
      budget.reserve(length * (type === 'S' ? 2 : 1));
      const value = bytes.subarray(cursor, cursor + length);
      cursor += length;
      return type === 'S' ? decoder.decode(value) : value.slice();
    }
    const elementWidth =
      type === 'd' || type === 'l' ? 8 : type === 'f' || type === 'i' ? 4 : type === 'b' || type === 'c' ? 1 : 0;
    if (!elementWidth) invalid(`unknown property type ${type}`);
    const count = u32(limit),
      encoding = u32(limit),
      byteLength = u32(limit),
      decodedLength = count * elementWidth;
    need(byteLength, limit);
    budget.array(decodedLength);
    budget.work(count);
    if (encoding !== 0 && encoding !== 1) invalid('unsupported array encoding');
    if (encoding === 0 && byteLength !== decodedLength) invalid('array byte length differs from count');
    const payload = bytes.subarray(cursor, cursor + byteLength);
    cursor += byteLength;
    const decoded = encoding === 1 ? await inflate(payload, decodedLength) : payload;
    if (elementWidth === 1) return encoding === 1 ? decoded : decoded.slice();
    // DataView handles unaligned source offsets and little endian input on all hosts.
    const source = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
    const result =
      type === 'd'
        ? new Float64Array(count)
        : type === 'f'
          ? new Float32Array(count)
          : type === 'i'
            ? new Int32Array(count)
            : new BigInt64Array(count);
    // Inflated bytes and typed output coexist until this conversion completes.
    if (encoding === 1) budget.reserve(decodedLength);
    for (let index = 0; index < count; index++) {
      if ((index & 4095) === 0) budget.check();
      const offset = index * elementWidth;
      if (result instanceof BigInt64Array) result[index] = source.getBigInt64(offset, true);
      else
        result[index] =
          type === 'd'
            ? source.getFloat64(offset, true)
            : type === 'f'
              ? source.getFloat32(offset, true)
              : source.getInt32(offset, true);
    }
    return result;
  }
  async function node(limit: number, depth: number): Promise<FBXNode | null> {
    need(headerBytes, limit);
    const end = field(limit),
      propertyCount = field(limit),
      propertyLength = field(limit),
      nameLength = bytes[cursor++];
    if (!end && !propertyCount && !propertyLength && !nameLength) return null;
    budget.node(depth);
    budget.property(propertyCount);
    if (end > limit || end < cursor + nameLength || propertyLength > end - cursor - nameLength)
      invalid('invalid node end offset');
    need(nameLength, end);
    const name = decoder.decode(bytes.subarray(cursor, cursor + nameLength));
    cursor += nameLength;
    budget.reserve(nameLength * 2);
    const propertiesEnd = cursor + propertyLength,
      properties: FBXValue[] = [];
    for (let index = 0; index < propertyCount; index++) properties.push(await readProperty(propertiesEnd));
    if (cursor !== propertiesEnd) invalid('property list byte length mismatch');
    const children: FBXNode[] = [];
    if (cursor < end) {
      let terminated = false;
      while (cursor < end) {
        const child = await node(end, depth + 1);
        if (!child) {
          terminated = true;
          break;
        }
        children.push(child);
      }
      if (!terminated || cursor !== end) invalid('missing or misplaced child sentinel');
    }
    return { name, properties, children };
  }
  const roots: FBXNode[] = [];
  while (cursor < bytes.length) {
    const value = await node(bytes.length, 0);
    if (!value) return { roots, version }; // The remaining bytes are the optional FBX footer.
    roots.push(value);
  }
  invalid('missing root sentinel');
}
