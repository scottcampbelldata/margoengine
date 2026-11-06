// Sync groups: states whose clips share one phase, so a walk and a run of different lengths blend with their feet
// together. Phase counts cycles. With markers, a cycle is cut at named moments (left foot down, right foot down) and each
// clip maps phase to its own time piece by piece, so clips whose steps fall at different fractions of the clip still meet
// at every marker. A state's clock runs at the blended length of the piece it is in (the weighted mean of the clips'
// lengths), which is how a blend of 1 s and 0.7 s cycles at 0.5 weight takes 0.85 s.
//
// A state's time stays a clock in its longest clip's seconds (phase x longest), so normalized time, exit times and timed
// events all read phase.
import type { ClipMarker } from '@margoengine/animation/sampling';
import { MargoError } from '@margoengine/math/errors';
import { treeWeights } from './blend.js';
import type { Animator, StateClock } from './index.js';

/** Options of {@link addSyncGroup}. */
export interface SyncGroup {
  /** The states that share a phase, each a clip or a blend tree of looping cycles. */
  states: readonly string[];
  /**
   * Marker names in cycle order, for example `['LeftFootDown', 'RightFootDown']`: every clip's listed markers must follow
   * this order round its loop, and phase 0 is the first name. Default: none, so phase is each clip's fraction.
   */
  markers?: readonly string[];
  /** Markers for clips that have none of their own (glTF clips), by clip name; each `time` is in that clip's seconds. */
  clipMarkers?: Readonly<Record<string, readonly ClipMarker[]>>;
}

/** A sync group handle. */
export interface SyncGroupHandle {
  /** Where the group is in its cycle, from 0 up to 1. */
  readonly phase: number;
  /** Stops syncing: its states play on their own clocks again. */
  dispose(): void;
  [Symbol.dispose](): void;
}

interface ClipCycle {
  duration: number;
  /** Clip seconds at each marker, then the first again one loop on; [0, duration] without markers. */
  marks: Float64Array;
}

/**
 * Keeps `group.states` in phase on `animator`: within a state, every clip of a blend tree plays at the group's phase
 * instead of its own clock; across a transition, the new state starts at the phase the old one had, and during a
 * crossfade the old state keeps playing in phase rather than freezing. Root motion follows the phase. Returns the
 * handle; dispose it to stop.
 * @throws RangeError for an unknown state, a state in another group, a clip of no length, or clip markers that do not
 * follow `group.markers`.
 */
export function addSyncGroup(animator: Animator, group: SyncGroup): SyncGroupHandle {
  const states = group?.states,
    names = group?.markers ?? [];
  if (!Array.isArray(states) || !states.length)
    throw new RangeError("Sync group needs states: at least one state name, for example {states: ['walk', 'run']}");
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !name))
    throw new TypeError('Sync group markers must be marker names in cycle order');
  const pieces = Math.max(1, names.length),
    clips = new Map<string, ClipCycle>(),
    longest = new Map<string, number>();
  const cycleOf = (name: string): ClipCycle => {
    let cycle = clips.get(name);
    if (cycle) return cycle;
    const clip = animator.animation.clips.find((c) => c.name === name)!,
      duration = clip.duration;
    if (!(duration > 0)) throw new RangeError(`Sync group clip "${name}" has no length; pass clips with a duration above 0`);
    cycle = {
      duration,
      marks: names.length
        ? cycleMarks(name, group.clipMarkers?.[name] ?? (clip as { markers?: readonly ClipMarker[] }).markers ?? [], names, duration)
        : Float64Array.of(0, duration),
    };
    clips.set(name, cycle);
    return cycle;
  };
  for (const state of states) {
    if (!Object.hasOwn(animator.options.states, state))
      throw new RangeError(`Sync group state "${state}" is not one of this Animator's states; pass a key of options.states`);
    if (animator.hasStateClock(state))
      throw new RangeError(`Sync group state "${state}" already has a clock; dispose the group or warp that drives it first`);
    const tree = animator.options.states[state],
      list = typeof tree === 'string' ? [tree] : tree.samples.map((sample) => sample.clip);
    longest.set(state, Math.max(...list.map((name) => cycleOf(name).duration)));
  }
  let phase = 0,
    removed = false;
  const inGroup = (state: string) => longest.has(state);
  /** Seconds of `state`'s blended clips in piece `piece`. */
  const pieceLength = (state: string, piece: number): number => {
    const { clips: list, weights } = treeWeights(animator.options.states[state], animator.parameters);
    let total = 0,
      sum = 0;
    for (let i = 0; i < list.length; i++)
      if (weights[i] > 0) {
        const marks = clips.get(list[i])!.marks;
        total += weights[i];
        sum += weights[i] * (marks[piece + 1] - marks[piece]);
      }
    return sum / total;
  };
  const clock = (state: string): StateClock => {
    const scale = longest.get(state)!;
    return {
      advance(time, step) {
        let at = time / scale,
          left = step;
        while (left > 0) {
          const place = (at - Math.floor(at)) * pieces,
            piece = Math.min(pieces - 1, Math.floor(place)),
            seconds = pieceLength(state, piece),
            // Phase to the end of this piece, and how long that takes at this piece's blended length.
            gap = (piece + 1 - place) / pieces,
            needs = gap * pieces * seconds;
          if (left < needs) {
            at += left / (pieces * seconds);
            break;
          }
          at += gap;
          left -= needs;
        }
        phase = at;
        return at * scale;
      },
      clipTime(clip, time) {
        const cycle = clips.get(clip);
        if (!cycle) return time;
        const at = time / scale,
          lap = Math.floor(at),
          place = (at - lap) * pieces,
          piece = Math.min(pieces - 1, Math.floor(place)),
          marks = cycle.marks;
        return lap * cycle.duration + marks[piece] + (place - piece) * (marks[piece + 1] - marks[piece]);
      },
      follow(from, time) {
        return inGroup(from) ? (time / scale) * longest.get(from)! : undefined;
      },
    };
  };
  for (const state of states) animator.setStateClock(state, clock(state));
  const removeListener = animator.on('statechange', ({ from, to }) => {
    if (!inGroup(to)) return;
    const start = inGroup(from) ? (phase - Math.floor(phase)) * longest.get(to)! : 0;
    phase = start / longest.get(to)!;
    animator.enterAt(start);
  });
  const dispose = () => {
    if (removed) return;
    removed = true;
    removeListener();
    for (const state of states) animator.setStateClock(state, null);
  };
  return {
    get phase() {
      if (removed) throw new MargoError('disposed', 'Sync group is disposed; add a new one');
      return phase - Math.floor(phase);
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
}

/** The clip's times for `names`, rotated to start at the first name, then that time one loop on. */
function cycleMarks(
  clip: string,
  markers: readonly ClipMarker[],
  names: readonly string[],
  duration: number,
): Float64Array {
  const listed = markers.filter((marker) => names.includes(marker.name)).sort((a, b) => a.time - b.time),
    count = names.length,
    fault = () =>
      new RangeError(
        `Sync group clip "${clip}" needs its markers in the cycle order ${names.join(', ')}; it has ${
          listed.map((marker) => marker.name).join(', ') || 'none'
        }. Give clips without markers clipMarkers`,
      );
  if (listed.length !== count) throw fault();
  for (let first = 0; first < count; first++) {
    if (!names.every((name, i) => listed[(first + i) % count].name === name)) continue;
    const marks = new Float64Array(count + 1);
    for (let i = 0; i < count; i++) {
      const at = first + i;
      marks[i] = listed[at % count].time + (at >= count ? duration : 0);
    }
    marks[count] = marks[0] + duration;
    for (let i = 0; i < count; i++)
      if (!(marks[i + 1] > marks[i]))
        throw new RangeError(`Sync group clip "${clip}" has two markers at one moment; give each its own time`);
    return marks;
  }
  throw fault();
}
