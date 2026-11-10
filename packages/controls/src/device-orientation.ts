import type { Camera, EngineKernel } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import {
  axisAngleToQuaternion as axis,
  multiplyQuaternions as multiply,
  conjugateQuaternion,
  interpolateQuaternions,
  rotateByQuaternion,
} from '@margoengine/math/quat';
import { Controls, type ControlElement, type EventTargetLike, type InputEventListener } from './controls.js';
import { madd, quatFromMatrix, type Q4 } from './math.js';
import { rollFrame } from './view.js';

/** Browser capabilities used by device orientation; injectable for replay and tests. */
export interface OrientationSource extends EventTargetLike {
  /** Native sensor constructor and optional permission operation. */
  DeviceOrientationEvent?: { requestPermission?: () => Promise<PermissionState> };
  /** Screen-orientation angle in degrees, read each update. */
  screen?: { orientation?: { readonly angle: number } };
  /** Legacy screen angle, in degrees. */
  orientation?: number;
}
/** Device-look configuration. */
export interface DeviceOrientationOptions {
  /** Sensor event source. Default window, when available. */
  source?: OrientationSource | null;
  /** Input element for the standard controls connection lifecycle. Default engine canvas. */
  element?: ControlElement | null;
  /** Quaternion smoothing time constant in seconds. Default 0.1; zero applies immediately. */
  smoothTime?: number;
  /** Align the first sample to the current view. Default true; false uses the sensor reference frame. */
  relative?: boolean;
  /** World-up yaw offset in radians. Default 0. */
  alphaOffset?: number;
}
const RAD = Math.PI / 180;
/** Convert W3C intrinsic Z-X-Y sensor angles and screen angle (degrees) into a Y-up camera quaternion. */
export function deviceOrientationQuaternion(alpha: number, beta: number, gamma: number, screenAngle = 0): Q4 {
  if (![alpha, beta, gamma, screenAngle].every(Number.isFinite))
    throw new RangeError('Orientation angles must be finite; pass degrees');
  let q = multiply(axis([1, 0, 0], -Math.PI / 2), axis([0, 0, 1], alpha * RAD));
  q = multiply(q, axis([1, 0, 0], beta * RAD));
  q = multiply(q, axis([0, 1, 0], gamma * RAD));
  return multiply(q, axis([0, 0, 1], -screenAngle * RAD));
}
/** Phone/tablet sensor look with screen compensation, permission handling and quaternion smoothing. */
export class DeviceOrientationControls extends Controls {
  /** Smoothing time constant in seconds. Default 0.1. */
  smoothTime: number;
  /** Yaw offset in radians about world up. Default 0. */
  alphaOffset: number;
  /** Permission state; unsupported means the source exposes no orientation sensor. */
  get permission(): PermissionState | 'unsupported' {
    return this.permissionState;
  }
  /** Whether the most recent sample uses the absolute reference frame. */
  absolute = false;
  private readonly source: OrientationSource | null;
  private permissionState: PermissionState | 'unsupported';
  private sample: [number, number, number] | null = null;
  private correction: Q4 = [0, 0, 0, 1];
  private rotation: Q4 | null = null;
  private align: boolean;
  private dead = false;
  private permissionPending: AbortController | null = null;
  constructor(source: Camera | EngineKernel, options: DeviceOrientationOptions = {}) {
    if (
      !Number.isFinite(options.smoothTime ?? 0.1) ||
      (options.smoothTime ?? 0.1) < 0 ||
      !Number.isFinite(options.alphaOffset ?? 0)
    )
      throw new RangeError('Device look needs finite smoothTime >= 0 and alphaOffset; pass valid values');
    super(source, options.element);
    this.source =
      options.source === undefined
        ? typeof window === 'undefined'
          ? null
          : (window as unknown as OrientationSource)
        : options.source;
    this.smoothTime = options.smoothTime ?? 0.1;
    this.alphaOffset = options.alphaOffset ?? 0;
    this.align = options.relative ?? true;
    this.permissionState = !this.source?.DeviceOrientationEvent
      ? 'unsupported'
      : this.source.DeviceOrientationEvent.requestPermission
        ? 'prompt'
        : 'granted';
    this.init();
    // A bare Camera can still listen to the sensor without a canvas.
    if (!this.element && this.source)
      this.connect({ addEventListener() {}, removeEventListener() {}, clientWidth: 1, clientHeight: 1 });
  }
  /** Request sensor permission from a user gesture. Aborting, disconnecting or timeout prevents late activation. */
  async requestPermission({
    signal,
    timeout = 10000,
  }: {
    signal?: AbortSignal;
    timeout?: number;
  } = {}): Promise<boolean> {
    if (this.dead) throw new MargoError('disposed', 'Device controls are disposed; create new controls');
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new RangeError('Permission timeout must be positive and finite; pass milliseconds');
    signal?.throwIfAborted();
    if (this.permissionState === 'unsupported') return false;
    const request = this.source?.DeviceOrientationEvent?.requestPermission;
    if (!request) return true;
    this.permissionPending?.abort();
    const controller = new AbortController();
    this.permissionPending = controller;
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    // Invoke before the first await so the browser retains transient user activation.

    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    try {
      const permission = request.call(this.source!.DeviceOrientationEvent);
      const state = await Promise.race([
        permission,
        new Promise<never>((_, reject) => {
          abort = () => reject(combined.reason);
          combined.addEventListener('abort', abort, { once: true });
          timer = setTimeout(
            () => controller.abort(new DOMException('Orientation permission timed out', 'TimeoutError')),
            timeout,
          );
          if (combined.aborted) abort();
        }),
      ]);
      combined.throwIfAborted();
      this.permissionState = state;
      this.dispatchEvent({ type: 'permission', state });
      return state === 'granted';
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort) combined.removeEventListener('abort', abort);
      if (this.permissionPending === controller) this.permissionPending = null;
    }
  }
  /** Align the next sensor sample to the current camera view, preserving roll. */
  recenter(): void {
    this.align = true;
    this.rotation = null;
  }
  protected override bind(
    _element: ControlElement,
  ): Array<[EventTargetLike, string, InputEventListener, AddEventListenerOptions?]> {
    if (!this.source) return [];
    return [[this.source, 'deviceorientation', this.orient]];
  }
  private orient = (event: DeviceOrientationEvent): void => {
    if (!this.enabled || this.dead || this.permissionState !== 'granted') return;
    if (
      event.alpha === null ||
      event.beta === null ||
      event.gamma === null ||
      ![event.alpha, event.beta, event.gamma].every(Number.isFinite)
    )
      return;
    this.sample = [event.alpha, event.beta, event.gamma];
    this.absolute = event.absolute;
  };
  override update(delta = 1 / 60): boolean {
    if (this.dead || !this.enabled || !this.sample || this.permissionState !== 'granted') return false;
    if (
      !Number.isFinite(delta) ||
      delta < 0 ||
      !Number.isFinite(this.smoothTime) ||
      this.smoothTime < 0 ||
      !Number.isFinite(this.alphaOffset)
    )
      throw new RangeError(
        'Device look needs finite delta and smoothTime >= 0 and finite alphaOffset; pass valid values',
      );
    const angle = this.source?.screen?.orientation?.angle ?? this.source?.orientation ?? 0;
    const raw = deviceOrientationQuaternion(...this.sample, angle),
      b = rollFrame(this.camera);
    if (this.align) {
      const current = quatFromMatrix([...b.right, 0, ...b.up, 0, ...b.forward.map((v) => -v), 0, 0, 0, 0, 1]);
      this.correction = multiply(
        multiply(conjugateQuaternion(axis([0, 1, 0], this.alphaOffset)), current),
        conjugateQuaternion(raw),
      );
      this.rotation = current;
      this.align = false;
    }
    const target = multiply(axis([0, 1, 0], this.alphaOffset), multiply(this.correction, raw));
    this.rotation =
      this.rotation && this.smoothTime > 0
        ? interpolateQuaternions(this.rotation, target, -Math.expm1(-delta / this.smoothTime), 1 - Number.EPSILON)
        : target;
    const forward = rotateByQuaternion([0, 0, -1], this.rotation),
      up = rotateByQuaternion([0, 1, 0], this.rotation),
      distance = Math.max(1e-6, b.distance);
    const look = madd(this.camera.position, forward, distance),
      changed =
        look.some((v, i) => Math.abs(v - this.camera.target[i]) > 1e-12) ||
        up.some((v, i) => Math.abs(v - this.camera.up[i]) > 1e-12);
    if (changed) {
      this.camera.target = look;
      this.camera.up = up;
      this.dispatchEvent({ type: 'change' });
    }
    return changed;
  }
  protected override onDisconnect(): void {
    this.permissionPending?.abort();
    this.permissionPending = null;
    this.sample = null;
    this.rotation = null;
  }
  override dispose(): void {
    if (this.dead) return;
    this.dead = true;
    super.dispose();
  }
}
