import type { CameraPose, StageContext } from './brain.js';

/** Physical settings shared by the camera projection and depth of field. */
export interface PhysicalLensOptions {
  /** Focal length in millimetres. Default 50. */
  focalLength?: number;
  /** Sensor size in millimetres on `sensorFit`'s axis. Default 36. */
  filmGauge?: number;
  /** Sensor axis; auto fits the longer image side. Default 'auto'. */
  sensorFit?: 'auto' | 'horizontal' | 'vertical';
  /** F-number, focal length divided by aperture diameter. Default 2.8. */
  fStop?: number;
  /** Focus distance in metres, beyond the focal length. Default 5. */
  focusDistance?: number;
}

/** Outputs of {@link PhysicalLens.apply}; omitted targets are left alone. */
export interface PhysicalLensTargets {
  /** Camera to receive the vertical field of view. */
  camera?: { fov: number };
  /** DOF effect; sensor fit, focal length, aperture and focus are kept coherent. */
  dof?: {
    options: {
      focalLength?: number;
      filmGauge?: number;
      sensorFit?: 'auto' | 'horizontal' | 'vertical';
      aperture?: number;
      focalDistance?: number;
    };
  };
  /** View width divided by height. Default 16/9. */
  aspect?: number;
  /** Override focus, for example with a blended pose's focusDistance. Default the lens's focusDistance. */
  focusDistance?: number;
}

const help = 'https://margoengine.com/docs/limits#cinematic-physical-lens';

/**
 * A physical lens stage: millimetres and f-number drive both FOV and DOF. Put it in `brain.stages` after focus tracking,
 * then use `apply` to send its settings to DOF. The lens has no effect on exposure or shutter time.
 */
export class PhysicalLens implements Required<PhysicalLensOptions> {
  focalLength: number;
  filmGauge: number;
  sensorFit: 'auto' | 'horizontal' | 'vertical';
  fStop: number;
  focusDistance: number;
  /** @throws RangeError for nonphysical settings; see {@link PhysicalLensOptions}. */
  constructor({ focalLength = 50, filmGauge = 36, sensorFit = 'auto', fStop = 2.8, focusDistance = 5 }: PhysicalLensOptions = {}) {
    this.focalLength = focalLength;
    this.filmGauge = filmGauge;
    this.sensorFit = sensorFit;
    this.fStop = fStop;
    this.focusDistance = focusDistance;
    this.check(16 / 9, focusDistance);
  }
  private check(aspect: number, focus: number): void {
    if (
      ![this.focalLength, this.filmGauge, this.fStop, focus, aspect].every((v) => v > 0 && Number.isFinite(v)) ||
      focus <= this.focalLength / 1000 ||
      !['auto', 'horizontal', 'vertical'].includes(this.sensorFit)
    )
      throw new RangeError(`Invalid physical lens; use positive finite settings, a valid sensorFit and focus beyond focal length. ${help}`);
  }
  /** Vertical FOV in degrees for this sensor and view. @throws RangeError for invalid mutable settings or aspect. */
  fov(aspect = 16 / 9): number {
    this.check(aspect, this.focusDistance);
    const horizontal = this.sensorFit === 'horizontal' || (this.sensorFit === 'auto' && aspect >= 1);
    return (360 / Math.PI) * Math.atan(this.filmGauge / (2 * this.focalLength) / (horizontal ? aspect : 1));
  }
  /**
   * Write FOV and focus to a pose, preserving focus set by an earlier tracker.
   * @throws RangeError for invalid mutable settings, aspect or tracked focus.
   */
  update(pose: CameraPose, _delta: number, { aspect }: StageContext): void {
    const focus = pose.focusDistance || this.focusDistance;
    this.check(aspect, focus);
    pose.fov = this.fov(aspect);
    pose.focusDistance = focus;
  }
  /**
   * Write coherent settings to the actual camera and DOF effect. Call after the brain updates when using tracked focus.
   * @throws RangeError for invalid mutable settings, aspect or focus; outputs are unchanged on error.
   */
  apply({ camera, dof, aspect = 16 / 9, focusDistance = this.focusDistance }: PhysicalLensTargets): void {
    this.check(aspect, focusDistance);
    const fov = this.fov(aspect);
    if (camera) camera.fov = fov;
    if (dof) {
      dof.options.focalLength = this.focalLength / 1000;
      dof.options.filmGauge = this.filmGauge;
      dof.options.sensorFit = this.sensorFit;
      dof.options.aperture = this.fStop;
      dof.options.focalDistance = focusDistance;
    }
  }
}
