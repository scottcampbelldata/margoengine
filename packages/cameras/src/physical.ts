import { lensToFov } from './index.js';

/** Settings of a {@link PhysicalCamera}. The defaults match `DOF` (50 mm, f/2.8, focus at 5) and `MotionBlur` (180 degrees at 60 fps). */
export interface PhysicalOptions {
  /** Lens focal length in millimetres. Default 50. */
  focalLength?: number;
  /** F-number N (the aperture diameter is focalLength / N). Default 2.8. */
  aperture?: number;
  /** Exposure time in seconds. Default 1/120, a 180 degree shutter at 60 fps. */
  shutter?: number;
  /** Sensor sensitivity. Default 100. */
  iso?: number;
  /** Distance to the plane of focus in scene units (metres). Default 5. */
  focusDistance?: number;
  /** Sensor size in millimetres along its long side. Default 36. */
  filmGauge?: number;
  /** Frames per second, to turn the shutter time into a share of the frame interval. Default 60. */
  frameRate?: number;
  /** The exposure value (EV at ISO 100) that renders as 0 stops. Default: that of the default settings, so an unchanged scene looks as before. */
  referenceEV?: number;
}

/** What `depthOfField` returns: distances in scene units; `far` is Infinity when the focus is at or beyond the hyperfocal distance. */
export interface DepthOfField {
  hyperfocal: number;
  near: number;
  far: number;
}

/** Things `PhysicalCamera.apply` writes to. Each is optional and only touched when given. */
export interface PhysicalTargets {
  /** A `DOF` effect: gets `focalDistance`, `focalLength` (metres) and `aperture`. */
  dof?: { options: { focalDistance?: number; focalLength?: number; aperture?: number } };
  /** A `MotionBlur` effect: gets `shutter`, the share of the frame interval. */
  motionBlur?: { options: { shutter?: number } };
  /** Anything with an `exposure` option in stops: `Tonemap`, `Bloom`, `PostStack`. */
  exposure?: { options: { exposure?: number } };
  /** A core camera: gets `fov` for `aspect`. */
  camera?: { fov: number };
  /** A `CameraProjection`: gets `focalLength` and `filmGauge`, so it also follows the lens through `fit`. */
  projection?: { focalLength?: number; filmGauge?: number };
  /** Width / height of the view, for the field of view. Default 16 / 9. */
  aspect?: number;
}

const DEFAULTS = {
  focalLength: 50,
  aperture: 2.8,
  shutter: 1 / 120,
  iso: 100,
  focusDistance: 5,
  filmGauge: 36,
  frameRate: 60,
};

/** Exposure value at ISO 100 of an f-number, exposure time and ISO: log2(N² / t) − log2(ISO / 100). A stop is 1. */
export function ev100(aperture: number, shutter: number, iso = 100): number {
  if (![aperture, shutter, iso].every((v) => v > 0 && v < Infinity))
    throw new RangeError('Invalid physical camera; pass an aperture, shutter time and ISO that are finite and above 0');
  return Math.log2((aperture * aperture) / shutter) - Math.log2(iso / 100);
}

/**
 * A camera described the way photographers do: focal length, aperture, shutter time and ISO. The three drive one
 * picture together: the exposure, the depth of field and the motion blur all follow from the same numbers. `apply`
 * writes them to the effects you use; the getters give the numbers for your own.
 */
export class PhysicalCamera implements Required<PhysicalOptions> {
  focalLength: number;
  aperture: number;
  shutter: number;
  iso: number;
  focusDistance: number;
  filmGauge: number;
  frameRate: number;
  referenceEV: number;
  constructor(options: PhysicalOptions = {}) {
    const o = { ...DEFAULTS, ...options };
    this.focalLength = o.focalLength;
    this.aperture = o.aperture;
    this.shutter = o.shutter;
    this.iso = o.iso;
    this.focusDistance = o.focusDistance;
    this.filmGauge = o.filmGauge;
    this.frameRate = o.frameRate;
    this.referenceEV = options.referenceEV ?? ev100(DEFAULTS.aperture, DEFAULTS.shutter, DEFAULTS.iso);
    this.check();
  }
  /** Exposure value at ISO 100: lower is brighter. */
  get ev100(): number {
    this.check();
    return ev100(this.aperture, this.shutter, this.iso);
  }
  /** Exposure in stops relative to `referenceEV`: a stop wider aperture, a doubled shutter time or a doubled ISO each add 1. */
  get exposure(): number {
    return this.referenceEV - this.ev100;
  }
  /** `2 ** exposure`: the factor to multiply scene light by. */
  get exposureScale(): number {
    return 2 ** this.exposure;
  }
  /** The shutter time as a share of the frame interval, 0 to 1 (`MotionBlur.shutter`); a longer exposure than a frame is a full frame. */
  get shutterFraction(): number {
    this.check();
    return Math.min(1, this.shutter * this.frameRate);
  }
  /** The shutter as the angle of a rotary shutter, 0 to 360 degrees. */
  get shutterAngle(): number {
    return this.shutterFraction * 360;
  }
  /** Vertical field of view in degrees for a view of `aspect` (width / height). */
  fov(aspect: number): number {
    this.check();
    return lensToFov(this.focalLength, aspect, { filmGauge: this.filmGauge });
  }
  /**
   * The range that is acceptably sharp, for a circle of confusion `coc` mm on the sensor (default `filmGauge / 1500`,
   * 0.024 mm on 36 mm): the hyperfocal distance, and the nearest and farthest sharp distances for the focus distance.
   */
  depthOfField(coc = this.filmGauge / 1500): DepthOfField {
    this.check();
    if (!(coc > 0 && coc < Infinity))
      throw new RangeError('Invalid physical camera; pass a circle of confusion above 0');
    const f = this.focalLength / 1000,
      c = coc / 1000,
      s = this.focusDistance,
      hyperfocal = (f * f) / (this.aperture * c) + f;
    return {
      hyperfocal,
      near: (s * (hyperfocal - f)) / (hyperfocal + s - 2 * f),
      far: s >= hyperfocal ? Infinity : (s * (hyperfocal - f)) / (hyperfocal - s),
    };
  }
  /** Diameter in millimetres of the blur disc on the sensor for a point at `distance`; 0 at the focus distance. */
  blurDiameter(distance: number): number {
    this.check();
    if (!(distance > 0)) throw new RangeError('Invalid physical camera; pass a distance above 0');
    const f = this.focalLength / 1000,
      s = this.focusDistance;
    return ((f * f) / (this.aperture * (s - f))) * (Math.abs(distance - s) / distance) * 1000;
  }
  /** Writes the camera to the effects and camera given; the same numbers reach each. */
  apply({ dof, motionBlur, exposure, camera, projection, aspect = 16 / 9 }: PhysicalTargets): void {
    this.check();
    if (dof) {
      dof.options.focalDistance = this.focusDistance;
      dof.options.focalLength = this.focalLength / 1000;
      dof.options.aperture = this.aperture;
    }
    if (motionBlur) motionBlur.options.shutter = this.shutterFraction;
    if (exposure) exposure.options.exposure = this.exposure;
    if (camera) camera.fov = this.fov(aspect);
    if (projection) {
      projection.focalLength = this.focalLength;
      projection.filmGauge = this.filmGauge;
    }
  }
  private check(): void {
    const values = [
      this.focalLength,
      this.aperture,
      this.shutter,
      this.iso,
      this.focusDistance,
      this.filmGauge,
      this.frameRate,
    ];
    if (!values.every((v) => v > 0 && v < Infinity) || !Number.isFinite(this.referenceEV))
      throw new RangeError(
        'Invalid physical camera; focal length, aperture, shutter, ISO, focus distance, film gauge and frame rate must be finite and above 0',
      );
    if (this.focusDistance <= this.focalLength / 1000)
      throw new RangeError('Invalid physical camera; the focus distance must be beyond the focal length');
  }
}
