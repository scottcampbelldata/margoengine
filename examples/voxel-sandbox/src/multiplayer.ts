// Multiplayer: the sandbox joins a @margoengine/voxel-net server instead of streaming its own world. The server sends
// the chunks and everyone's edits; this module hears how each connection ends, keeps the Plaza name and turns the sandbox's keys into the client's input bits. /join and /report go to the Plaza router;
// see joinPlaza and sendReport.
import type { VoxelWorld } from '@margoengine/voxel';
import { connectVoxelNet, Keys, type VoxelNetClient, type VoxelNetClose } from '@margoengine/voxel-net';
import { isPlazaName, randomName } from './names.ts';

/** A joined server: the client, and how to leave. */
export interface Online {
  readonly client: VoxelNetClient;
  dispose(): void;
}

/**
 * Connects to `url` with `world` (which must be empty: the server fills it) and a view of `view` chunks. `onClosed`
 * hears every end the page did not ask for, whatever its code; `byClient` then means a message it could not read.
 * @throws SyntaxError for a URL WebSocket refuses.
 */
export function joinServer(
  world: VoxelWorld,
  url: string,
  options: { view: number; name: string; onClosed: (closed: VoxelNetClose) => void },
): Online {
  const client = connectVoxelNet(url, world, { name: options.name, view: options.view });
  let leaving = false;
  client.onClose = (closed) => {
    if (!leaving) options.onClosed(closed);
  };
  return {
    client,
    dispose() {
      leaving = true;
      client.close();
    },
  };
}

/**
 * The close code a Plaza shard sends a player with no movement and no edit for its idle limit (reason 'idle'). It is
 * the server's number (examples/voxel-sandbox/server/shard.mjs, IDLE_CLOSE_CODE); a page that rejoined on it would
 * undo the limit, so it shows the world, stops sending and offers a Join button instead.
 */
export const IDLE_CLOSE_CODE = 4410;

/**
 * What to do about a close the page did not ask for: 'idle' stops and waits for the player, 'unreadable' is a message
 * the page could not read (play alone), and everything else (a world's end 1001, a full shard 1013, a crash 1006, a
 * silent server 4408) asks /join where to go.
 */
export function closeKind(closed: Pick<VoxelNetClose, 'code' | 'byClient'>): 'idle' | 'unreadable' | 'rejoin' {
  if (closed.byClient) return 'unreadable';
  return closed.code === IDLE_CLOSE_CODE ? 'idle' : 'rejoin';
}

/** The banner after an idle close; its Join button reloads the page. */
export const IDLE_BANNER = 'You were idle, so Plaza gave your place to someone else. Join to come back.';

/** What the router's GET /join answers. */
export type JoinAnswer =
  | { kind: 'shard'; url: string; shard: number | undefined; world: string | undefined }
  | { kind: 'full'; online: number | undefined }
  | { kind: 'starting'; retryIn: number };

/**
 * Reads the JSON of GET /join: `{url, shard, world}` joins that shard, `{full: true, online}` means no room, and
 * `{starting: true, retryIn}` means between worlds or restarting, so ask again in `retryIn` seconds.
 * @throws TypeError for anything else.
 */
export function parseJoin(value: unknown): JoinAnswer {
  const v = (value ?? {}) as Record<string, unknown>;
  if (v.full === true) return { kind: 'full', online: typeof v.online === 'number' ? v.online : undefined };
  if (v.starting === true) return { kind: 'starting', retryIn: typeof v.retryIn === 'number' ? v.retryIn : 2 };
  if (typeof v.url === 'string' && /^wss?:\/\//.test(v.url))
    return {
      kind: 'shard',
      url: v.url,
      shard: typeof v.shard === 'number' ? v.shard : undefined,
      world: v.world === undefined ? undefined : String(v.world),
    };
  throw new TypeError(
    `The Plaza router answered /join with ${JSON.stringify(value)}; expected {url}, {full} or {starting}`,
  );
}

/**
 * Asks the router at `router` where to play, asking again while it is between worlds, until `signal` ends.
 * @throws when it cannot be reached in that time or answers nonsense.
 */
export async function joinPlaza(
  router: string,
  signal: AbortSignal,
): Promise<Exclude<JoinAnswer, { kind: 'starting' }>> {
  for (;;) {
    const response = await fetch(new URL('join', withSlash(router)), { signal, cache: 'no-store' }),
      answer = parseJoin(await response.json());
    if (answer.kind !== 'starting') return answer;
    await new Promise((done) => setTimeout(done, answer.retryIn * 1000));
    signal.throwIfAborted();
  }
}

/** Posts a griefing report: the column the player stands on, on which shard. @throws when the router refuses or is down. */
export async function sendReport(
  router: string,
  report: { shard: number | undefined; x: number; z: number },
): Promise<void> {
  // JSON as text/plain, the default: a simple request.
  const response = await fetch(new URL('report', withSlash(router)), { method: 'POST', body: JSON.stringify(report) });
  if (!response.ok) throw new Error(`The report was refused (${response.status})`);
}

/**
 * The banner of a page playing alone: `kind` is why, `count` how many are in (a full Plaza), `retrying` whether a router
 * is being asked again.
 */
export function soloBanner(kind: 'full' | 'offline', count: number | undefined, retrying: boolean): string {
  const tail = retrying ? 'building alone, retrying' : 'building alone';
  if (kind === 'full') return `Plaza is full, ${count === undefined ? '' : `${count} people are in, `}${tail}`;
  return retrying ? `Plaza is offline, ${tail}` : `The server is offline, ${tail}`;
}

const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`);

/** The minimum time between two reports from this page, milliseconds; the router holds the same limit per identity. */
export const REPORT_EVERY = 60_000;

const NAME_KEY = 'margo-plaza-name';

/** This browser's Plaza name: kept in localStorage, a new one when there is none or the saved one is not a Plaza name. */
export function plazaName(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, random = Math.random): string {
  try {
    const saved = storage?.getItem(NAME_KEY);
    if (saved && isPlazaName(saved)) return saved;
  } catch {
    // Storage blocked: a new name each visit.
  }
  const name = randomName(random);
  try {
    storage?.setItem(NAME_KEY, name);
  } catch {
    // As above.
  }
  return name;
}

/** The client's input bits for the sandbox's keys (WASD or arrows, Space, Shift or C) and fly mode. */
export function keyBits(keys: ReadonlySet<string>, flying: boolean): number {
  const has = (...codes: string[]) => codes.some((code) => keys.has(code)),
    shift = has('ShiftLeft', 'ShiftRight');
  return (
    (has('KeyW', 'ArrowUp') ? Keys.forward : 0) |
    (has('KeyS', 'ArrowDown') ? Keys.back : 0) |
    (has('KeyA', 'ArrowLeft') ? Keys.left : 0) |
    (has('KeyD', 'ArrowRight') ? Keys.right : 0) |
    (has('Space') ? Keys.jump : 0) |
    (shift || has('KeyC') ? Keys.descend : 0) |
    (shift && !flying ? Keys.sprint : 0) |
    (flying ? Keys.fly : 0)
  );
}
