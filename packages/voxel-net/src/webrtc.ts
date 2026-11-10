import { MargoError } from '@margoengine/math/errors';
import { dataChannelConnection, type DataChannels } from '@margoengine/netcode/webrtc';
import type { VoxelWorld } from '@margoengine/voxel';
import type { VoxelNetClient, VoxelNetClientOptions } from './client.js';
import type { VoxelServer, VoxelServerConnection } from './server.js';
import { joinOver, voxelNetServerConnection } from './webtransport.js';

/** Options for the browser's WebRTC datagram client. */
export interface VoxelWebRTCOptions extends VoxelNetClientOptions {
  /** Stops waiting and closes both channels. */
  signal?: AbortSignal;
  /** Maximum channel-opening wait, ms. Default 10,000. */
  timeout?: number;
  /** Unreliable backlog bound in bytes. Default 65,536, as in netcode. */
  dropUnreliableAbove?: number;
}

function validate(channels: DataChannels): void {
  if (!channels?.reliable || !channels.unreliable)
    throw new TypeError('Voxel WebRTC needs reliable and unreliable channels; use netcode createDataChannels(peer)');
  if (
    !channels.reliable.ordered ||
    channels.reliable.maxRetransmits !== null ||
    channels.reliable.maxPacketLifeTime !== null
  )
    throw new TypeError('Reliable channel must be ordered with no retransmission limit; use createDataChannels(peer)');
  if (channels.unreliable.ordered || channels.unreliable.maxRetransmits !== 0)
    throw new TypeError('Datagram channel must be unordered with maxRetransmits 0; use createDataChannels(peer)');
}

/**
 * Adapts two RTC channels to an authoritative server connection. Start the server first, then accept before exchanging
 * SDP/ICE so early hello messages cannot be lost. Only players snapshots use the unordered channel; chunks and state
 * corrections stay reliable. Signalling and RTCPeerConnection ownership remain with the application.
 */
export function acceptVoxelNetWebRTC(
  server: VoxelServer,
  channels: DataChannels,
  options: { request?: Parameters<VoxelServer['accept']>[1]; address?: string; dropUnreliableAbove?: number } = {},
): VoxelServerConnection {
  validate(channels);
  const connection = dataChannelConnection(channels, options);
  const adapted = voxelNetServerConnection(connection);
  try {
    server.accept(adapted, options.request, options.address);
  } catch (error) {
    connection.close();
    throw error;
  }
  return adapted;
}

/**
 * Waits for both channels, then joins with the ordinary voxel codec. Inputs use redundant unordered datagrams;
 * hello, edits and app messages use the reliable channel. Works without WebTransport. Use netcode createDataChannels
 * at both peers and exchange SDP/ICE using your existing authenticated signalling service.
 */
export async function connectVoxelNetWebRTC(
  channels: DataChannels,
  world: VoxelWorld,
  options: VoxelWebRTCOptions = {},
): Promise<VoxelNetClient> {
  validate(channels);
  const timeout = options.timeout ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000)
    throw new RangeError('WebRTC timeout must be 1 to 600000 ms; use 10000');
  if (
    options.dropUnreliableAbove !== undefined &&
    (!Number.isSafeInteger(options.dropUnreliableAbove) || options.dropUnreliableAbove < 0)
  )
    throw new RangeError('dropUnreliableAbove must be a non-negative safe byte count; use 65536');
  const connection = dataChannelConnection(channels, options);
  try {
    options.signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const all = [channels.reliable, channels.unreliable!];
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = (): void => {
        clearTimeout(timer);
        for (const channel of all) {
          channel.removeEventListener('open', check);
          channel.removeEventListener('close', failed);
          channel.removeEventListener('error', failed);
        }
        options.signal?.removeEventListener('abort', aborted);
      };
      const failed = (): void => {
        cleanup();
        reject(
          new MargoError('failed', 'WebRTC channel closed before joining; check signalling and ICE/TURN configuration'),
        );
      };
      const aborted = (): void => {
        cleanup();
        reject(options.signal?.reason);
      };
      const check = (): void => {
        if (all.some((channel) => channel.readyState === 'closed' || channel.readyState === 'closing')) return failed();
        if (all.every((channel) => channel.readyState === 'open')) {
          cleanup();
          resolve();
        }
      };
      timer = setTimeout(() => {
        cleanup();
        reject(
          new MargoError('failed', 'WebRTC channels did not open before timeout; check signalling or raise timeout'),
        );
      }, timeout);
      for (const channel of all) {
        channel.addEventListener('open', check);
        channel.addEventListener('close', failed);
        channel.addEventListener('error', failed);
      }
      options.signal?.addEventListener('abort', aborted, { once: true });
      check();
    });
    options.signal?.throwIfAborted();
    return joinOver(connection, world, options);
  } catch (error) {
    connection.close();
    throw error;
  }
}
