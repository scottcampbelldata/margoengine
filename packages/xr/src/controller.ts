import type { XRInputSource, XRNativeFrame, XRSpace, XRPose } from './types.js';

/** Buffers are reused; read them during the frame callback or copy to retain a snapshot. */
export class XRController {
  /** Pose of the pointing ray this frame, or null when untracked. */
  targetRay: XRPose | null = null;
  /** Pose of the held grip this frame, or null when untracked or absent. */
  grip: XRPose | null = null;
  /** Column-major target-ray matrix; zero when untracked. */
  readonly targetRayMatrix = new Float32Array(16);
  /** Column-major grip matrix; zero when untracked. */
  readonly gripMatrix = new Float32Array(16);
  /** Per button: value, pressed, touched (32 buttons). */
  readonly buttons = new Float32Array(32 * 3);
  /** Gamepad axes (up to 16). */
  readonly axes = new Float32Array(16);
  /** 25 column-major joint matrices when hand tracking is granted. */
  readonly handMatrices = new Float32Array(25 * 16);
  /** 1 for each joint that has a pose this frame. */
  readonly handTracked = new Uint8Array(25);
  /** Each joint's radius in metres (WebXR Hand Input: a sphere at the joint touching the skin); 0 when untracked. */
  readonly handRadii = new Float32Array(25);
  /** Buttons the gamepad reports. */
  buttonCount = 0;
  /** Axes the gamepad reports. */
  axisCount = 0;
  private readonly joints: XRSpace[];
  /** @param source The browser's input source. */
  constructor(readonly source: XRInputSource) {
    this.joints = source.hand ? Array.from(source.hand.values()) : [];
    if (this.joints.length > 25)
      throw new RangeError('XR hand exceeds 25 joints; the controller buffers hold the 25 WebXR hand joints');
  }
  /** Reads this frame's poses and gamepad into the reused buffers. */
  update(frame: XRNativeFrame, space: XRSpace): void {
    this.targetRay = frame.getPose(this.source.targetRaySpace, space);
    this.grip = this.source.gripSpace ? frame.getPose(this.source.gripSpace, space) : null;
    this.targetRayMatrix.fill(0);
    this.gripMatrix.fill(0);
    if (this.targetRay) this.targetRayMatrix.set(this.targetRay.transform.matrix);
    if (this.grip) this.gripMatrix.set(this.grip.transform.matrix);
    const gamepad = this.source.gamepad;
    this.buttonCount = gamepad?.buttons.length ?? 0;
    this.axisCount = gamepad?.axes.length ?? 0;
    if (this.buttonCount > 32 || this.axisCount > 16)
      throw new RangeError(
        'XR gamepad exceeds controller buffer capacity; at most 32 buttons and 16 axes are supported',
      );
    this.buttons.fill(0);
    this.axes.fill(0);
    if (gamepad) {
      for (let i = 0; i < this.buttonCount; i++) {
        const button = gamepad.buttons[i];
        this.buttons[i * 3] = button.value;
        this.buttons[i * 3 + 1] = +button.pressed;
        this.buttons[i * 3 + 2] = +button.touched;
      }
      this.axes.set(gamepad.axes);
    }
    this.handMatrices.fill(0);
    this.handTracked.fill(0);
    this.handRadii.fill(0);
    for (let i = 0; i < this.joints.length; i++) {
      const pose = frame.getJointPose?.(this.joints[i], space) as (XRPose & { radius?: number }) | null | undefined;
      if (pose) {
        this.handMatrices.set(pose.transform.matrix, i * 16);
        this.handTracked[i] = 1;
        this.handRadii[i] = pose.radius ?? 0;
      }
    }
  }
}
