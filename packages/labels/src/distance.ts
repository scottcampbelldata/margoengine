/// <reference lib="esnext.disposable" preserve="true" />
import type { Label, LabelLayout, LayoutContext } from './renderer.js';
import { rangeError } from '../../shared/errors.js';

/** Clamped linear interpolation between two distances in world units. */
export interface LabelDistanceCurve {
  near: number;
  nearValue: number;
  far: number;
  farValue: number;
}
/** Distance policy for one label. Omitted curves keep opacity and scale at 1. */
export interface LabelDistancePolicy {
  /** Inclusive near show limit, default 0. */
  near?: number;
  /** Inclusive far show limit, default Infinity. */
  far?: number;
  /** Endpoint opacity values must be in [0, 1]. */
  opacity?: LabelDistanceCurve;
  /** Nonnegative scale, multiplied by the renderer's distanceScale. */
  scale?: LabelDistanceCurve;
}
/** Configuration for a distance layout and an optional subsequent layout. */
export interface DistanceLabelsOptions {
  /** Policy applied to labels without a per-label policy. Default no limits or fades. */
  defaults?: LabelDistancePolicy;
  /** Runs after distance culling/scaling, so collision and callout geometry uses the final scale. */
  layout?: LabelLayout;
}

function checked(policy: LabelDistancePolicy): LabelDistancePolicy {
  const near = policy.near ?? 0,
    far = policy.far ?? Infinity;
  if (!Number.isFinite(near) || near < 0 || !(far >= near) || (far !== Infinity && !Number.isFinite(far)))
    throw rangeError('use finite near >= 0 and far >= near (Infinity allowed for far)', 'labels');
  const result: LabelDistancePolicy = { near, far };
  for (const key of ['opacity', 'scale'] as const) {
    const c = policy[key];
    if (!c) continue;
    if (
      ![c.near, c.nearValue, c.far, c.farValue].every(Number.isFinite) ||
      c.near < 0 ||
      c.far <= c.near ||
      c.nearValue < 0 ||
      c.farValue < 0 ||
      (key === 'opacity' && (c.nearValue > 1 || c.farValue > 1))
    )
      throw rangeError(
        'use finite curve distances with 0 <= near < far, nonnegative scale and opacity in [0,1]',
        'labels',
      );
    result[key] = { ...c };
  }
  return result;
}
function value(distance: number, curve: LabelDistanceCurve | undefined): number {
  if (!curve) return 1;
  if (distance <= curve.near) return curve.nearValue;
  if (distance >= curve.far) return curve.farValue;
  const t = Math.min(1, Math.max(0, (distance - curve.near) / (curve.far - curve.near)));
  return curve.nearValue + (curve.farValue - curve.nearValue) * t;
}
/** Pure evaluation for DOM or GPU label consumers. Curves clamp at both ends; show limits are inclusive. */
export function evaluateLabelDistance(
  distance: number,
  policy: LabelDistancePolicy = {},
): { opacity: number; scale: number; visible: boolean } {
  if (!Number.isFinite(distance) || distance < 0) throw rangeError('distance must be finite and nonnegative', 'labels');
  const p = checked(policy),
    opacity = value(distance, p.opacity),
    scale = value(distance, p.scale);
  return { opacity, scale, visible: distance >= p.near! && distance <= p.far! && opacity > 0 && scale > 0 };
}

/**
 * Optional distance fade/display layout. Policies never change label.visible or its original opacity.
 * Pass as LabelRenderer's layout; set(label, policy) overrides the default policy for that label.
 */
export class DistanceLabels implements LabelLayout {
  private readonly policies = new Map<Label, LabelDistancePolicy>();
  private readonly styles = new Map<Label, { original: string; last: string }>();
  private readonly defaults: LabelDistancePolicy;
  readonly layout?: LabelLayout;
  /** Labels excluded by the last distance update. */
  hidden = 0;
  constructor(options: DistanceLabelsOptions = {}) {
    this.defaults = checked(options.defaults ?? {});
    this.layout = options.layout;
  }
  /** Validates and copies a per-label policy. */
  set(label: Label, policy: LabelDistancePolicy): this {
    this.policies.set(label, checked(policy));
    return this;
  }
  /** Drops a policy, restores inline opacity, and returns whether the label had a policy. */
  delete(label: Label): boolean {
    this.restore(label);
    return this.policies.delete(label);
  }
  arrange(labels: readonly Label[], context: LayoutContext): void {
    const shown: Label[] = [];
    this.hidden = 0;
    for (const label of labels) {
      const p = this.policies.get(label) ?? this.defaults;
      const opacity = value(label.distance, p.opacity),
        scale = value(label.distance, p.scale);
      if (
        !Number.isFinite(label.distance) ||
        label.distance < p.near! ||
        label.distance > p.far! ||
        opacity <= 0 ||
        scale <= 0
      ) {
        context.hide(label);
        this.hidden++;
        continue;
      }
      label.scale *= scale;
      if (p.opacity) {
        let state = this.styles.get(label);
        if (!state) {
          const original = label.element.style.opacity ?? '';
          this.styles.set(label, (state = { original, last: original }));
        }
        const original = state.original === '' ? 1 : Number(state.original),
          next = String(opacity * (Number.isFinite(original) ? original : 1));
        if (state.last !== next) {
          label.element.style.opacity = next;
          state.last = next;
        }
      } else this.restore(label);
      shown.push(label);
    }
    for (const label of this.styles.keys())
      if (label.owner === null) {
        this.restore(label);
        this.policies.delete(label);
      }
    this.layout?.arrange(shown, context);
  }
  private restore(label: Label): void {
    const state = this.styles.get(label);
    if (state) {
      label.element.style.opacity = state.original;
      this.styles.delete(label);
    }
  }
  /** Restores every managed opacity and drops per-label policies. */
  clear(): void {
    for (const label of this.styles.keys()) this.restore(label);
    this.policies.clear();
  }
  dispose(): void {
    this.clear();
  }
  [Symbol.dispose](): void {
    this.clear();
  }
}
