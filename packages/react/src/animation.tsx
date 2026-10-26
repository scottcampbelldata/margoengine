'use client';
import { forwardRef, useContext, useImperativeHandle, useRef } from 'react';
import type { Animation as ClipAnimation } from '@margoengine/animation';
import type { AdditiveLayer, Animator, BlendTree } from '@margoengine/animator';
import type { PBRModel } from '@margoengine/gltf-pro';
import type { Vec3 } from '@margoengine/core/extension';
import { useCommit, useResourceEffect, useScene } from './internal.js';
import { ModelContext } from './model.js';
import { optionalPeer } from './optional.js';
import { MargoError } from '@margoengine/math/errors';

/** Props of the Animation component; every prop is optional unless noted. */
export interface AnimationProps {
  /** A glTF animation name, or a key of `blendTrees`. */
  clip: string;
  /** Advance the clock while true (default true). */
  playing?: boolean;
  /** Loop the clip (default true). With `loop={false}` the clip holds its last pose and `onFinished` fires once. */
  loop?: boolean;
  /** Crossfade duration in seconds when clip changes. Uses @margoengine/animator. */
  blend?: number;
  /** Playback speed multiplier, 0 and up (default 1). */
  speed?: number;
  /** Seek to this time in seconds whenever the value changes. Leave it unset for free-running playback. */
  time?: number;
  /** Live blend-tree parameters, for example `{ speed: 0.7 }`. Uses @margoengine/animator. */
  parameters?: Readonly<Record<string, number>>;
  /**
   * Named blend trees (1D by one parameter, 2D by two) that `clip` can select next to the plain clips.
   * Uses @margoengine/animator.
   */
  blendTrees?: Readonly<Record<string, BlendTree>>;
  /** Additive layers on top of the current state (mask is the model's node indices). Uses @margoengine/animator. */
  layers?: readonly AdditiveLayer[];
  /** A non-looping clip reached its end; receives the clip name. */
  onFinished?: (clip: string) => void;
  /** The native playback is created; the same handle is also available through `ref`. */
  onReady?: (handle: AnimationHandle) => void;
  onError?: (error: unknown) => void;
}
/** Imperative view of one model's playback, through `ref` or `onReady`. Reads are live. */
export interface AnimationHandle {
  /** Every plain clip name of the model, in file order. */
  readonly names: readonly string[];
  /** The selected clip or blend tree name; empty before playback starts. */
  readonly clip: string;
  /** Seconds into the current clip (or state). */
  readonly time: number;
  /** The native Animation, or null before it loads. */
  readonly animation: ClipAnimation | null;
  /** The native Animator once blending, parameters, blend trees or layers loaded it, else null. */
  readonly animator: Animator | null;
  /** Jump to `time` seconds and apply the pose now. */
  seek(time: number): void;
}
interface Playback {
  animation: ClipAnimation;
  animator?: Animator;
  clip: string;
  prepareMixer: () => void;
  /** Re-sample the Animator's pose at its current time without advancing it. */
  resample: () => void;
  layerKey: string;
  /** The state whose end `onFinished` already reported; a seek or restart clears it. */
  finishedState?: string;
  layerOff: Array<() => void>;
}
interface Pose {
  nodes: Array<{ position: Vec3; scale: Vec3; rotation: number[] }>;
  weights: Float32Array[];
}
function pose(model: PBRModel): Pose {
  return {
    nodes: model.nodes.map((node) => {
      const t = node.engine.store.transforms,
        id = node.id;
      return {
        position: [t.x[id], t.y[id], t.z[id]],
        scale: [t.sx[id], t.sy[id], t.sz[id]],
        rotation: [t.qx[id], t.qy[id], t.qz[id], t.qw[id]],
      };
    }),
    weights: model.primitives.map((primitive) => primitive.weights.slice()),
  };
}
function restore(model: PBRModel, value: Pose): void {
  model.nodes.forEach((node, index) => {
    const saved = value.nodes[index];
    node.setPosition(saved.position).setScale(saved.scale).setQuaternion(saved.rotation);
  });
  model.primitives.forEach((primitive, index) => primitive.weights.set(value.weights[index]));
}
function validate({ clip, playing = true, loop = true, blend = 0, speed = 1, time, parameters }: AnimationProps): void {
  if (typeof clip !== 'string' || !clip) throw new TypeError('Animation: clip must name a glTF animation');
  if (typeof playing !== 'boolean' || typeof loop !== 'boolean' || !Number.isFinite(blend) || blend < 0)
    throw new RangeError(
      'Animation: playing and loop must be booleans and blend a finite number >= 0; pass valid values.',
    );
  if (!Number.isFinite(speed) || speed < 0) throw new RangeError('Animation: speed must be a finite number >= 0');
  if (time !== undefined && (!Number.isFinite(time) || time < 0))
    throw new RangeError('Animation: time must be a finite number of seconds >= 0');
  for (const [name, value] of Object.entries(parameters ?? {}))
    if (!Number.isFinite(value))
      throw new RangeError('Animation: parameters must be finite numbers, fix "' + name + '"');
}
/** Blending, parameters, blend trees and layers all need the optional Animator. */
function needsMixer(props: AnimationProps): boolean {
  return (props.blend ?? 0) > 0 || !!props.layers?.length || Object.keys(props.blendTrees ?? {}).length > 0;
}
function treeClips(tree: BlendTree): string[] {
  return typeof tree === 'string' ? [tree] : tree.samples.map((sample) => sample.clip);
}
function checkTrees(current: Playback, props: AnimationProps): void {
  const names = new Set(current.animation.clips.map((clip) => clip.name));
  for (const [name, tree] of Object.entries(props.blendTrees ?? {})) {
    if (names.has(name))
      throw new RangeError('Animation: blend tree names must differ from clip names, rename "' + name + '"');
    for (const clip of treeClips(tree))
      if (!names.has(clip))
        throw new RangeError(
          'Animation: blend tree clips must exist in the model, fix "' + name + '" which uses "' + clip + '"',
        );
  }
}
/** Bring a running Animator in line with the props: states, parameters and additive layers. */
function syncAnimator(current: Playback, animator: Animator, props: AnimationProps): void {
  const states = animator.options.states,
    trees = props.blendTrees ?? {},
    clips = new Set(current.animation.clips.map((clip) => clip.name));
  for (const name of Object.keys(states))
    if (!clips.has(name) && !Object.hasOwn(trees, name) && name !== animator.state) delete states[name];
  for (const [name, tree] of Object.entries(trees)) states[name] = tree;
  Object.assign(animator.parameters, props.parameters);
  const key = JSON.stringify(props.layers ?? []);
  if (key !== current.layerKey) {
    for (const off of current.layerOff) off();
    current.layerOff = [];
    current.layerKey = key;
    for (const layer of props.layers ?? []) current.layerOff.push(animator.addLayer({ ...layer }));
  }
}
function select(current: Playback, props: AnimationProps): void {
  validate(props);
  const isClip = current.animation.clips.some((clip) => clip.name === props.clip);
  if (!isClip && !Object.hasOwn(props.blendTrees ?? {}, props.clip))
    throw new RangeError(
      `Animation: unknown clip "${props.clip}"; use a clip name from the model or a key of blendTrees.`,
    );
  checkTrees(current, props);
  current.animation.options.loop = props.loop ?? true;
  current.animation.options.speed = props.speed ?? 1;
  if (!current.clip) {
    // A blend tree starts from the first plain clip until the mixer owns the pose.
    current.animation.play(isClip ? props.clip : current.animation.clips[0].name);
    current.clip = props.clip;
  }
  if (current.animator) {
    syncAnimator(current, current.animator, props);
    if (current.clip !== props.clip) {
      current.animator.transition(props.clip, props.blend ?? 0);
      current.clip = props.clip;
    }
  } else {
    // Keep the source clip and its clock alive while the optional mixer loads.
    if (needsMixer(props)) current.prepareMixer();
    else if (current.clip !== props.clip) {
      current.animation.play(props.clip);
      current.clip = props.clip;
    }
    current.animation.playing = props.playing ?? true;
  }
}
function seekTo(current: Playback, time: number): void {
  if (!current.clip) return;
  current.finishedState = undefined;
  if (current.animator) {
    current.animator.time = time;
    current.resample();
  } else current.animation.seek(time);
}
/**
 * Play a named clip on the nearest Gltf/Fbx instance without sharing state.
 *
 * `speed`, `time`, `onFinished`, `parameters`, `blendTrees` and `layers` cover the common
 * animation-control needs; `ref` (or `onReady`) gives an {@link AnimationHandle} for the rest.
 */
export const Animation = forwardRef<AnimationHandle, AnimationProps>(function Animation(props, ref) {
  const scene = useScene(),
    model = useContext(ModelContext),
    latest = useRef(props),
    current = useRef<Playback | null>(null);
  latest.current = props;
  const handle = useRef<AnimationHandle | null>(null);
  handle.current ??= {
    get names() {
      return current.current?.animation.clips.map((clip) => clip.name) ?? [];
    },
    get clip() {
      return current.current?.clip ?? '';
    },
    get time() {
      const playback = current.current;
      return playback ? (playback.animator?.time ?? playback.animation.time) : 0;
    },
    get animation() {
      return current.current?.animation ?? null;
    },
    get animator() {
      return current.current?.animator ?? null;
    },
    seek(time) {
      if (!Number.isFinite(time) || time < 0)
        throw new RangeError('Animation: time must be a finite number of seconds >= 0');
      if (current.current) seekTo(current.current, time);
    },
  };
  useImperativeHandle(ref, () => handle.current!, []);
  if (model === undefined)
    throw new MargoError('state', 'Animation requires a parent <Gltf>, <Model>, or <Fbx>; render it inside one.');
  const report = (error: unknown) => {
    try {
      latest.current.onError?.(error);
    } finally {
      scene.engine.onError(error);
    }
  };
  useResourceEffect(
    (lease) => {
      if (!model) return;
      let owned: Playback | undefined;
      const release = () => {
        if (!owned) return;
        if (current.current === owned) current.current = null;
        for (const off of owned.layerOff) off();
        owned.animator?.dispose();
        owned.animation.dispose();
        owned = undefined;
      };
      void (async () => {
        validate(latest.current);
        const api = await optionalPeer('@margoengine/animation', () => import('@margoengine/animation'));
        if (!lease.active || scene.engine.disposed || model.disposed) return;
        if (scene.engine.hasPlugin('animation:' + model.name))
          throw new MargoError(
            'attached',
            'Animation: this model already has an animation plugin; mount one <Animation> per model.',
          );
        const animation = new api.Animation(model, { loop: latest.current.loop ?? true });
        const rest = pose(model);
        owned = { animation, clip: '', prepareMixer: () => {}, resample: () => {}, layerKey: '[]', layerOff: [] };
        const playback = owned;
        if (
          !animation.clips.some((value) => value.name === latest.current.clip) &&
          !Object.hasOwn(latest.current.blendTrees ?? {}, latest.current.clip)
        )
          throw new RangeError(
            `Animation: unknown clip "${latest.current.clip}"; use a clip name from the model or a key of blendTrees.`,
          );
        // A non-looping clip that reached its end fires onFinished once per run.
        const watchFinish = () => {
          const props = latest.current;
          if (!props.onFinished || props.loop !== false || props.playing === false) return;
          const state = playback.animator ? playback.animator.state : animation.clips[animation.clip]?.name,
            duration = animation.clips.find((value) => value.name === state)?.duration;
          if (state === undefined || duration === undefined) return;
          const time = playback.animator ? playback.animator.time : animation.time;
          if (time < duration) playback.finishedState = undefined;
          else if (playback.finishedState !== state) {
            playback.finishedState = state;
            try {
              props.onFinished(state);
            } catch (error) {
              report(error);
            }
          }
        };
        const advanceAnimation = animation.onPreUpdate.bind(animation);
        animation.onPreUpdate = (delta) => {
          advanceAnimation(delta);
          watchFinish();
        };
        // Native setup owns deformation buffers and the picking preparation hook.
        scene.engine.use(animation);
        let preparing: Promise<void> | undefined;
        playback.prepareMixer = () => {
          if (preparing || playback.animator) return;
          preparing = (async () => {
            const mixer = await optionalPeer('@margoengine/animator', () => import('@margoengine/animator'));
            if (
              !lease.active ||
              scene.engine.disposed ||
              model.disposed ||
              owned !== playback ||
              !needsMixer(latest.current)
            )
              return;
            const time = animation.time,
              visual = pose(model);
            let animator: Animator;
            // Animator captures its rest pose at construction. Restore the mount's
            // original pose temporarily, then let its native sampler reconstruct
            // the running source clip at the existing clock before transitioning.
            restore(model, rest);
            try {
              animator = new mixer.Animator(animation, {
                states: {
                  ...Object.fromEntries(animation.clips.map((value) => [value.name, value.name])),
                  ...latest.current.blendTrees,
                },
                initial: playback.clip,
                parameters: { ...latest.current.parameters },
              });
            } finally {
              restore(model, visual);
            }
            if (scene.engine.hasPlugin(animator.name))
              throw new MargoError(
                'attached',
                'Animation: this model already has an animator plugin; mount one <Animation> per model.',
              );
            scene.engine.use(animator);
            playback.animator = animator;
            const advance = animator.onPreUpdate.bind(animator);
            playback.resample = () => advance(0);
            let terminal: string | undefined;
            const step = (delta: number) => {
              if (latest.current.playing === false) return;
              if (latest.current.loop !== false) {
                terminal = undefined;
                advance(delta);
                return;
              }
              const duration = animation.clips.find((value) => value.name === animator.state)?.duration ?? 0;
              if (terminal === animator.state && animator.time >= duration) return;
              const remaining = Math.max(0, duration - animator.time);
              if (remaining > 0) advance(Math.min(delta, remaining));
              if (delta >= remaining) {
                animation.clip = animation.clips.findIndex((value) => value.name === animator.state);
                animation.seek(duration);
                terminal = animator.state;
              }
            };
            // Native code owns all sampling and blending. Gate only its clock.
            animator.onPreUpdate = (delta) => {
              step(delta);
              watchFinish();
            };
            advance(time);
            select(playback, latest.current);
          })()
            .catch((error) => {
              if (lease.active && !scene.engine.disposed && !model.disposed) report(error);
            })
            .finally(() => {
              preparing = undefined;
            });
        };
        select(owned, latest.current);
        current.current = owned;
        if (latest.current.time !== undefined) seekTo(owned, latest.current.time);
        latest.current.onReady?.(handle.current!);
      })().catch((error) => {
        release();
        if (lease.active && !scene.engine.disposed && !model.disposed) report(error);
      });
      return release;
    },
    [scene.engine, model],
  );
  useCommit(() => {
    if (current.current) {
      try {
        select(current.current, props);
      } catch (error) {
        report(error);
      }
    }
  }, [
    model,
    props.clip,
    props.playing,
    props.loop,
    props.blend,
    props.speed,
    JSON.stringify(props.blendTrees),
    JSON.stringify(props.parameters),
    JSON.stringify(props.layers),
  ]);
  useCommit(() => {
    if (current.current && props.time !== undefined) {
      try {
        validate(props);
        seekTo(current.current, props.time);
      } catch (error) {
        report(error);
      }
    }
  }, [model, props.time]);
  return null;
});
