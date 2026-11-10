/** The six native parameters of the browser's trigger-rumble effect. */
export interface TriggerRumbleEffect {
  duration: number;
  startDelay: number;
  strongMagnitude: number;
  weakMagnitude: number;
  leftTrigger: number;
  rightTrigger: number;
}
/** Structural actuator for injected devices and browsers whose TypeScript library predates trigger-rumble. */
export interface TriggerRumbleActuator {
  readonly effects?: readonly string[];
  playEffect(type: 'trigger-rumble', parameters: TriggerRumbleEffect): Promise<'complete' | 'preempted'>;
  reset?(): Promise<'complete' | 'preempted'>;
}
/** A native Gamepad is accepted directly; this smaller surface also accepts WebXR gamepad adapters and tests. */
export interface TriggerRumbleGamepad {
  readonly connected?: boolean;
  readonly vibrationActuator?: TriggerRumbleActuator | null;
}
/** Independent trigger and handle intensities, plus bounded cancellation. */
export interface TriggerRumbleOptions {
  /** Effect length in nonnegative safe-integer milliseconds. Default 100. Browsers may cap it. */
  duration?: number;
  /** Delay before starting, in nonnegative safe-integer milliseconds. Default 0. */
  startDelay?: number;
  /** Low-frequency handle intensity in [0,1]. Default 0. */
  strongMagnitude?: number;
  /** High-frequency handle intensity in [0,1]. Default 0. */
  weakMagnitude?: number;
  /** Left trigger intensity in [0,1]. Default 1. */
  leftTrigger?: number;
  /** Right trigger intensity in [0,1]. Default 1. */
  rightTrigger?: number;
  /** Aborts waiting and stops this call's effect if it still owns the actuator. */
  signal?: AbortSignal;
  /** Maximum wait in positive milliseconds, at most 2147483647. Default 6000. Increase for long effects. */
  timeout?: number;
}
const owners = new WeakMap<TriggerRumbleActuator, symbol>();
const zero: TriggerRumbleEffect = {
  duration: 0,
  startDelay: 0,
  strongMagnitude: 0,
  weakMagnitude: 0,
  leftTrigger: 0,
  rightTrigger: 0,
};
function bounded<T>(operation: Promise<T>, timeout: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (callback: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => finish(() => reject(signal!.reason));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new DOMException('Haptic actuator timed out; check the controller or increase timeout', 'TimeoutError'),
          ),
        ),
      timeout,
    );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
/**
 * True when trigger-rumble is advertised, false when absent/disconnected or explicitly unsupported,
 * undefined for older actuators without an effects list (triggerRumble probes those once).
 */
export function supportsTriggerRumble(gamepad: Gamepad | TriggerRumbleGamepad | null | undefined): boolean | undefined {
  const actuator = gamepad?.vibrationActuator as TriggerRumbleActuator | null | undefined;
  if (!actuator || gamepad?.connected === false || typeof actuator.playEffect !== 'function') return false;
  return actuator.effects?.includes('trigger-rumble');
}
/**
 * Play the native trigger-rumble effect, with independently controlled trigger and handle motors.
 * Returns true only for native 'complete', false for missing support or 'preempted'. Never substitutes dual-rumble.
 * Cancellation stops only the latest call through this entry on that actuator; reset has its own 1000 ms bound.
 * @throws RangeError for invalid parameters; native permission/device errors propagate.
 * @throws DOMException on abort/timeout; AggregateError if stopping the canceled effect also fails.
 */
export async function triggerRumble(
  gamepad: Gamepad | TriggerRumbleGamepad | null | undefined,
  {
    duration = 100,
    startDelay = 0,
    strongMagnitude = 0,
    weakMagnitude = 0,
    leftTrigger = 1,
    rightTrigger = 1,
    signal,
    timeout = 6000,
  }: TriggerRumbleOptions = {},
): Promise<boolean> {
  signal?.throwIfAborted();
  if (
    !Number.isSafeInteger(duration) ||
    duration < 0 ||
    !Number.isSafeInteger(startDelay) ||
    startDelay < 0 ||
    !Number.isFinite(timeout) ||
    timeout <= 0 ||
    timeout > 2147483647 ||
    [strongMagnitude, weakMagnitude, leftTrigger, rightTrigger].some(
      (value) => !Number.isFinite(value) || value < 0 || value > 1,
    )
  )
    throw new RangeError(
      'Invalid trigger rumble; use nonnegative safe-integer durations, intensities in [0,1] and a positive timeout at most 2147483647',
    );
  if (supportsTriggerRumble(gamepad) === false) return false;
  const actuator = gamepad!.vibrationActuator as TriggerRumbleActuator,
    token = Symbol();
  owners.set(actuator, token);
  try {
    const result = await bounded(
      actuator.playEffect('trigger-rumble', {
        duration,
        startDelay,
        strongMagnitude,
        weakMagnitude,
        leftTrigger,
        rightTrigger,
      }),
      timeout,
      signal,
    );
    if (result !== 'complete' && result !== 'preempted')
      throw new TypeError('Invalid haptic completion; use a native actuator returning complete or preempted');
    return result === 'complete';
  } catch (error) {
    if (signal?.aborted || (error as { name?: string })?.name === 'TimeoutError') {
      if (owners.get(actuator) === token) {
        try {
          await bounded(actuator.reset ? actuator.reset() : actuator.playEffect('trigger-rumble', { ...zero }), 1000);
        } catch (stopError) {
          throw new AggregateError(
            [error, stopError],
            'Trigger rumble cancellation failed; check the controller reset and original error',
          );
        }
      }
      throw error;
    }
    if ((error as { name?: string })?.name === 'NotSupportedError') return false;
    throw error;
  } finally {
    if (owners.get(actuator) === token) owners.delete(actuator);
  }
}
