// The real ANGLE back ends of each platform, with the WebGL renderer string each must report. Forcing a back end the
// platform does not have (d3d11 on macOS) makes Chromium fall back to SwiftShader, which openBrowser refuses, so each
// platform names its own (lane L, 2026-11-10).
export const ANGLE_BACKENDS = {
  win32: [
    ['d3d11', /Direct3D11/],
    ['vulkan', /Vulkan/],
  ],
  darwin: [['metal', /Metal/]],
  linux: [
    ['vulkan', /Vulkan/],
    ['gl', /OpenGL/],
  ],
};
