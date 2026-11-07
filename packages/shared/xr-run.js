// The record of one XR session on one device, shared by @margoengine/xr/device-check, which writes it, and
// scripts/check-xr-runs.mjs, which decides what the records in docs/xr-device-runs prove.
export const XR_RUN_TARGETS = [
  {
    id: 'vr-webgpu',
    mode: 'immersive-vr',
    route: 'webgpu',
    needs: "a VR headset whose browser has WebXR's WebGPU binding (XRGPUBinding)",
  },
  { id: 'vr-webgl2', mode: 'immersive-vr', route: 'webgl2', needs: 'a VR headset whose browser has WebXR on WebGL2' },
  {
    id: 'ar-webgpu',
    mode: 'immersive-ar',
    route: 'webgpu',
    needs: "an AR phone or headset whose browser has WebXR's WebGPU binding (XRGPUBinding)",
  },
  { id: 'ar-webgl2', mode: 'immersive-ar', route: 'webgl2', needs: 'an AR phone or headset with WebXR on WebGL2' },
];
export const XR_RUN_MIN_FRAMES = 300;

const text = (value) => typeof value === 'string' && value.length > 0,
  count = (value) => Number.isInteger(value) && value >= 0,
  time = (value) => Number.isFinite(value) && value >= 0;

export function checkXRRun(run) {
  if (typeof run !== 'object' || run === null) return ['the run is not an object'];
  const problems = [],
    need = (ok, field) => {
      if (!ok) problems.push(`${field} is missing or wrong`);
    };
  need(run.schema === 1, 'schema');
  need(text(run.date) && !Number.isNaN(Date.parse(run.date)), 'date');
  need(text(run.userAgent), 'userAgent');
  need(typeof run.native === 'boolean', 'native');
  need(['inline', 'immersive-vr', 'immersive-ar'].includes(run.mode), 'mode');
  need(['webgpu', 'webgl2', 'none'].includes(run.route), 'route');
  need(Array.isArray(run.features) && run.features.every(text), 'features');
  for (const field of ['views', 'frames', 'tracked', 'emulated']) need(count(run[field]), field);
  need(run.tracked <= run.frames && run.emulated <= run.tracked, 'tracked');
  for (const field of ['median', 'p95', 'max']) need(time(run.frameMs?.[field]), `frameMs.${field}`);
  need(
    Array.isArray(run.inputs) &&
      run.inputs.every(
        (input) =>
          text(input?.handedness) &&
          text(input.targetRayMode) &&
          Array.isArray(input.profiles) &&
          typeof input.hand === 'boolean' &&
          count(input.buttons) &&
          count(input.axes),
      ),
    'inputs',
  );
  need(typeof run.endedEarly === 'boolean', 'endedEarly');
  need(Array.isArray(run.errors) && run.errors.every((error) => typeof error === 'string'), 'errors');
  if (run.observed !== undefined)
    for (const field of ['scene', 'tracking', 'input', 'exit'])
      need(typeof run.observed?.[field] === 'boolean', `observed.${field}`);
  return problems;
}

export function xrRunGaps(run, target) {
  const gaps = [],
    gap = (ok, reason) => {
      if (!ok) gaps.push(reason);
    };
  gap(run.native, 'navigator.xr was a stand-in, not the browser');
  gap(run.mode === target.mode, `the mode was ${run.mode}, not ${target.mode}`);
  gap(run.route === target.route, `the route was ${run.route}, not ${target.route}`);
  gap(run.tracked >= XR_RUN_MIN_FRAMES, `only ${run.tracked} tracked frames, under ${XR_RUN_MIN_FRAMES}`);
  gap(run.views >= (target.mode === 'immersive-vr' ? 2 : 1), `only ${run.views} views`);
  gap(!run.errors.length, `${run.errors.length} errors`);
  gap(!run.endedEarly, 'the session ended early');
  gap(run.inputs.length > 0, 'no input source was seen');
  for (const field of ['scene', 'tracking', 'input', 'exit'])
    gap(run.observed?.[field] === true, `the tester did not confirm ${field}`);
  return gaps;
}
