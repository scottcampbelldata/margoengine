export const carrierRpm = 60;
export const sideTeeth = 20;
export const pinionTeeth = 14;
const halfTrack = .77;
const tightestRadius = 2.25;

export function speeds(steering) {
  const curvature = steering / (100 * tightestRadius);
  const offset = carrierRpm * halfTrack * curvature;
  return {
    left: carrierRpm + offset,
    right: carrierRpm - offset,
    spider: offset * sideTeeth / pinionTeeth,
  };
}
export function gearPose(carrier, sideOffset) {
  return {
    carrier,
    left: carrier + sideOffset,
    right: carrier - sideOffset,
    // The even tooth counts give every opposed contact the same assembly phase.
    // Advance both pinions by half a tooth so a crest always meets a gap.
    pinions: (sideOffset * sideTeeth + Math.PI) / pinionTeeth,
  };
}
