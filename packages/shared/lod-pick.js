// Discrete level-of-detail choice with a dead band around each switch point (a Schmitt trigger), shared by every
// selector so they all switch alike. Numbers in, a number out, nothing allocated.
export function pickLevel(thresholds, bands, base, count, shown, value) {
  // The plain pick is the coarsest level whose threshold the value has reached (equality counts). Going coarser is
  // never delayed; going finer from the shown level s waits until the value drops below s's threshold lowered by its
  // own band, t_s * (1 - h_s). While the value is inside that band, s holds even when the band reaches past finer
  // thresholds.
  let next = 0;
  while (next + 1 < count && value >= thresholds[base + next + 1]) next++;
  if (next < shown && value >= thresholds[base + shown] * (1 - bands[base + shown])) next = shown;
  return next;
}
