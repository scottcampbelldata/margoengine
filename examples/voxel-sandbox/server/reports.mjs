// The griefing report rule, with no accounts: one report a minute per identity; three different identities on one
// 32 x 32 column area within 10 minutes roll back the 3 x 3 areas around it; those areas cannot roll back again by
// report for 30 minutes, so reports cannot loop. Identities come from identity.mjs, never from the report's body, so one
// person sending many reports is one identity however many they send. Nothing here keeps a timer: old entries go when
// the book is next used.

export const REPORT_INTERVAL = 60_000,
  REPORT_WINDOW = 10 * 60_000,
  REPORT_THRESHOLD = 3,
  ROLLBACK_COOLDOWN = 30 * 60_000;

/** The chunk column area of block coordinate `v`. */
export const areaOf = (v) => Math.floor(v / 32);

export class ReportBook {
  #last = new Map(); // identity: time of its last report
  #areas = new Map(); // 'world:cx,cz': Map(identity: time)
  #cooldown = new Map(); // 'world:cx,cz': time it ends
  #swept = 0;

  /** Takes one report's turn for `identity`; false when its last was under a minute ago. */
  take(identity, now) {
    this.#sweep(now);
    const last = this.#last.get(identity);
    if (last !== undefined && now - last < REPORT_INTERVAL) return false;
    this.#last.set(identity, now);
    return true;
  }

  /**
   * Counts a report on block column (x, z) of `world`. Returns `{ status: 'counted' }`, `{ status: 'cooldown' }`, or
   * `{ status: 'rollback', cx, cz, first }` with the area's centre and the time of the first of the reports.
   */
  add(world, identity, x, z, now) {
    this.#sweep(now);
    const cx = areaOf(x),
      cz = areaOf(z),
      key = `${world}:${cx},${cz}`;
    if ((this.#cooldown.get(key) ?? 0) > now) return { status: 'cooldown' };
    let reports = this.#areas.get(key);
    if (!reports) {
      reports = new Map();
      this.#areas.set(key, reports);
    }
    for (const [who, at] of reports) if (now - at >= REPORT_WINDOW) reports.delete(who);
    // An identity's first report in the window stands: the rollback must reach back before the damage it saw.
    if (!reports.has(identity)) reports.set(identity, now);
    if (reports.size < REPORT_THRESHOLD) return { status: 'counted' };
    const first = Math.min(...reports.values());
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const near = `${world}:${cx + dx},${cz + dz}`;
        this.#areas.delete(near);
        this.#cooldown.set(near, now + ROLLBACK_COOLDOWN);
      }
    return { status: 'rollback', cx, cz, first };
  }

  /** Entries held, for tests. */
  get size() {
    return this.#last.size + this.#areas.size + this.#cooldown.size;
  }

  #sweep(now) {
    if (now - this.#swept < REPORT_INTERVAL) return;
    this.#swept = now;
    for (const [who, at] of this.#last) if (now - at >= REPORT_INTERVAL) this.#last.delete(who);
    for (const [key, until] of this.#cooldown) if (until <= now) this.#cooldown.delete(key);
    for (const [key, reports] of this.#areas) {
      for (const [who, at] of reports) if (now - at >= REPORT_WINDOW) reports.delete(who);
      if (!reports.size) this.#areas.delete(key);
    }
  }
}
