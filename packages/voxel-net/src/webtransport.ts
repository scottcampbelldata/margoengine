// @margoengine/voxel-net/webtransport: voxel-net over WebTransport (W3C WebTransport on HTTP/3), through the
// Connection of @margoengine/netcode/webtransport. Movement goes as unreliable datagrams, so a lost packet never holds
// up the ones behind it: each input datagram carries copies of the last few (the server cuts the steps it has and fills
// a gap with the last keys held), and each player snapshot stands alone (no delta against a message that may be lost;
// a late one is dropped). Everything else (hello, chunks, edits, corrections, names, app messages) goes on the one
// reliable stream, as on a WebSocket. Redundant inputs as in G. Fiedler, "What every programmer needs to know about
// game networking" and "Reliability and congestion avoidance over UDP" (gafferongames.com, 2008 and 2010).
import { MargoError } from '@margoengine/math/errors';
import type { Connection } from '@margoengine/netcode';
import {
  acceptWebTransport,
  type OpenWebTransportOptions,
  openWebTransport,
  type WebTransportConnectionOptions,
  type WebTransportSession,
} from '@margoengine/netcode/webtransport';
import type { VoxelWorld } from '@margoengine/voxel';
import { VoxelNetClient, type VoxelNetClientOptions, type VoxelNetTransport } from './client.js';
import type { VoxelServer, VoxelServerConnection } from './server.js';

// Message type bytes that go as datagrams (protocol.ts): a client's input, the server's players snapshot.
const INPUT = 2,
  PLAYERS = 21,
  // netcode's close code for a session that failed (the peer stopped answering): a drop, as WebSocket 1006.
  NETCODE_TIMEOUT = 4006;

/**
 * The server end of one WebTransport session as a {@link VoxelServerConnection}: players snapshots go as datagrams,
 * the rest on the reliable stream. `buffered` is 0 (a WebTransport writer does not say), so the server's slow-client
 * check does not see a backed-up stream; netcode drops datagrams while the stream holds over `dropUnreliableAbove`.
 */
export function voxelNetServerConnection(connection: Connection): VoxelServerConnection {
  if (!connection || typeof connection.send !== 'function')
    throw new TypeError('voxelNetServerConnection needs a Connection; pass one from acceptWebTransport');
  let bytesIn = 0;
  const conn: VoxelServerConnection & { bytesIn: number } = {
    datagrams: true,
    buffered: 0,
    get bytesIn() {
      return bytesIn;
    },
    onmessage: null,
    onclose: null,
    send: (data) => connection.send(data, data[0] === PLAYERS ? 'unreliable' : 'reliable'),
    close: (code = 1000, reason = '') => connection.close(code, reason),
    cork: () => {},
    uncork: () => {},
    ping: () => {},
  };
  connection.onmessage = (data) => {
    bytesIn += data.length;
    conn.onmessage?.(data);
  };
  connection.onclose = (code, reason) => conn.onclose?.(code === NETCODE_TIMEOUT ? 1006 : code, reason);
  return conn;
}

/**
 * Takes a player on over a WebTransport session your HTTP/3 server accepted (a session of the W3C shape): waits for
 * the stream the client opens, then hands the connection to `server.accept`.
 *
 * ```ts
 * // In your HTTP/3 server's WebTransport handler:
 * await acceptVoxelNetWebTransport(server, session, { request, address });
 * ```
 * @throws MargoError `failed` (as a rejection) when the session ends before the client opened its stream.
 */
export async function acceptVoxelNetWebTransport(
  server: VoxelServer,
  session: WebTransportSession,
  options: WebTransportConnectionOptions & { request?: Parameters<VoxelServer['accept']>[1]; address?: string } = {},
): Promise<void> {
  const connection = await acceptWebTransport(session, options);
  server.accept(voxelNetServerConnection(connection), options.request, options.address);
}

/**
 * The client end of a netcode Connection as a {@link VoxelNetTransport} with `datagrams`: inputs go as datagrams,
 * the rest on the reliable stream. Wire its messages into the client yourself, or use {@link connectVoxelNetWebTransport}.
 */
export function voxelNetTransport(connection: Connection): VoxelNetTransport {
  if (!connection || typeof connection.send !== 'function')
    throw new TypeError('voxelNetTransport needs a Connection; pass one from openWebTransport');
  return {
    datagrams: true,
    send: (data) => connection.send(data, data[0] === INPUT ? 'unreliable' : 'reliable'),
    close: () => connection.close(1000, ''),
  };
}

/** Options of {@link connectVoxelNetWebTransport}. */
export interface ConnectVoxelNetWebTransportOptions extends VoxelNetClientOptions, OpenWebTransportOptions {}

/**
 * Connects to a voxel-net server over WebTransport (`https://`, HTTP/3) and joins. The client's `onClose` gets how the
 * session ended; a dropped session is not resumed (connect again).
 *
 * ```ts
 * const client = await connectVoxelNetWebTransport('https://play.example.com/voxel', world, { name: 'Ada' });
 * ```
 * @throws MargoError `unsupported` where there is no WebTransport, `failed` when the session does not come up.
 */
export async function connectVoxelNetWebTransport(
  url: string,
  world: VoxelWorld,
  options: ConnectVoxelNetWebTransportOptions = {},
): Promise<VoxelNetClient> {
  const connection = await openWebTransport(url, options);
  return joinOver(connection, world, options);
}

/**
 * A client over a netcode Connection you opened (for a WebTransport you set up yourself, or a test link).
 * @throws MargoError `state` when the connection is closed already.
 */
export function joinOver(
  connection: Connection,
  world: VoxelWorld,
  options: VoxelNetClientOptions = {},
): VoxelNetClient {
  if (!connection.open) throw new MargoError('state', 'The connection is closed already; open a new one to join');
  let byClient = false;
  const transport = voxelNetTransport(connection),
    client = new VoxelNetClient(
      world,
      {
        datagrams: true,
        send: transport.send,
        close: () => {
          byClient = true;
          transport.close();
        },
      },
      options,
    );
  connection.onmessage = (data) => client.receive(data);
  connection.onclose = (code, reason) => {
    client.close();
    client.onClose({ code: code === NETCODE_TIMEOUT ? 1006 : code, reason, byClient });
  };
  return client;
}
