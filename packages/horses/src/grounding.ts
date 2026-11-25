import { fitHorseHooves, poseHooves, type HorsePose, type HorseSkeleton } from './model.js';

type PathFrame = { x: number; z: number; heading: number };
type Point = [number, number];
type Plant = { anchor?: Point; release?: { time: number; offset: Point } };

const smooth = (u: number) => {
  const t = Math.min(1, Math.max(0, u));
  return t * t * (3 - 2 * t);
};
const slope = (rise: number, span: number) => Math.min(0.45, Math.max(-0.45, Math.atan2(rise, span)));
const releaseWeight = (time: number, from: number) => 1 - smooth((time - from) / 0.18);

/** Evaluates the four contact points in world space and remembers plants between fixed steps. */
export function horseGrounding(skeleton: HorseSkeleton, ground: (x: number, z: number) => number) {
  const plants: Plant[] = skeleton.legs.map(() => ({}));
  const headingAxes = (frame: PathFrame) => [Math.cos(frame.heading), Math.sin(frame.heading)] as const;
  const toWorld = (frame: PathFrame, x: number, z: number): Point => {
    const [c, s] = headingAxes(frame);
    return [frame.x + c * x + s * z, frame.z - s * x + c * z];
  };
  const withers = skeleton.body.withers;
  const hoofRadius = withers * 0.039;
  const longitudinal = skeleton.body.bodyLength * 0.4;
  const lateral = Math.max(skeleton.body.chestWidth, skeleton.body.hipWidth) * 0.55;
  const sample = (frame: PathFrame, x: number, z: number) => ground(...toWorld(frame, x, z));

  const advance = (frame: PathFrame, time: number, support: readonly boolean[], readPose: () => HorsePose) => {
    const changing = plants.some((plant, i) => Boolean(plant.anchor) !== support[i]);
    if (!changing) return;
    const pads = poseHooves(skeleton, readPose());
    plants.forEach((plant, i) => {
      const stance = support[i];
      if (Boolean(plant.anchor) === stance) return;
      const pad = pads[i]!,
        current = toWorld(frame, pad[0], pad[2]);
      if (stance) {
        // A gait may change while a liftoff is still easing. Replant the position the viewer saw.
        if (plant.release) {
          const weight = releaseWeight(time, plant.release.time);
          current[0] += plant.release.offset[0] * weight;
          current[1] += plant.release.offset[1] * weight;
        }
        plant.anchor = current;
        plant.release = undefined;
      } else if (plant.anchor) {
        plant.release = { time, offset: [plant.anchor[0] - current[0], plant.anchor[1] - current[1]] };
        plant.anchor = undefined;
      }
    });
  };

  const fit = (frame: PathFrame, rootHeight: number, time: number, pose: HorsePose): HorsePose => {
    const [c, s] = headingAxes(frame);
    // Sample at the fore and hind limb frames. Their fixed offsets prevent the back from bobbing with foothold switches.
    const fore = sample(frame, 0, longitudinal),
      hind = sample(frame, 0, -longitudinal),
      left = sample(frame, lateral, 0),
      right = sample(frame, -lateral, 0);
    const pitch = slope(hind - fore, 2 * longitudinal),
      roll = slope(left - right, 2 * lateral),
      bodyShift = (fore + hind + left + right) / 4 - rootHeight;
    const targets = poseHooves(skeleton, pose).map(([x, y, z], i) => {
      const pad = toWorld(frame, x, z),
        { anchor, release } = plants[i]!;
      if (anchor) {
        pad[0] = anchor[0];
        pad[1] = anchor[1];
      } else if (release) {
        const ease = releaseWeight(time, release.time);
        pad[0] += release.offset[0] * ease;
        pad[1] += release.offset[1] * ease;
      }
      const dx = pad[0] - frame.x,
        dz = pad[1] - frame.z;
      const pivot = { x: pad[0], z: pad[1], heading: frame.heading };
      // The art rig's existing lift and toe breakover stay above the surface, in metres.
      const groundY = ground(...pad);
      return {
        point: [c * dx - s * dz, groundY - rootHeight + Math.max(0, y), s * dx + c * dz] as [number, number, number],
        pitch: slope(sample(pivot, 0, -hoofRadius) - sample(pivot, 0, hoofRadius), 2 * hoofRadius),
        roll: slope(sample(pivot, hoofRadius, 0) - sample(pivot, -hoofRadius, 0), 2 * hoofRadius),
      };
    });
    const [x, y, z] = pose.bodyOffset;
    return fitHorseHooves(skeleton, { ...pose, bodyOffset: [x, y + bodyShift, z] }, targets, pitch, roll);
  };
  return {
    advance,
    fit,
    reset() {
      for (const plant of plants) plant.anchor = plant.release = undefined;
    },
  };
}
