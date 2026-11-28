// This demo's mechanism: its dimensions, and its pose from @margoengine/machinery/mechanisms.
import { archimedesScrew, archimedesScrewPose } from '@margoengine/machinery/mechanisms';

export const tau = 2*Math.PI;
export const degrees = 26;
export const incline = degrees*Math.PI/180;
export const vertical = Math.sin(incline);
export const across = Math.cos(incline);
export const pitch = .348;
export const run = 1.43;
export const shellRadius = .175;
export const shaftRadius = .061;
/** The water stands 2.8 mm below the spill line, so it never sheets over the blade's inner edge. */
const screw = archimedesScrew({pitch, outerRadius: shellRadius, innerRadius: shaftRadius, incline, length: run, freeboard: .0028});
export const phaseRate = (rpm) => rpm*tau/60;
export const lift = screw.lift;
export const risePerTurn = screw.risePerTurn;
export const lead = screw.lead;
export const fillLevel = screw.fillLevel;
export const wetSection = screw.wetSection;
export const litersPerTurn = 1000*screw.volumePerTurn;
export const read = (speed) => {
  const rpm=Math.max(0,Math.min(55,speed));
  return {rpm,litersPerMinute:litersPerTurn*rpm,travel:screw.flow(rpm).axialSpeed};
};
export const phaseInTurn = (angle) => archimedesScrewPose(angle,pitch).phase;
