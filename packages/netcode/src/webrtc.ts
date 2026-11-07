// A Connection over two WebRTC data channels: one ordered and reliable, one unordered with no retransmits (real
// unreliable delivery in browsers). Signalling (exchanging offers, answers and ICE candidates) goes over any
// channel: `@margoengine/netcode/signal` is one, or carry them yourself.
import { CloseCode, type Connection, type Delivery } from './transport.js';

/** The two data channels of one peer connection, as {@link createDataChannels} makes them. */
export interface DataChannels {
  /** Ordered, reliable. */
  reliable: RTCDataChannel;
  /** Unordered, `maxRetransmits: 0`. Optional: without it unreliable messages go on the reliable channel. */
  unreliable?: RTCDataChannel;
}

/**
 * Creates the two netcode data channels on `peer`, pre-negotiated (ids 0 and 1, `negotiated: true`), so both sides
 * call this with the same arguments and no extra signalling is needed for them.
 */
export function createDataChannels(
  peer: RTCPeerConnection,
  { ids = [0, 1] }: { ids?: [number, number] } = {},
): DataChannels {
  return {
    reliable: peer.createDataChannel('netcode-reliable', { negotiated: true, id: ids[0], ordered: true }),
    unreliable: peer.createDataChannel('netcode-unreliable', {
      negotiated: true,
      id: ids[1],
      ordered: false,
      maxRetransmits: 0,
    }),
  };
}

class DataChannelConnection implements Connection {
  onmessage: ((data: Uint8Array, channel: Delivery) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  private closed = false;
  constructor(
    private readonly channels: DataChannels,
    private readonly dropAbove: number,
  ) {
    for (const [kind, channel] of [
      ['reliable', channels.reliable],
      ['unreliable', channels.unreliable],
    ] as const) {
      if (!channel) continue;
      channel.binaryType = 'arraybuffer';
      channel.addEventListener('message', (event: MessageEvent) => {
        if (this.closed) return;
        if (!(event.data instanceof ArrayBuffer)) return this.close(CloseCode.protocol, 'text message');
        this.onmessage?.(new Uint8Array(event.data), kind);
      });
      channel.addEventListener('close', () => this.finish(CloseCode.normal, 'data channel closed'));
    }
  }
  get open(): boolean {
    return !this.closed && this.channels.reliable.readyState === 'open';
  }
  send(data: Uint8Array, channel: Delivery = 'reliable'): void {
    if (!this.open) return;
    const unreliable = this.channels.unreliable;
    if (channel === 'unreliable' && unreliable?.readyState === 'open') {
      if (unreliable.bufferedAmount <= this.dropAbove) unreliable.send(data as Uint8Array<ArrayBuffer>);
      return;
    }
    this.channels.reliable.send(data as Uint8Array<ArrayBuffer>);
  }
  close(code: number = CloseCode.normal, reason = ''): void {
    if (this.closed) return;
    this.channels.unreliable?.close();
    this.channels.reliable.close();
    this.finish(code, reason);
  }
  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.(code, reason);
  }
}

/**
 * A {@link Connection} over data channels that are open (or opening: messages sent before then are dropped, so wait
 * for the reliable channel's `open` event first). Closing it closes both channels; the far end sees a normal close.
 * The close code and reason are not carried over WebRTC; send a game message first if the other side needs them.
 *
 * @example
 * ```ts
 * const peer = new RTCPeerConnection();
 * const channels = createDataChannels(peer);
 * // ... exchange offer, answer and ICE candidates through your signalling ...
 * await new Promise((open) => channels.reliable.addEventListener('open', open, { once: true }));
 * const connection = dataChannelConnection(channels);
 * ```
 */
export function dataChannelConnection(
  channels: DataChannels,
  { dropUnreliableAbove = 65536 }: { dropUnreliableAbove?: number } = {},
): Connection {
  if (!channels?.reliable || typeof channels.reliable.send !== 'function')
    throw new TypeError(
      'dataChannelConnection needs { reliable, unreliable? } RTCDataChannels; pass createDataChannels(peer)',
    );
  return new DataChannelConnection(channels, dropUnreliableAbove);
}
