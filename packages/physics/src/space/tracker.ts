import type { Vec3 } from '@margoengine/core';
import { cos, sin } from '@margoengine/math/pinned';

import { atan2, magnitude } from './angles.js';
import { celestialError } from './errors.js';

/** Options for a row of parallel single-axis trackers. All angles are radians. */
export interface TrackerOptions {
  /** Shaft direction clockwise from north. Defaults to north. */
  readonly axisAzimuth?: number;
  /** Shaft tilt down toward its azimuth, per the NREL convention. Defaults to horizontal. */
  readonly axisTilt?: number;
  /** Right-hand cross-axis rotation about the shaft. For a horizontal north-pointing shaft, positive slopes down toward east. Defaults to zero. */
  readonly crossAxisSlope?: number;
  /** Collector width divided by horizontal axis-to-axis spacing. Defaults to 0.4. */
  readonly groundCoverageRatio?: number;
  /** Plan the rotation to avoid shading an identical adjacent row. Defaults to true. */
  readonly backtrack?: boolean;
  /** Negative and positive travel limits. Defaults to ±π/2. */
  readonly range?: readonly [number, number];
  /** Physical rotation bias for the individual rack. Defaults to zero. */
  readonly rotationOffset?: number;
  /** Current wind speed, m/s. Defaults to zero. */
  readonly windSpeed?: number;
  /** Wind speed in m/s at which to stow. Omit to leave wind stow disabled. */
  readonly stowAt?: number;
  /** Rotation at night or during wind stow. Defaults to zero. */
  readonly stowAngle?: number;
}

/** A tracker command, its resulting physical angle, and shading from the neighboring row. */
export interface TrackerSample {
  readonly mode: 'track' | 'backtrack' | 'wind-stow' | 'night-stow';
  /** Rotation that would maximize direct sun exposure in an isolated row. */
  readonly trueRotation: number;
  /** Actuator command within its travel limits. */
  readonly command: number;
  /** Physical rotation after the row's zero offset and travel limits. */
  readonly rotation: number;
  /** Fraction of module area blocked by the adjacent row at the physical rotation. */
  readonly shadedFraction: number;
}

/** Compute sun following, slope-aware backtracking and row shading from an east–north–up solar direction. */
export function trackSolarRow(sun: Vec3, options: TrackerOptions = {}): TrackerSample {
  const {
    axisAzimuth = 0,
    axisTilt = 0,
    crossAxisSlope = 0,
    groundCoverageRatio = 0.4,
    backtrack = true,
    range = [-Math.PI / 2, Math.PI / 2],
    rotationOffset = 0,
    windSpeed = 0,
    stowAt = Infinity,
    stowAngle = 0,
  } = options;
  if (
    ![
      ...sun,
      axisAzimuth,
      axisTilt,
      crossAxisSlope,
      groundCoverageRatio,
      rotationOffset,
      windSpeed,
      stowAngle,
      ...range,
    ].every(Number.isFinite) ||
    !(magnitude(sun) > 0) ||
    range[0] > range[1] ||
    windSpeed < 0 ||
    !(stowAt > 0) ||
    !(groundCoverageRatio > 0 && groundCoverageRatio <= 1) ||
    Math.abs(axisTilt) >= Math.PI / 2 ||
    Math.abs(crossAxisSlope) >= Math.PI / 2
  )
    throw celestialError(
      'Pass a finite solar direction and valid tracker limits, slopes, row spacing and wind speeds.',
    );

  // Anderson and Mikofski (2020), equations 4, 5 and 14–16.
  const azimuth = axisAzimuth % (2 * Math.PI);
  const east = cos(azimuth);
  const north = sin(azimuth);
  const x = sun[0] * east - sun[1] * north;
  const z = (sun[0] * north + sun[1] * east) * sin(axisTilt) + sun[2] * cos(axisTilt);
  const trueRotation = atan2(x, z);
  const rowGap = Math.abs(cos(trueRotation - crossAxisSlope)) / (groundCoverageRatio * cos(crossAxisSlope));
  let mode: TrackerSample['mode'] = 'track';
  let desired = trueRotation;
  if (windSpeed >= stowAt || sun[2] <= 0) {
    mode = windSpeed >= stowAt ? 'wind-stow' : 'night-stow';
    desired = stowAngle;
  } else if (backtrack && rowGap < 1) {
    mode = 'backtrack';
    const correction = atan2(Math.sqrt((1 - rowGap) * (1 + rowGap)), rowGap);
    desired -= Math.sign(trueRotation) * correction;
  }
  const clamp = (angle: number) => Math.max(range[0], Math.min(range[1], angle));
  const command = clamp(desired);
  const rotation = clamp(command + rotationOffset);

  // Equation 32 written in projected widths, without a tangent at the horizon.
  const projected = Math.abs(cos(rotation - trueRotation));
  const shadedFraction = sun[2] > 0 && projected > 0 ? Math.max(0, (projected - rowGap) / projected) : 0;
  return { mode, trueRotation, command, rotation, shadedFraction };
}
