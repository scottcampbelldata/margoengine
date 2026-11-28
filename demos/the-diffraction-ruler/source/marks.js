import { OpticsScreens } from '@margoengine/optics/screens';

// Each diffraction order lands as a glowing spot: a bright core over a wider bloom, in the laser's colour.
const spot={edge:[.12,.9,.33],core:[.97,.97,.97],coreMix:.73,colorFalloff:22,
  innerFalloff:22,innerWeight:.80,outerFalloff:4.7,outerWeight:.64,fade:.67};

export function attachMarks(engine, anchors) {
  const screens = OpticsScreens.attach(engine, { blending: 'additive' });
  const parts = anchors.map((mesh) => screens.spot(mesh, .033, .033, spot));
  return {
    ready: () => screens.ready(),
    update(color) { for (const part of parts) part.set({ edge: color }); },
    marks: parts.map((part) => part.mesh),
  };
}
