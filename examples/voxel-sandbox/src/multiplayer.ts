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
 * the page could not read (play alone), and everything else (a world's end 1001, a full shard 1013, a crash 1006 or a
 * silent server 4408 that resuming in place could not get over) asks /join where to go.
 */
export function closeKind(closed: Pick<VoxelNetClose, 'code' | 'byClient'>): 'idle' | 'unreadable' | 'rejoin' {
  if (closed.byClient) return 'unreadable';
  return closed.code === IDLE_CLOSE_CODE ? 'idle' : 'rejoin';
}

/** The banner after an idle close; its Join button reloads the page. */
export const IDLE_BANNER = 'You were idle, so Plaza gave your place to someone else. Join to come back.';

/**
 * The banner while a dropped connection is tried again: nothing on the first try, which is over in under a second, and
 * a line with no button after that. Nothing is reloaded; the world and the player stay.
 */
export function resumeBanner(attempt: number): string {
  return attempt < 2 ? '' : 'Reconnecting to Plaza.';
}

/** What the router's GET /join answers. */
export type JoinAnswer =
  | {
      kind: 'shard';
      url: string;
      shard: number | undefined;
      world: string | undefined;
      /** The world's seed and its floor (the square's height), when the router says; both or neither. */
      seed: number | undefined;
      floor: number | undefined;
      router?: string;
    }
  | { kind: 'full'; online: number | undefined }
  | { kind: 'starting'; retryIn: number };

/**
 * Reads the JSON of GET /join: `{url, shard, world, seed, floor}` joins that shard (the last two are optional), `{full: true, online}` means no room, and
 * `{starting: true, retryIn}` means between worlds or restarting, so ask again in `retryIn` seconds. A shard on another
 * box also names that box's `router` (http or https), which takes this player's griefing reports; any other value is
 * ignored.
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
      seed: Number.isInteger(v.seed) && Number.isInteger(v.floor) ? (v.seed as number) : undefined,
      floor: Number.isInteger(v.seed) && Number.isInteger(v.floor) ? (v.floor as number) : undefined,
      ...(typeof v.router === 'string' && /^https?:\/\/\S/.test(v.router) ? { router: v.router } : {}),
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
  options: { peek?: boolean } = {},
): Promise<Exclude<JoinAnswer, { kind: 'starting' }>> {
  // A page playing alone only looks: a place held for 5 s by each page asking every 30 s keeps real players out.
  const path = options.peek ? 'join?peek=1' : 'join';
  for (;;) {
    const response = await fetch(new URL(path, withSlash(router)), { signal, cache: 'no-store' }),
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

/** What the page says when it will not send an edit the shard refuses: the square cannot be built on. */
export const PROTECTED_MESSAGE = 'The square is protected. Build outside it.';
/** What the page says when the server did not keep an edit and the page could not tell why. */
export const REFUSED_MESSAGE = 'That change did not go through. Move closer or try again.';
/** The least time between two such messages, milliseconds. */
export const NOTICE_EVERY = 4000;

/**
 * Notices of edits the server did not keep. The page applies an edit at once and the server answers only by putting the
 * cell back, so an edit is checked `delay` milliseconds after it was made: a cell that is not as the page set it was
 * refused (too far, too fast, someone standing there, a frozen area after a report, the world ending) or changed by
 * another player at that moment.
 */
export class EditWatch {
  readonly #delay: number;
  readonly #pending = new Map<string, { x: number; y: number; z: number; state: number; at: number }>();
  /** @param delay Milliseconds to wait for the server's answer; must cover the round trip and a tick. */
  constructor(delay = 1200) {
    this.#delay = delay;
  }
  /** Notes an edit made at `now` (milliseconds); a later edit of the same cell replaces it. */
  add(x: number, y: number, z: number, state: number, now: number): void {
    this.#pending.set(`${x},${y},${z}`, { x, y, z, state, at: now });
  }
  /**
   * Checks the edits at least `delay` old at `now` and forgets them. `read` gives a cell's state, or undefined when its
   * chunk is not loaded (that edit is dropped, not counted). Returns how many did not stay.
   */
  settle(now: number, read: (x: number, y: number, z: number) => number | undefined): number {
    let refused = 0;
    for (const [key, e] of this.#pending) {
      if (now - e.at < this.#delay) continue;
      this.#pending.delete(key);
      const state = read(e.x, e.y, e.z);
      if (state !== undefined && state !== e.state) refused++;
    }
    return refused;
  }
  /** Forgets every edit (the connection ended). */
  clear(): void {
    this.#pending.clear();
  }
}

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
