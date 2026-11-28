// The light a film's models reflect and take from around them (EnvironmentLighting). By default a workshop: a dim room
// with three soft panels, for films shot on the workshop set. An outdoor film passes `sky` instead, so wet and glossy
// surfaces reflect its own sky and ground and never the workshop's panels (KB-FILM-ENVPANELS1: Last Tram's wet wagon
// deck and drum tops showed the panels as pale grey-blue patches under an orange overcast).

/**
 * An outdoor sky as an equirectangular radiance map: `zenith` overhead blending to `horizon` at the skyline, then
 * `ground` below it (linear RGB). `glow` adds a broad brightening of the horizon toward azimuth `glow.azimuth`
 * (radians, like the workshop's panels), `glow.width` wide, for a city or a sunset low on one side.
 */
function skyPanorama(width, height, data, { zenith, horizon, ground, glow }) {
  for (let y = 0; y < height; y++) {
    const el = Math.PI * (0.5 - (y + 0.5) / height);
    for (let x = 0; x < width; x++) {
      const az = 2 * Math.PI * ((x + 0.5) / width - 0.5);
      const value = [0, 0, 0];
      if (el >= 0) {
        const f = Math.sin(el) ** 0.55;
        for (let i = 0; i < 3; i++) value[i] = horizon[i] + (zenith[i] - horizon[i]) * f;
        if (glow) {
          const d = Math.atan2(Math.sin(glow.azimuth - az), Math.cos(glow.azimuth - az));
          const g = Math.exp(-((d / glow.width) ** 2)) * Math.exp(-el * 4);
          for (let i = 0; i < 3; i++) value[i] += g * glow.color[i];
        }
      } else {
        const f = Math.min(1, -el * 6);
        for (let i = 0; i < 3; i++) value[i] = horizon[i] + (ground[i] - horizon[i]) * f;
      }
      data.set([...value, 1], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

export function panorama(night, sky) {
  const width = 512,
    height = 256;
  const data = new Float32Array(width * height * 4);
  if (sky) return skyPanorama(width, height, data, sky);
  const panels = night
    ? [
        [-0.48, 0.16, 0.26, 0.07, [1.9, 1.13, 0.62]],
        [1.5, 0.32, 0.47, 0.21, [0.27, 0.49, 0.84]],
        [-2.2, 0.18, 0.18, 0.15, [0.9, 0.62, 0.28]],
      ]
    : [
        [-0.86, 0.78, 0.62, 0.22, [5.8, 5.13, 4.34]],
        [1.16, 0.66, 0.44, 0.16, [3.0, 4, 5]],
        [-2.4, 0.34, 0.41, 0.13, [1.3, 1.57, 1.92]],
      ];
  for (let y = 0; y < height; y++) {
    const el = Math.PI * (0.5 - (y + 0.5) / height);
    for (let x = 0; x < width; x++) {
      const az = 2 * Math.PI * ((x + 0.5) / width - 0.5);
      const base = night ? 0.035 + 0.08 * Math.exp(-Math.abs(el) * 3) : 0.175 + 0.15 * Math.max(0, Math.sin(el));
      const value = night ? [base * 0.55, base * 0.75, base * 1.2] : [base * 0.94, base, base * 1.06];
      for (const [pa, pe, w, h, rgb] of panels) {
        const d = Math.atan2(Math.sin(pa - az), Math.cos(pa - az));
        const brightness = Math.exp(-2 * ((d / w) ** 4 + ((pe - el) / h) ** 4));
        for (let i = 0; i < 3; i++) value[i] += brightness * rgb[i];
      }
      data.set([...value, 1], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}
