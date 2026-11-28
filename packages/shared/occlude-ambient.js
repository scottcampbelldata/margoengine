/**
 * Multiplies every ambient term of core's lit fragment code by the WGSL expression `factor`: core's flat term, a
 * hemisphere light's in its place and the sky's (`margoAmbient`, which replaces the flat term when a Sky lights the
 * scene). Pass the fragment body, not the declarations. A patch that dims only `frame.ambient` leaves a Sky-lit scene
 * as bright as before (KB-SCATTER-SKYAO1).
 */
export const occludeAmbient = (code, factor) =>
  code
    .replaceAll('frame.ambient.rgb', `(frame.ambient.rgb*${factor})`)
    .replace(/\+margoAmbient\b/g, `+margoAmbient*${factor}`)
    .replace(/\*margoSkyLight\(n\)/g, `*margoSkyLight(n)*${factor}`);
