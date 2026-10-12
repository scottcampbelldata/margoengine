import type { XRInputSource, XRNativeFrame, XRSpace, XRPose } from "./types.js";

/** Buffers are reused; read them during the frame callback or copy to retain a snapshot. */
export class XRController {
  targetRay: XRPose | null = null;
  grip: XRPose | null = null;
  readonly targetRayMatrix = new Float32Array(16);
  readonly gripMatrix = new Float32Array(16);
  readonly buttons = new Float32Array(32 * 3);
  readonly axes = new Float32Array(16);
  readonly handMatrices = new Float32Array(25 * 16);
  readonly handTracked = new Uint8Array(25);
  buttonCount = 0;
  axisCount = 0;
  private readonly joints: XRSpace[];
  constructor(readonly source: XRInputSource) {
    this.joints = source.hand ? Array.from(source.hand.values()) : [];
    if (this.joints.length > 25)
      throw new RangeError("XR hand exceeds 25 joints");
  }
  update(frame: XRNativeFrame, space: XRSpace): void {
    this.targetRay = frame.getPose(this.source.targetRaySpace, space);
    this.grip = this.source.gripSpace
      ? frame.getPose(this.source.gripSpace, space)
      : null;
    this.targetRayMatrix.fill(0);
    this.gripMatrix.fill(0);
    if (this.targetRay)
      this.targetRayMatrix.set(this.targetRay.transform.matrix);
    if (this.grip) this.gripMatrix.set(this.grip.transform.matrix);
    const gamepad = this.source.gamepad;
    this.buttonCount = gamepad?.buttons.length ?? 0;
    this.axisCount = gamepad?.axes.length ?? 0;
    if (this.buttonCount > 32 || this.axisCount > 16)
      throw new RangeError("XR gamepad exceeds controller buffer capacity");
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
    for (let i = 0; i < this.joints.length; i++) {
      const pose = frame.getJointPose?.(this.joints[i], space);
      if (pose) {
        this.handMatrices.set(pose.transform.matrix, i * 16);
        this.handTracked[i] = 1;
      }
    }
  }
}
