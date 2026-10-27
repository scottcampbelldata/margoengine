// The netcode envelope: one kind byte, then the fields below (README "Wire format", "Envelope"). Game data inside
// (inputs, state, messages) is schema bytes. Decoders check every length, so hostile bytes throw a RangeError.
import { Reader, Writer } from './schema.js';

/** Version of the envelope; a server closes connections that say another. */
export const PROTOCOL_VERSION = 1;
/** Most inputs one `inputs` message may carry. */
export const MAX_INPUTS_PER_MESSAGE = 32;
/** Most bytes of one encoded input. */
export const MAX_INPUT_BYTES = 1024;

/** One envelope message. Ticks are unsigned 32-bit; tick 0 is the state before the first step. */
export type Envelope =
  /** Client to server, first: the envelope version and the schema hash. */
  | { kind: 'hello'; version: number; schema: number }
  /** Server to client: your player id, the tick rate, the server's tick and how often it sends snapshots. */
  | { kind: 'welcome'; player: number; tickRate: number; tick: number; snapshotEvery: number }
  /** Client to server: inputs for ticks `first`, `first + 1`, ... and the newest snapshot tick the client holds. */
  | { kind: 'inputs'; ack: number; first: number; inputs: Uint8Array[] }
  /**
   * Server to client: the state after `tick`, encoded against the snapshot of tick `baseline` (0: in full); the
   * newest tick of this client's inputs the server has, and how many ticks it had to run without one.
   */
  | { kind: 'snapshot'; tick: number; baseline: number; input: number; missed: number; data: Uint8Array }
  /** Client to server: the client's clock in milliseconds. */
  | { kind: 'ping'; time: number }
  /** Server to client: the ping's time back, the server's last tick and how far (0 to 1) it is into the next. */
  | { kind: 'pong'; time: number; tick: number; fraction: number }
  /** Either way, reliable: a game message of schema type number `type`. */
  | { kind: 'message'; type: number; data: Uint8Array };

const KINDS = ['hello', 'welcome', 'inputs', 'snapshot', 'ping', 'pong', 'message'] as const;

const uint = (what: string, v: number): number => {
  if (!Number.isInteger(v) || v < 0 || v > 2 ** 32 - 1)
    throw new RangeError(`Envelope ${what} is ${v}; pass an integer from 0 to 2^32 - 1`);
  return v;
};

/**
 * Bytes of one envelope message.
 * @throws RangeError for a field out of range or more than {@link MAX_INPUTS_PER_MESSAGE} inputs.
 */
export function encodeEnvelope(message: Envelope): Uint8Array {
  const w = new Writer(32);
  w.u8(KINDS.indexOf(message.kind) + 1);
  switch (message.kind) {
    case 'hello':
      w.varint(uint('version', message.version));
      w.u32(uint('schema', message.schema));
      break;
    case 'welcome':
      w.varint(uint('player', message.player));
      w.varint(uint('tickRate', message.tickRate));
      w.varint(uint('tick', message.tick));
      w.varint(uint('snapshotEvery', message.snapshotEvery));
      break;
    case 'inputs':
      if (message.inputs.length > MAX_INPUTS_PER_MESSAGE)
        throw new RangeError(
          `Envelope carries ${message.inputs.length} inputs; send at most ${MAX_INPUTS_PER_MESSAGE}`,
        );
      w.varint(uint('ack', message.ack));
      w.varint(uint('first', message.first));
      w.varint(message.inputs.length);
      for (const input of message.inputs) {
        if (input.length > MAX_INPUT_BYTES)
          throw new RangeError(`Input is ${input.length} bytes; keep inputs under ${MAX_INPUT_BYTES + 1}`);
        w.varint(input.length);
        w.raw(input);
      }
      break;
    case 'snapshot':
      w.varint(uint('tick', message.tick));
      w.varint(uint('baseline', message.baseline));
      w.varint(uint('input', message.input));
      w.varint(uint('missed', message.missed));
      w.raw(message.data);
      break;
    case 'ping':
      w.f64(message.time);
      break;
    case 'pong':
      w.f64(message.time);
      w.varint(uint('tick', message.tick));
      w.f32(message.fraction);
      break;
    case 'message':
      w.varint(uint('type', message.type));
      w.raw(message.data);
      break;
  }
  return w.done();
}

/**
 * The envelope message in `bytes`.
 * @throws RangeError for truncated or malformed bytes (never anything else).
 */
export function decodeEnvelope(bytes: Uint8Array): Envelope {
  const r = new Reader(bytes, 'Netcode message', 'send what encodeEnvelope returned');
  const kind = KINDS[r.u8() - 1];
  const rest = (): Uint8Array => {
    const out = bytes.slice(r.at);
    r.at = bytes.length;
    return out;
  };
  let message: Envelope;
  switch (kind) {
    case 'hello':
      message = { kind, version: r.varint(), schema: r.u32() };
      break;
    case 'welcome':
      message = { kind, player: r.varint(), tickRate: r.varint(), tick: r.varint(), snapshotEvery: r.varint() };
      break;
    case 'inputs': {
      const ack = r.varint(),
        first = r.varint(),
        n = r.count(MAX_INPUTS_PER_MESSAGE),
        inputs: Uint8Array[] = [];
      for (let i = 0; i < n; i++) {
        const length = r.count(MAX_INPUT_BYTES);
        r.need(length);
        inputs.push(bytes.slice(r.at, (r.at += length)));
      }
      if (first + n > 2 ** 32) throw r.fail('names a tick past 2^32 - 1');
      message = { kind, ack, first, inputs };
      break;
    }
    case 'snapshot':
      message = { kind, tick: r.varint(), baseline: r.varint(), input: r.varint(), missed: r.varint(), data: rest() };
      break;
    case 'ping':
      message = { kind, time: r.f64() };
      break;
    case 'pong':
      message = { kind, time: r.f64(), tick: r.varint(), fraction: r.f32() };
      break;
    case 'message':
      message = { kind, type: r.varint(), data: rest() };
      break;
    default:
      throw r.fail(`has unknown kind ${bytes[0]}`);
  }
  r.end();
  return message;
}
