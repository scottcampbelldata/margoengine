export type Easing = (time: number) => number;
export const linear: Easing = t => t;
export const smoothstep: Easing = t => t * t * (3 - 2 * t);
export const easeInOutCubic: Easing = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export interface TweenOptions {duration: number; delay?: number; easing?: Easing; onComplete?: () => void}
interface Track {target: Record<string, number>; key: string; from: number; to: number; duration: number; delay: number; easing: Easing; complete?: () => void; time: number; active: boolean}

/** Reuses tracks during updates; adding/removing tracks is outside the hot loop. */
export class Tween {
  private readonly tracks: Track[] = [];
  private updating = false;
  to(target: Record<string, number>, key: string, to: number, {duration, delay = 0, easing = linear, onComplete}: TweenOptions): () => void {
    const from = target[key];
    if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(duration) || duration < 0 || !Number.isFinite(delay) || delay < 0 || typeof easing !== 'function' || onComplete !== undefined && typeof onComplete !== 'function') throw new RangeError('Invalid tween');
    for (const track of this.tracks) if (track.active && track.target === target && track.key === key) track.active = false;
    const track: Track = {target, key, from, to, duration, delay, easing, complete: onComplete, time: 0, active: true};
    this.tracks.push(track); return () => {track.active = false;};
  }
  update(delta: number): void {
    if (!Number.isFinite(delta) || delta < 0) throw new RangeError('Invalid tween delta');
    if (this.updating) throw new Error('Recursive tween update');
    this.updating = true;
    const count = this.tracks.length;
    try {
    for (let i = 0; i < count; i++) {
      const track = this.tracks[i]; if (!track.active) continue;
      track.time += delta; if (track.time < track.delay) continue;
      const t = track.duration ? Math.min(1, (track.time - track.delay) / track.duration) : 1, eased = t === 1 ? 1 : track.easing(t);
      if (!Number.isFinite(eased)) throw new RangeError('Easing must return a finite value');
      track.target[track.key] = track.from + (track.to - track.from) * eased;
      if (t === 1) {track.active = false; track.complete?.();}
    }
    } finally {this.updating = false; this.compact();}
  }
  /** Remove finished/cancelled tracks outside the update loop. */
  compact(): void {
    if (this.updating) throw new Error('Cannot compact during tween callbacks');
    let count = 0; for (let i = 0; i < this.tracks.length; i++) if (this.tracks[i].active) this.tracks[count++] = this.tracks[i];
    this.tracks.length = count;
  }
  clear(): void {for (const track of this.tracks) track.active = false; if (!this.updating) this.tracks.length = 0;}
}
