// Ready-made chat and inventory messages on the app channel (design: packages/voxel-net/DESIGN.md, "Chat and
// inventory"). Every message starts with CHAT_PREFIX, then one byte of kind and its fields as LEB128 varints and
// UTF-8 text, so it sits beside the game's own app messages and the shard handoffs. The server owns the inventories:
// a client only asks to move items between its own slots, and the server checks every move.
import { ByteReader, ByteWriter } from '../../shared/bytes.js';
import type { VoxelNetClient } from './client.js';
import type { VoxelServer, VoxelServerPlayer } from './server.js';

/** First bytes of every chat or inventory app message: `MCH` and format 1. */
export const CHAT_PREFIX: Uint8Array = Uint8Array.of(0x4d, 0x43, 0x48, 1);

/** Most UTF-8 bytes of one chat line, on the wire and after {@link cleanChatText}. */
export const MAX_CHAT_BYTES = 256;

/** Most slots of one inventory. */
export const MAX_INVENTORY_SLOTS = 1024;

/** A stack of `count` of item `item` (your own item ids, 1 or more; a block state works). */
export interface ItemStack {
  readonly item: number;
  readonly count: number;
}

/** A chat line as players get it. */
export interface ChatLine {
  /** Id of the player who said it. */
  readonly from: number;
  /** Their display name. */
  readonly name: string;
  /** What they said, cleaned. */
  readonly text: string;
  /** True when it was said to this player alone. */
  readonly whisper: boolean;
}

/** One message of this entry. `say` and `move` go from a client to the server, the rest from the server. */
export type ChatMessage =
  /** Say `text` to everyone in range, or to player `to` alone. */
  | { type: 'say'; text: string; to?: number }
  /** A line someone said. */
  | ({ type: 'chat' } & ChatLine)
  /** A line from the server itself. */
  | { type: 'system'; text: string }
  /** The whole inventory, `undefined` for an empty slot. */
  | { type: 'inventory'; slots: (ItemStack | undefined)[] }
  /** One slot changed. */
  | { type: 'slot'; index: number; stack: ItemStack | undefined }
  /** Move `count` items (0 for the whole stack) from slot `from` to slot `to`. */
  | { type: 'move'; from: number; to: number; count: number };

const SAY = 1,
  CHAT = 2,
  SYSTEM = 3,
  INVENTORY = 4,
  SLOT = 5,
  MOVE = 6,
  encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', { fatal: true }),
  // Characters a line never shows: controls and format marks (bidi overrides, zero widths), lone surrogates, private
  // use and unassigned code points.
  UNSHOWN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu;

/**
 * `text` as safe to show other players: NFC, without controls, bidi overrides or zero widths, at most 2 combining marks
 * in a row, its whitespace collapsed and trimmed, cut on a character boundary to {@link MAX_CHAT_BYTES} bytes. Anything
 * but a string gives `''`. Still show the result as text (`textContent`), never as HTML.
 */
export function cleanChatText(text: unknown): string {
  if (typeof text !== 'string') return '';
  const clean = text
    .normalize('NFC')
    .replace(/[\p{Z}\t\n\v\f\r\u0085]+/gu, ' ')
    .replace(UNSHOWN, '')
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (encoder.encode(clean).length <= MAX_CHAT_BYTES) return clean;
  let cut = '',
    bytes = 0;
  for (const c of clean) {
    bytes += encoder.encode(c).length;
    if (bytes > MAX_CHAT_BYTES) break;
    cut += c;
  }
  return cut.trimEnd();
}

const integer = (what: string, v: unknown, min: number, max: number): number => {
  if (typeof v !== 'number') throw new TypeError(`${what} must be a number`);
  if (!Number.isInteger(v) || v < min || v > max)
    throw new RangeError(`${what} ${v} is not an integer in ${min}..${max}; pass a whole number in that range`);
  return v;
};
const textBytes = (what: string, v: unknown): Uint8Array => {
  if (typeof v !== 'string') throw new TypeError(`${what} must be a string`);
  const bytes = encoder.encode(v);
  if (bytes.length > MAX_CHAT_BYTES)
    throw new RangeError(`${what} is ${bytes.length} bytes; send at most ${MAX_CHAT_BYTES} (cleanChatText cuts it)`);
  return bytes;
};
function writeText(w: ByteWriter, what: string, v: unknown): void {
  const bytes = textBytes(what, v);
  w.varint(bytes.length);
  w.raw(bytes);
}
function writeStack(w: ByteWriter, what: string, stack: ItemStack | undefined): void {
  if (stack === undefined) return void w.varint(0);
  if (!stack || typeof stack !== 'object') throw new TypeError(`${what} must be { item, count } or undefined`);
  w.varint(integer(`${what} item`, stack.item, 1, 2 ** 32 - 1));
  w.varint(integer(`${what} count`, stack.count, 1, 2 ** 32 - 1));
}

class Reader extends ByteReader {
  constructor(bytes: Uint8Array) {
    super(bytes, 'chat message', 'send what encodeChatMessage returned', CHAT_PREFIX.length + 1);
  }
  text(): string {
    const n = this.varint();
    if (n > MAX_CHAT_BYTES) throw this.fail(`has a text of ${n} bytes, over ${MAX_CHAT_BYTES}`);
    this.need(n);
    try {
      return decoder.decode(this.bytes.subarray(this.at, (this.at += n)));
    } catch {
      throw this.fail('has a text that is not UTF-8');
    }
  }
  stack(): ItemStack | undefined {
    const item = this.varint();
    if (!item) return undefined;
    const count = this.varint();
    if (!count) throw this.fail(`has a stack of item ${item} with no items`);
    return { item, count };
  }
}

/**
 * The app message bytes of `message`, for `VoxelServer.send` or `VoxelNetClient.sendApp`.
 * @throws TypeError for an unknown type or a field of the wrong type; RangeError for a field out of range or a text
 * over {@link MAX_CHAT_BYTES}.
 */
export function encodeChatMessage(message: ChatMessage): Uint8Array {
  const w = new ByteWriter();
  w.raw(CHAT_PREFIX);
  switch (message?.type) {
    case 'say':
      w.u8(SAY);
      w.varint(message.to === undefined ? 0 : integer('say to', message.to, 0, 2 ** 32 - 2) + 1);
      writeText(w, 'say text', message.text);
      break;
    case 'chat':
      w.u8(CHAT);
      w.varint(integer('chat from', message.from, 0, 2 ** 32 - 1));
      writeText(w, 'chat name', message.name);
      w.u8(message.whisper ? 1 : 0);
      writeText(w, 'chat text', message.text);
      break;
    case 'system':
      w.u8(SYSTEM);
      writeText(w, 'system text', message.text);
      break;
    case 'inventory': {
      const slots = message.slots;
      if (!Array.isArray(slots)) throw new TypeError('inventory slots must be an array of ItemStack or undefined');
      if (slots.length > MAX_INVENTORY_SLOTS)
        throw new RangeError(`inventory has ${slots.length} slots; send at most ${MAX_INVENTORY_SLOTS}`);
      w.u8(INVENTORY);
      w.varint(slots.length);
      for (const stack of slots) writeStack(w, 'inventory slot', stack);
      break;
    }
    case 'slot':
      w.u8(SLOT);
      w.varint(integer('slot index', message.index, 0, MAX_INVENTORY_SLOTS - 1));
      writeStack(w, 'slot', message.stack);
      break;
    case 'move':
      w.u8(MOVE);
      w.varint(integer('move from', message.from, 0, MAX_INVENTORY_SLOTS - 1));
      w.varint(integer('move to', message.to, 0, MAX_INVENTORY_SLOTS - 1));
      w.varint(integer('move count', message.count, 0, 2 ** 32 - 1));
      break;
    default:
      throw new TypeError(
        `Unknown chat message type ${String((message as { type?: unknown })?.type)}; use one of the ChatMessage types`,
      );
  }
  return w.done();
}

/** True when app message `data` starts with {@link CHAT_PREFIX}. */
export function isChatMessage(data: Uint8Array): boolean {
  if (!(data instanceof Uint8Array) || data.length <= CHAT_PREFIX.length) return false;
  for (let i = 0; i < CHAT_PREFIX.length; i++) if (data[i] !== CHAT_PREFIX[i]) return false;
  return true;
}

/**
 * The {@link ChatMessage} in app message `data`, or undefined when `data` is not one of this entry's (another app
 * message of yours, a shard handoff).
 * @throws RangeError for bytes that start with {@link CHAT_PREFIX} but are cut short, carry trailing bytes, an unknown
 * kind or a field out of range.
 */
export function decodeChatMessage(data: Uint8Array): ChatMessage | undefined {
  if (!isChatMessage(data)) return undefined;
  const r = new Reader(data),
    kind = data[CHAT_PREFIX.length];
  let message: ChatMessage;
  if (kind === SAY) {
    const to = r.varint();
    message = to ? { type: 'say', to: to - 1, text: r.text() } : { type: 'say', text: r.text() };
  } else if (kind === CHAT) {
    const from = r.varint(),
      name = r.text(),
      whisper = r.u8();
    if (whisper > 1) throw r.fail(`has whisper flag ${whisper}, not 0 or 1`);
    message = { type: 'chat', from, name, whisper: whisper === 1, text: r.text() };
  } else if (kind === SYSTEM) message = { type: 'system', text: r.text() };
  else if (kind === INVENTORY) {
    const n = r.varint();
    if (n > MAX_INVENTORY_SLOTS) throw r.fail(`has ${n} slots, over ${MAX_INVENTORY_SLOTS}`);
    const slots: (ItemStack | undefined)[] = [];
    for (let i = 0; i < n; i++) slots.push(r.stack());
    message = { type: 'inventory', slots };
  } else if (kind === SLOT) {
    const index = r.varint();
    if (index >= MAX_INVENTORY_SLOTS) throw r.fail(`names slot ${index}, over ${MAX_INVENTORY_SLOTS - 1}`);
    message = { type: 'slot', index, stack: r.stack() };
  } else if (kind === MOVE) {
    const from = r.varint(),
      to = r.varint();
    if (from >= MAX_INVENTORY_SLOTS || to >= MAX_INVENTORY_SLOTS) throw r.fail(`moves slot ${from} to ${to}`);
    message = { type: 'move', from, to, count: r.varint() };
  } else throw r.fail(`has unknown kind ${kind}`);
  r.end();
  return message;
}

// A hostile client's unreadable bytes: closed as the server closes unreadable messages, with a code of our own.
function readFrom(server: VoxelServer, player: VoxelServerPlayer, data: Uint8Array): ChatMessage | undefined {
  try {
    return decodeChatMessage(data);
  } catch {
    server.disconnect(player, 4002, 'unreadable-chat');
    return undefined;
  }
}

/** Options of {@link VoxelChat}. */
export interface VoxelChatOptions {
  /** Blocks from the speaker within which players hear a line. Default Infinity: everyone. Whispers reach anywhere. */
  distance?: number;
  /** Lines per second a player may say on average; one over it is dropped. Default 1. */
  rate?: number;
  /** Lines a player may say at once. Default 5. */
  burst?: number;
  /** Whether players may whisper to one player. Default true. */
  whispers?: boolean;
  /**
   * Your filter, after {@link cleanChatText}: return the text to send (changed or not), or undefined to drop the line.
   * Default keeps every line.
   */
  filter?: (text: string, player: VoxelServerPlayer) => string | undefined;
}

/** Counts of {@link VoxelChat}. */
export interface VoxelChatStats {
  /** Lines said and delivered to at least one player. */
  said: number;
  /** Lines dropped: over the rate, empty, filtered out, or a whisper to nobody. */
  dropped: number;
}

/**
 * Server chat: players' `say` messages go out as `chat` lines to everyone within `distance`, or as whispers; lines
 * are cleaned, rate-limited and passed through your filter first. Runs on `server.onApp`, beside your own app
 * messages. Dispose to stop.
 */
export class VoxelChat implements Disposable {
  /** Counts since the start. */
  readonly stats: VoxelChatStats = { said: 0, dropped: 0 };
  /** Called with each line delivered, after filtering (to log it). */
  onLine: (player: VoxelServerPlayer, text: string, to: VoxelServerPlayer | undefined) => void = () => {};
  readonly #server: VoxelServer;
  readonly #distance: number;
  readonly #rate: number;
  readonly #burst: number;
  readonly #whispers: boolean;
  readonly #filter: VoxelChatOptions['filter'];
  readonly #tokens = new WeakMap<VoxelServerPlayer, { tokens: number; at: number }>();
  readonly #stop: () => void;
  constructor(server: VoxelServer, options: VoxelChatOptions = {}) {
    if (!server || typeof server.onApp !== 'function')
      throw new TypeError('VoxelChat needs a VoxelServer; pass new VoxelServer({...})');
    const positive = (what: string, v: number): number => {
      if (!(v > 0)) throw new RangeError(`VoxelChat ${what} is ${v}; pass a number above 0`);
      return v;
    };
    this.#server = server;
    this.#distance = positive('distance', options.distance ?? Number.POSITIVE_INFINITY);
    this.#rate = positive('rate', options.rate ?? 1);
    this.#burst = positive('burst', options.burst ?? 5);
    this.#whispers = options.whispers ?? true;
    if (options.filter !== undefined && typeof options.filter !== 'function')
      throw new TypeError('VoxelChat filter must be a function (text, player) => string | undefined');
    this.#filter = options.filter;
    this.#stop = server.onApp((player, data) => {
      const m = readFrom(server, player, data);
      if (m?.type === 'say') this.#say(player, m.text, m.to);
    });
  }
  #say(player: VoxelServerPlayer, said: string, to: number | undefined): void {
    const now = performance.now(),
      bucket = this.#tokens.get(player) ?? { tokens: this.#burst, at: now };
    bucket.tokens = Math.min(this.#burst, bucket.tokens + ((now - bucket.at) / 1000) * this.#rate);
    bucket.at = now;
    this.#tokens.set(player, bucket);
    if (bucket.tokens < 1) return void this.stats.dropped++;
    bucket.tokens--;
    let text: string | undefined = cleanChatText(said);
    if (text && this.#filter) text = cleanChatText(this.#filter(text, player) ?? '');
    const target = to === undefined ? undefined : this.#server.players.find((p) => p.id === to && p.spawned);
    if (!text || (to !== undefined && (!this.#whispers || !target))) return void this.stats.dropped++;
    const line = { from: player.id, name: player.name, text },
      whisper = encodeChatMessage({ type: 'chat', ...line, whisper: true });
    let reached = 0;
    if (target) {
      if (this.#server.send(target, whisper)) reached++;
      if (target !== player) this.#server.send(player, whisper);
    } else {
      const bytes = encodeChatMessage({ type: 'chat', ...line, whisper: false }),
        p = player.character.position,
        d2 = this.#distance ** 2;
      for (const other of this.#server.players) {
        if (!other.spawned) continue;
        const q = other.character.position;
        if ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2 > d2) continue;
        if (this.#server.send(other, bytes)) reached++;
      }
    }
    if (!reached) return void this.stats.dropped++;
    this.stats.said++;
    this.onLine(player, text, target);
  }
  /**
   * Sends a `system` line from the server to one player, or to every player that has joined. Returns how many it was
   * queued for.
   * @throws RangeError for a text over {@link MAX_CHAT_BYTES} bytes.
   */
  system(text: string, to?: VoxelServerPlayer): number {
    const bytes = encodeChatMessage({ type: 'system', text });
    return to ? (this.#server.send(to, bytes) ? 1 : 0) : this.#server.broadcast(bytes);
  }
  /** Stops listening. */
  [Symbol.dispose](): void {
    this.#stop();
  }
}

/** Options of {@link VoxelInventories}. */
export interface VoxelInventoryOptions {
  /** Slots per player. Default 36. */
  size?: number;
  /** Most items in one slot. Default 64. */
  stackLimit?: number;
  /**
   * Your rule for a player's move request, after the server checked it is possible; return false to refuse it.
   * Default allows every move.
   */
  canMove?: (player: VoxelServerPlayer, from: number, to: number, count: number) => boolean;
}

type Slots = (ItemStack | undefined)[];

/**
 * Server-owned inventories, one per player: the server gives and takes items, and each player's client gets its whole
 * inventory when it spawns and each changed slot after. A client may only ask to move items between its own slots
 * (split, merge or swap); a move that is not possible or that `canMove` refuses is answered with the two slots as they
 * are. Runs on `server.onApp` and `server.onTick`. Saving is yours: read {@link VoxelInventories.slots} and
 * {@link VoxelInventories.load} them back. Dispose to stop.
 */
export class VoxelInventories implements Disposable {
  /** Slots per player. */
  readonly size: number;
  /** Most items in one slot. */
  readonly stackLimit: number;
  readonly #server: VoxelServer;
  readonly #canMove: VoxelInventoryOptions['canMove'];
  readonly #slots = new WeakMap<VoxelServerPlayer, Slots>();
  readonly #sent = new WeakSet<VoxelServerPlayer>();
  readonly #stops: (() => void)[];
  constructor(server: VoxelServer, options: VoxelInventoryOptions = {}) {
    if (!server || typeof server.onApp !== 'function')
      throw new TypeError('VoxelInventories needs a VoxelServer; pass new VoxelServer({...})');
    this.size = integer('VoxelInventories size', options.size ?? 36, 1, MAX_INVENTORY_SLOTS);
    this.stackLimit = integer('VoxelInventories stackLimit', options.stackLimit ?? 64, 1, 2 ** 32 - 1);
    if (options.canMove !== undefined && typeof options.canMove !== 'function')
      throw new TypeError('VoxelInventories canMove must be a function (player, from, to, count) => boolean');
    this.#server = server;
    this.#canMove = options.canMove;
    this.#stops = [
      server.onApp((player, data) => {
        const m = readFrom(server, player, data);
        if (m?.type === 'move') this.#move(player, m.from, m.to, m.count);
      }),
      server.onTick(() => {
        for (const player of server.players)
          if (player.spawned && !this.#sent.has(player) && server.send(player, this.#full(player)))
            this.#sent.add(player);
      }),
    ];
  }
  #of(player: VoxelServerPlayer): Slots {
    let slots = this.#slots.get(player);
    if (!slots) this.#slots.set(player, (slots = new Array(this.size).fill(undefined)));
    return slots;
  }
  #full(player: VoxelServerPlayer): Uint8Array {
    return encodeChatMessage({ type: 'inventory', slots: this.#of(player) });
  }
  #index(index: number): number {
    return integer('VoxelInventories slot', index, 0, this.size - 1);
  }
  #changed(player: VoxelServerPlayer, index: number): void {
    if (this.#sent.has(player))
      this.#server.send(player, encodeChatMessage({ type: 'slot', index, stack: this.#of(player)[index] }));
  }
  /** A copy of `player`'s slots, `undefined` for an empty one. */
  slots(player: VoxelServerPlayer): (ItemStack | undefined)[] {
    return this.#of(player).map((s) => s && { ...s });
  }
  /**
   * Replaces `player`'s slots (a saved inventory) and sends them all; missing slots are empty.
   * @throws RangeError for more slots than `size`, or a stack over `stackLimit`.
   */
  load(player: VoxelServerPlayer, slots: readonly (ItemStack | undefined)[]): void {
    if (!Array.isArray(slots)) throw new TypeError('VoxelInventories load needs an array of ItemStack or undefined');
    if (slots.length > this.size)
      throw new RangeError(`VoxelInventories load got ${slots.length} slots; pass at most size (${this.size})`);
    const next: Slots = new Array(this.size).fill(undefined);
    slots.forEach((s, i) => {
      next[i] = s && this.#stack(s);
    });
    this.#slots.set(player, next);
    if (this.#sent.has(player)) this.#server.send(player, this.#full(player));
  }
  #stack(s: ItemStack): ItemStack {
    return {
      item: integer('VoxelInventories item', s.item, 1, 2 ** 32 - 1),
      count: integer('VoxelInventories count', s.count, 1, this.stackLimit),
    };
  }
  /**
   * Puts `stack` (or nothing, for undefined) in slot `index` of `player`'s inventory and sends the slot.
   * @throws RangeError for a slot out of range or a count over `stackLimit`.
   */
  set(player: VoxelServerPlayer, index: number, stack: ItemStack | undefined): void {
    this.#of(player)[this.#index(index)] = stack && this.#stack(stack);
    this.#changed(player, index);
  }
  /** How many of `item` `player` holds in all. */
  count(player: VoxelServerPlayer, item: number): number {
    let n = 0;
    for (const s of this.#of(player)) if (s?.item === item) n += s.count;
    return n;
  }
  /**
   * Gives `player` `count` of `item`: onto stacks of it first, then into empty slots. Returns how many did not fit.
   * @throws RangeError for an item id below 1 or a count that is not a whole number of 0 or more.
   */
  give(player: VoxelServerPlayer, item: number, count: number): number {
    integer('VoxelInventories item', item, 1, 2 ** 32 - 1);
    let left = integer('VoxelInventories give count', count, 0, Number.MAX_SAFE_INTEGER);
    const slots = this.#of(player);
    for (const pass of [true, false])
      for (let i = 0; i < slots.length && left; i++) {
        const s = slots[i];
        if (pass ? s?.item !== item : s !== undefined) continue;
        const room = this.stackLimit - (s?.count ?? 0),
          put = Math.min(room, left);
        if (!put) continue;
        slots[i] = { item, count: (s?.count ?? 0) + put };
        left -= put;
        this.#changed(player, i);
      }
    return left;
  }
  /**
   * Takes `count` of `item` from `player`, last slots first, when it holds that many; otherwise takes nothing. Returns
   * whether it took them.
   */
  take(player: VoxelServerPlayer, item: number, count: number): boolean {
    let left = integer('VoxelInventories take count', count, 0, Number.MAX_SAFE_INTEGER);
    if (this.count(player, item) < left) return false;
    const slots = this.#of(player);
    for (let i = slots.length - 1; i >= 0 && left; i--) {
      const s = slots[i];
      if (s?.item !== item) continue;
      const cut = Math.min(s.count, left);
      slots[i] = s.count > cut ? { item, count: s.count - cut } : undefined;
      left -= cut;
      this.#changed(player, i);
    }
    return true;
  }
  #move(player: VoxelServerPlayer, from: number, to: number, count: number): void {
    const slots = this.#of(player),
      a = slots[from],
      b = slots[to];
    const whole = count === 0 || count >= (a?.count ?? 0),
      n = whole ? (a?.count ?? 0) : count,
      possible = from < this.size && to < this.size && from !== to && a !== undefined;
    if (possible && (!this.#canMove || this.#canMove(player, from, to, n) === true)) {
      if (!b) {
        slots[to] = { item: a.item, count: n };
        slots[from] = whole ? undefined : { item: a.item, count: a.count - n };
      } else if (b.item === a.item) {
        const put = Math.min(n, this.stackLimit - b.count);
        slots[to] = { item: a.item, count: b.count + put };
        slots[from] = a.count > put ? { item: a.item, count: a.count - put } : undefined;
      } else if (whole) {
        slots[to] = a;
        slots[from] = b;
      }
    }
    // Answered whether it moved or not, so a client that guessed shows the truth.
    if (from < this.size) this.#changed(player, from);
    if (to < this.size && to !== from) this.#changed(player, to);
  }
  /** Stops listening. */
  [Symbol.dispose](): void {
    for (const stop of this.#stops) stop();
  }
}

/**
 * The client end of {@link VoxelChat} and {@link VoxelInventories}: it takes chat and inventory messages out of
 * `client.onApp` and passes every other app message on to the handler that was there before (set your own `onApp`
 * first, or set {@link VoxelChatClient.onApp}). Dispose to put the old handler back.
 */
export class VoxelChatClient implements Disposable {
  /** The connection. */
  readonly client: VoxelNetClient;
  /** This player's inventory as the server last sent it; empty until it spawns. */
  readonly inventory: (ItemStack | undefined)[] = [];
  /** Called with each line someone said. */
  onChat: (line: ChatLine) => void = () => {};
  /** Called with each line from the server. */
  onSystem: (text: string) => void = () => {};
  /** Called after the inventory changed: `index` is the slot, or undefined when it all came. */
  onInventory: (inventory: readonly (ItemStack | undefined)[], index: number | undefined) => void = () => {};
  /** Your other app messages. Default: the `client.onApp` that was set before this. */
  onApp: (data: Uint8Array) => void;
  readonly #previous: (data: Uint8Array) => void;
  readonly #handler: (data: Uint8Array) => void;
  constructor(client: VoxelNetClient) {
    if (!client || typeof client.sendApp !== 'function')
      throw new TypeError('VoxelChatClient needs a VoxelNetClient; pass connectVoxelNet(...)');
    this.client = client;
    this.#previous = this.onApp = client.onApp;
    this.#handler = client.onApp = (data) => {
      const m = decodeChatMessage(data);
      if (!m) return this.onApp(data);
      if (m.type === 'chat') this.onChat({ from: m.from, name: m.name, text: m.text, whisper: m.whisper });
      else if (m.type === 'system') this.onSystem(m.text);
      else if (m.type === 'inventory') {
        this.inventory.length = 0;
        this.inventory.push(...m.slots);
        this.onInventory(this.inventory, undefined);
      } else if (m.type === 'slot') {
        while (this.inventory.length <= m.index) this.inventory.push(undefined);
        this.inventory[m.index] = m.stack;
        this.onInventory(this.inventory, m.index);
      }
    };
  }
  /**
   * Says `text` (cleaned, at most {@link MAX_CHAT_BYTES} bytes) to everyone in range, or to player id `to` alone.
   * Returns false when nothing was sent: an empty line, or a client that cannot send (see `VoxelNetClient.sendApp`).
   */
  say(text: string, to?: number): boolean {
    const clean = cleanChatText(text);
    return clean !== '' && this.client.sendApp(encodeChatMessage({ type: 'say', text: clean, to }));
  }
  /**
   * Asks the server to move `count` items (default 0: the whole stack) from slot `from` to slot `to`: onto an empty
   * slot, onto the same item, or swapped with another whole stack. The server answers with both slots.
   */
  move(from: number, to: number, count = 0): boolean {
    return this.client.sendApp(encodeChatMessage({ type: 'move', from, to, count }));
  }
  /** Puts back the `client.onApp` that was there before, if nothing replaced this one's since. */
  [Symbol.dispose](): void {
    if (this.client.onApp === this.#handler) this.client.onApp = this.#previous;
  }
}
