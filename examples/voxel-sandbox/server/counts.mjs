// Who has found what in one Plaza world, and the rules for the rare blocks. The server's own block state decides
// everything: `previous` and the cell come from VoxelServer, never from a client's claim. An identity is the salted hash
// from identity.mjs, so nothing here can name an address.
//
// A decision and its effect are two steps, because VoxelServer may still refuse an edit after allowEdit said yes (the limit
// on edited chunks). allow() only decides; landed(), from the world's onChange in the same synchronous call as the
// setBlock, changes the counts. So a refused edit earns nothing, and a second edit in one tick sees the first one's effect.
import { VoxelChunk } from '@margoengine/voxel';
import { COUNTED_BLOCKS, GEM_TOTAL } from '../src/plaza-area.ts';

const OPAL = COUNTED_BLOCKS.indexOf('opal'),
  MAX_COUNT = 0xffff, // what a Uint16Array holds; past it a find still lands and the count stays
  EARN = 0,
  PLACE = 1,
  TAKE_BACK = 2;

const cellKey = (x, y, z) => `${x},${y},${z}`;

export class PlazaCounts {
  /** Identities whose counts changed since the last {@link PlazaCounts.takeChanges}. */
  #changed = new Set();
  #foundMoved = false;
  #dirty = false; // anything to write to state.json
  #revision = 0; // goes up with every change, so a write can say which changes it holds
  #found = 0;
  /** @type {Map<string, Uint16Array>} */
  #inventory = new Map();
  // Cells that already paid out, for whoever: natural ores and gems dug, and placed blocks taken back. Kept for the whole
  // world, because a rollback or a crash can bring such a block back, and it must not pay a second time.
  #dug = new Set();
  /** @type {Map<string, { identity: string, slot: number }>} */
  #placed = new Map();
  #slotOf; // block id to slot in COUNTED_BLOCKS, or -1
  #ids; // slot to block id
  #isGem;
  #pending; // what the edit allow() just passed will do if it lands

  /**
   * @param {{ blocks: import('@margoengine/voxel').BlockTypes, isGem: (x: number, y: number, z: number) => boolean, saved?: object }} options
   *   `isGem` is the natural gem test, `PlazaFinds.isGem`; `saved` is an earlier {@link PlazaCounts.toJSON}.
   */
  constructor({ blocks, isGem, saved }) {
    this.#isGem = isGem;
    this.#ids = COUNTED_BLOCKS.map((name) => blocks.id(name));
    this.#slotOf = new Int8Array(blocks.table.length).fill(-1);
    this.#ids.forEach((id, slot) => {
      this.#slotOf[id] = slot;
    });
    if (!saved) return;
    this.#found = saved.found;
    for (const [identity, counts] of Object.entries(saved.inventory))
      this.#inventory.set(identity, Uint16Array.from(counts));
    this.#dug = new Set(saved.dug);
    for (const [key, identity, slot] of saved.placed) this.#placed.set(key, { identity, slot });
  }

  /** Opals dug out of the ground. Never goes down, and is at most `GEM_TOTAL`. */
  get found() {
    return this.#found;
  }
  /** Whether something changed since the last {@link PlazaCounts.saved}. */
  get dirty() {
    return this.#dirty;
  }
  /** Names the changes {@link PlazaCounts.toJSON} gives now, for {@link PlazaCounts.saved}. */
  get revision() {
    return this.#revision;
  }
  /** Says that `revision` is on disk. A change that landed while it was being written stays to be written. */
  saved(revision) {
    if (revision === this.#revision) this.#dirty = false;
  }
  /** What `identity` holds, in the order of `COUNTED_BLOCKS`: a copy. */
  countsOf(identity) {
    return this.#inventory.get(identity)?.slice() ?? new Uint16Array(COUNTED_BLOCKS.length);
  }
  /** The owner of a placed rare block at the cell, or undefined. */
  ownerOf(x, y, z) {
    return this.#placed.get(cellKey(x, y, z))?.identity;
  }
  /** What moved since the last call: the identities whose counts changed, and whether `found` did. */
  takeChanges() {
    const changes = { identities: this.#changed, found: this.#foundMoved };
    this.#changed = new Set();
    this.#foundMoved = false;
    return changes;
  }

  /**
   * Whether `identity` may turn the cell from `previous` into `state`. Costs one array read for an edit that touches no
   * rare block. Changes no count: {@link PlazaCounts.landed} does, if the edit lands.
   */
  allow(identity, x, y, z, state, previous) {
    this.#pending = undefined;
    const slot = this.#slotOf[state & 0xffff] ?? -1,
      was = this.#slotOf[previous & 0xffff] ?? -1;
    if (slot < 0 && was < 0) return true;
    // A rare block only ever goes by being broken; rare blocks are solid, so VoxelServer does not allow this either.
    if (was >= 0 && (state & 0xffff) !== 0) return false;
    if (slot >= 0) {
      if (!this.#inventory.get(identity)?.[slot]) return false;
      this.#pending = { what: PLACE, identity, slot, x, y, z, state };
      return true;
    }
    const key = cellKey(x, y, z),
      placed = this.#placed.get(key);
    if (placed && placed.identity !== identity) return false;
    this.#pending = { what: placed ? TAKE_BACK : EARN, identity, slot: was, x, y, z, state, key };
    return true;
  }

  /** The world changed the cell; world.onChange calls this. Only the edit allow() just passed counts. Returns whether a count moved. */
  landed(x, y, z, state) {
    const p = this.#pending;
    if (!p || p.x !== x || p.y !== y || p.z !== z || p.state !== state) return false;
    this.#pending = undefined;
    if (p.what === PLACE) {
      this.#add(p.identity, p.slot, -1);
      this.#placed.set(cellKey(x, y, z), { identity: p.identity, slot: p.slot });
    } else if (p.what === TAKE_BACK) {
      this.#placed.delete(p.key);
      this.#dug.add(p.key);
      this.#add(p.identity, p.slot, 1);
    } else {
      // Dug before, then back through a rollback or a crash, or an opal that is no gem of this seed: it pays nothing.
      if (this.#dug.has(p.key) || (p.slot === OPAL && !this.#isGem(x, y, z))) return false;
      this.#dug.add(p.key);
      if (p.slot === OPAL) {
        this.#found++;
        this.#foundMoved = true;
      }
      this.#add(p.identity, p.slot, 1);
    }
    return true;
  }

  /**
   * Makes the placed blocks agree with `edits` (what `exportEdits` gives, or a snapshot): after a rollback or a restart
   * the world can be older than the counts. A placed block that is no longer there goes back to its owner; one that
   * is there stays its owner's. Returns how many went back.
   * @param {ReadonlyMap<string, import('@margoengine/voxel').PackedChunk>} edits
   */
  reconcile(edits) {
    let refunds = 0;
    const chunks = new Map();
    for (const [key, { identity, slot }] of this.#placed) {
      const [x, y, z] = key.split(',').map(Number),
        chunkKey = `${x >> 5},${y >> 5},${z >> 5}`;
      let chunk = chunks.get(chunkKey);
      if (chunk === undefined) {
        const packed = edits.get(chunkKey);
        chunk = packed ? VoxelChunk.unpack(packed) : null;
        chunks.set(chunkKey, chunk);
      }
      if (chunk && (chunk.get(x & 31, y & 31, z & 31) & 0xffff) === this.#ids[slot]) continue;
      this.#placed.delete(key);
      this.#dug.add(key);
      this.#add(identity, slot, 1);
      refunds++;
    }
    return refunds;
  }

  /** What state.json keeps. */
  toJSON() {
    return {
      found: this.#found,
      total: GEM_TOTAL,
      inventory: Object.fromEntries([...this.#inventory].map(([identity, counts]) => [identity, [...counts]])),
      dug: [...this.#dug],
      placed: [...this.#placed].map(([key, { identity, slot }]) => [key, identity, slot]),
    };
  }

  #add(identity, slot, by) {
    let counts = this.#inventory.get(identity);
    if (!counts) this.#inventory.set(identity, (counts = new Uint16Array(COUNTED_BLOCKS.length)));
    counts[slot] = Math.min(MAX_COUNT, counts[slot] + by);
    this.#changed.add(identity);
    this.#dirty = true;
    this.#revision++;
  }
}
