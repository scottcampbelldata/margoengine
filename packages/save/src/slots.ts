// Save slots over any storage: a named slot holds a save, a small record of what it is (title, time, play time, your
// metadata) and a thumbnail, so a load screen lists slots without reading one save. Autosaves take turns in a ring of
// their own and never touch a player's slot. A slot's files carry a generation in their keys, and writing its record
// is the one step that switches to them: a crash before it leaves the old slot whole with some unused files, which the
// next save clears, and that holds on every adapter whose single write is atomic (see storage.ts).
import { MargoError } from '@margoengine/math/errors';
import type { Json, SaveDocument } from './document.js';
import { type LoadOptions, type SaveGameOptions, loadGame, saveGame } from './load.js';
import type { SaveStorage, StorageCallOptions } from './storage.js';

/** A thumbnail: image bytes, or a Blob from `canvas.toBlob`. See {@link captureThumbnail}. */
export type Thumbnail = Uint8Array | Blob;

/** What a load screen shows for one slot. */
export interface SlotInfo {
  /** The slot's name; autosaves are `auto-0`, `auto-1` and so on. */
  id: string;
  /** Default the document's `meta.title`. */
  title?: string;
  /** When it was saved, in milliseconds since 1970. */
  savedAt: number;
  /** Seconds played. Default the document's `meta.playTime`. */
  playTime?: number;
  /** True for a slot in the autosave ring. */
  autosave: boolean;
  /** The save's schema version. */
  version: number;
  /** Size of the stored save in bytes. */
  bytes: number;
  /** The thumbnail's media type, when the slot has one. */
  thumbnail?: string;
  /** Your own fields for the load screen: the level, the character. */
  meta: Record<string, Json>;
  /** True when the slot's record cannot be read; only `id` is known, and it can be deleted. */
  damaged?: boolean;
}

/** Options of {@link SaveSlots}. */
export interface SaveSlotsOptions extends Pick<SaveGameOptions, 'compress' | 'validate'> {
  /** Kept apart from other slots in the same storage, for profiles. Default `'slot'`. */
  namespace?: string;
  /** How many autosaves take turns. Default 3. */
  autosaves?: number;
  /** The time in milliseconds. Default `Date.now`. */
  now?: () => number;
}

/** Options of {@link SaveSlots.save} and {@link SaveSlots.autosave}. */
export interface SlotSaveOptions extends StorageCallOptions {
  /** Default the document's `meta.title`. */
  title?: string;
  /** Seconds played. Default the document's `meta.playTime`. */
  playTime?: number;
  /** Your own fields for the load screen. */
  meta?: Record<string, Json>;
  /** Shown on the load screen. Default none. */
  thumbnail?: Thumbnail;
}

/** Options of {@link SaveSlots.autosaveEvery}. */
export interface AutosaveTimerOptions extends Omit<SlotSaveOptions, 'thumbnail'> {
  /** Called with each failed autosave; the timer goes on. Default none, and the failure is dropped. */
  onError?(error: unknown): void;
}

/** A running autosave timer. */
export interface AutosaveTimer {
  /** Stops it; an autosave under way finishes. */
  stop(): void;
  [Symbol.dispose](): void;
}

/** The record is there and unreadable, which a save may replace; a read that failed says nothing about the slot. */
class DamagedRecord extends TypeError {}

const AUTO = 'auto-';
const RECORD = 'margo-slot';

/** The stored record: the info and the generation of the files it switches to. */
type SlotRecord = Omit<SlotInfo, 'id' | 'damaged'> & { format: typeof RECORD; generation: number };

const sniff = (bytes: Uint8Array): string => {
  const head = (at: number, text: string): boolean => [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0));
  if (head(1, 'PNG')) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (head(0, 'RIFF') && head(8, 'WEBP')) return 'image/webp';
  return 'application/octet-stream';
};

/**
 * Slots over a {@link SaveStorage}. Writes run one at a time, in call order.
 * @example
 * const slots = new SaveSlots(indexedDBStorage());
 * await slots.save('slot-1', document, { title: 'Chapter 2' });
 * for (const slot of await slots.list()) console.log(slot.title, new Date(slot.savedAt));
 */
export class SaveSlots {
  readonly #storage: SaveStorage;
  readonly #namespace: string;
  readonly #autosaves: number;
  readonly #now: () => number;
  readonly #options: Pick<SaveGameOptions, 'compress' | 'validate'>;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(storage: SaveStorage, options: SaveSlotsOptions = {}) {
    if (typeof storage?.read !== 'function') throw new TypeError('SaveSlots needs a storage, e.g. memoryStorage()');
    const { namespace = 'slot', autosaves = 3, now = Date.now, compress, validate } = options;
    if (typeof namespace !== 'string' || !namespace || namespace.includes(':'))
      throw new TypeError("namespace must be a non-empty string with no ':', e.g. 'profile-1'");
    if (!Number.isInteger(autosaves) || autosaves < 1) throw new RangeError('autosaves must be a whole number of 1 or more');
    this.#storage = storage;
    this.#namespace = namespace;
    this.#autosaves = autosaves;
    this.#now = now;
    this.#options = { compress, validate };
  }

  #turn<T>(job: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(job, job);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #info(id: string): string {
    return `${this.#namespace}:${encodeURIComponent(id)}.info`;
  }
  #data(id: string, generation: number): string {
    return `${this.#namespace}:${encodeURIComponent(id)}:${generation}.data`;
  }
  #image(id: string, generation: number): string {
    return `${this.#namespace}:${encodeURIComponent(id)}:${generation}.image`;
  }

  async #record(id: string, options?: StorageCallOptions): Promise<SlotRecord | null> {
    const bytes = await this.#storage.read(this.#info(id), options);
    if (bytes === null) return null;
    let record: SlotRecord;
    try {
      record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error) {
      throw Object.assign(new DamagedRecord(`Slot '${id}' has a damaged record; delete the slot`), { cause: error });
    }
    if (record?.format !== RECORD || !Number.isInteger(record.generation))
      throw new DamagedRecord(`Slot '${id}' has a damaged record; delete the slot`);
    return record;
  }

  /** The generation after the slot's own; a damaged record starts again. */
  async #next(id: string, options?: StorageCallOptions): Promise<number> {
    try {
      return ((await this.#record(id, options))?.generation ?? 0) + 1;
    } catch (error) {
      if (error instanceof DamagedRecord) return 1;
      throw error;
    }
  }

  /** Every file of `id` the record does not name goes: what a crash between two writes left behind. */
  async #clear(id: string, keep: readonly string[], options?: StorageCallOptions): Promise<void> {
    const start = `${this.#namespace}:${encodeURIComponent(id)}:`;
    for (const key of await this.#storage.keys(options))
      if (key.startsWith(start) && !keep.includes(key)) await this.#storage.delete(key, options);
  }

  async #write(id: string, document: SaveDocument, options: SlotSaveOptions, autosave: boolean): Promise<SlotInfo> {
    const { title, playTime, meta = {}, thumbnail, signal } = options,
      call = { signal },
      generation = await this.#next(id, call),
      data = this.#data(id, generation),
      image = this.#image(id, generation);
    await saveGame(this.#storage, data, document, { ...this.#options, signal });
    const stored = await this.#storage.read(data, call);
    if (stored === null) throw new MargoError('failed', `Slot '${id}': the storage kept nothing, so the old slot stands; check the storage and save again`);
    const record: SlotRecord = {
      format: RECORD,
      generation,
      savedAt: this.#now(),
      autosave,
      version: document.version,
      bytes: stored.length,
      meta,
    };
    const named = title ?? document.meta?.title,
      played = playTime ?? document.meta?.playTime;
    if (typeof named === 'string') record.title = named;
    if (typeof played === 'number') record.playTime = played;
    if (thumbnail !== undefined) {
      const bytes = thumbnail instanceof Uint8Array ? thumbnail : new Uint8Array(await thumbnail.arrayBuffer());
      record.thumbnail = (thumbnail as Blob).type || sniff(bytes);
      await this.#storage.write(image, bytes, call);
    }
    // The switch: before this line the old slot is whole, after it the new one is.
    await this.#storage.write(this.#info(id), new TextEncoder().encode(JSON.stringify(record)), call);
    await this.#clear(id, thumbnail === undefined ? [data] : [data, image], call);
    return toInfo(id, record);
  }

  /**
   * Saves to the slot `id`, replacing what it holds in one step: a failure keeps the old save.
   * Rejects with a TypeError for an invalid document or an id starting `auto-`, which the autosaves own.
   */
  async save(id: string, document: SaveDocument, options: SlotSaveOptions = {}): Promise<SlotInfo> {
    checkId(id);
    if (id.startsWith(AUTO)) throw new TypeError(`Slot id '${id}': 'auto-' names belong to autosave(); use another id`);
    return this.#turn(() => this.#write(id, document, options, false));
  }

  /** Saves over the oldest autosave, or an unused one, so the last few are always there. Other slots are not touched. */
  autosave(document: SaveDocument, options: SlotSaveOptions = {}): Promise<SlotInfo> {
    return this.#turn(async () => {
      const taken = new Map<string, number>();
      for (const slot of await this.#read(options)) if (slot.autosave) taken.set(slot.id, slot.savedAt);
      let id = '',
        oldest = Infinity;
      for (let i = 0; i < this.#autosaves; i++) {
        const name = `${AUTO}${i}`,
          at = taken.get(name) ?? -Infinity;
        if (at < oldest) {
          id = name;
          oldest = at;
        }
      }
      return this.#write(id, document, options, true);
    });
  }

  /**
   * Autosaves every `milliseconds` with what `capture` returns, until stopped. An autosave that is still running when
   * the next is due makes that one wait; a `capture` returning null skips a turn, for a menu or a cutscene.
   */
  autosaveEvery(
    milliseconds: number,
    capture: () => SaveDocument | null | Promise<SaveDocument | null>,
    options: AutosaveTimerOptions = {},
  ): AutosaveTimer {
    if (!(milliseconds > 0)) throw new RangeError('autosaveEvery: milliseconds must be above 0');
    if (typeof capture !== 'function') throw new TypeError('autosaveEvery: capture must return a document, e.g. () => captureScene(engine)');
    const { onError, signal, ...how } = options;
    let timer: ReturnType<typeof setTimeout> | undefined,
      stopped = false;
    const stop = (): void => {
      stopped = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    };
    const tick = async (): Promise<void> => {
      try {
        const document = await capture();
        if (document && !stopped) await this.autosave(document, { ...how, signal });
      } catch (error) {
        if (!stopped) onError?.(error);
      }
      if (!stopped) timer = setTimeout(tick, milliseconds);
    };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    else timer = setTimeout(tick, milliseconds);
    return { stop, [Symbol.dispose]: stop };
  }

  async #read(options?: StorageCallOptions): Promise<SlotInfo[]> {
    const start = `${this.#namespace}:`,
      out: SlotInfo[] = [];
    for (const key of await this.#storage.keys(options)) {
      if (!key.startsWith(start) || !key.endsWith('.info')) continue;
      const id = slotId(key.slice(start.length, -'.info'.length));
      if (id === null) continue;
      try {
        const record = await this.#record(id, options);
        if (record) out.push(toInfo(id, record));
      } catch (error) {
        if (!(error instanceof DamagedRecord)) throw error;
        out.push({ id, savedAt: 0, autosave: id.startsWith(AUTO), version: 0, bytes: 0, meta: {}, damaged: true });
      }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt || (a.id < b.id ? -1 : 1));
  }

  /** Every slot, newest first, read from the records alone. A slot whose record is damaged is listed with `damaged`. */
  list(options?: StorageCallOptions): Promise<SlotInfo[]> {
    return this.#turn(() => this.#read(options));
  }

  /** The newest slot, autosaves included: what a Continue button loads. Null when there is none. */
  async latest(options?: StorageCallOptions): Promise<SlotInfo | null> {
    return (await this.list(options)).find((slot) => !slot.damaged) ?? null;
  }

  /** One slot's record, or null when the slot is empty. */
  async info(id: string, options?: StorageCallOptions): Promise<SlotInfo | null> {
    checkId(id);
    return this.#turn(async () => {
      const record = await this.#record(id, options);
      return record ? toInfo(id, record) : null;
    });
  }

  /**
   * The slot's save: decoded, migrated and validated as by `loadGame`. Null when the slot is empty.
   * Rejects with a TypeError for a damaged save or record, a MargoError `'failed'` when a migration fails.
   */
  async load(id: string, options: LoadOptions = {}): Promise<SaveDocument | null> {
    checkId(id);
    return this.#turn(async () => {
      const record = await this.#record(id, options);
      if (!record) return null;
      const document = await loadGame(this.#storage, this.#data(id, record.generation), options);
      if (!document) throw new TypeError(`Slot '${id}' has lost its save; delete the slot`);
      return document;
    });
  }

  /** The slot's thumbnail as a Blob of its type, for `URL.createObjectURL` or `createImageBitmap`. Null when it has none. */
  async thumbnail(id: string, options?: StorageCallOptions): Promise<Blob | null> {
    checkId(id);
    return this.#turn(async () => {
      const record = await this.#record(id, options);
      if (!record?.thumbnail) return null;
      const bytes = await this.#storage.read(this.#image(id, record.generation), options);
      return bytes && new Blob([bytes as BlobPart], { type: record.thumbnail });
    });
  }

  /** Copies a slot to another name, keeping its record's time. An existing slot `to` is replaced in one step. */
  async copy(from: string, to: string, options?: StorageCallOptions): Promise<SlotInfo> {
    checkId(from);
    checkId(to);
    if (to.startsWith(AUTO)) throw new TypeError(`Slot id '${to}': 'auto-' names belong to autosave(); use another id`);
    return this.#turn(async () => {
      const record = await this.#record(from, options);
      if (!record) throw new MargoError('state', `Slot '${from}' is empty; copy a slot that holds a save`);
      const generation = await this.#next(to, options),
        keep = [this.#data(to, generation)],
        bytes = await this.#storage.read(this.#data(from, record.generation), options);
      if (!bytes) throw new TypeError(`Slot '${from}' has lost its save; delete the slot`);
      await this.#storage.write(keep[0], bytes, options);
      if (record.thumbnail) {
        const image = await this.#storage.read(this.#image(from, record.generation), options);
        if (image) {
          keep.push(this.#image(to, generation));
          await this.#storage.write(keep[1], image, options);
        }
      }
      const copied: SlotRecord = { ...record, generation, autosave: false };
      await this.#storage.write(this.#info(to), new TextEncoder().encode(JSON.stringify(copied)), options);
      await this.#clear(to, keep, options);
      return toInfo(to, copied);
    });
  }

  /** Empties a slot; resolves whether it held anything. Its record goes first, so a crash cannot leave half a slot. */
  async delete(id: string, options?: StorageCallOptions): Promise<boolean> {
    checkId(id);
    return this.#turn(async () => {
      const had = await this.#storage.delete(this.#info(id), options);
      await this.#clear(id, [], options);
      return had;
    });
  }
}

/** The id a key's name decodes to, or null for a key these slots never wrote. */
function slotId(name: string): string | null {
  try {
    return decodeURIComponent(name);
  } catch {
    return null;
  }
}

function checkId(id: string): void {
  if (typeof id !== 'string' || !id) throw new TypeError('Slot id must be a non-empty string, e.g. "slot-1"');
}

function toInfo(id: string, record: SlotRecord): SlotInfo {
  const { format: _format, generation: _generation, ...info } = record;
  return { id, ...info };
}

/** Options of {@link captureThumbnail}. */
export interface ThumbnailOptions {
  /** Width in pixels; the height follows the canvas's shape. Default 320. */
  width?: number;
  /** Default `'image/webp'`; a browser without it gives PNG. */
  type?: string;
  /** Between 0 and 1. Default 0.8. */
  quality?: number;
}

/**
 * A small picture of a canvas, for `thumbnail`. Call it right after `engine.render()`, in the same task: a WebGPU
 * canvas keeps its picture only until the frame is shown.
 * @throws MargoError `'unsupported'` where there is no OffscreenCanvas.
 */
export async function captureThumbnail(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options: ThumbnailOptions = {},
): Promise<Blob> {
  const { width = 320, type = 'image/webp', quality = 0.8 } = options;
  if (!(width > 0)) throw new RangeError('width must be above 0');
  if (!canvas.width || !canvas.height) throw new RangeError('captureThumbnail needs a canvas with a size; render a frame first');
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function')
    throw new MargoError('unsupported', 'captureThumbnail needs OffscreenCanvas; pass your own thumbnail bytes here');
  const height = Math.max(1, Math.round((width * canvas.height) / canvas.width)),
    small = new OffscreenCanvas(width, height),
    picture = await createImageBitmap(canvas, { resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' });
  small.getContext('2d')!.drawImage(picture, 0, 0);
  picture.close();
  return small.convertToBlob({ type, quality });
}
