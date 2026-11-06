import { Stage, createStage, Geometry } from 'margoengine';
import { Geometry as DirectGeometry } from '@margoengine/core';
import { addGLTF } from 'margoengine/stage/gltf';
import { addSky } from 'margoengine/stage/sky';
import { addParticles } from 'margoengine/stage/particles';
import { addEffects } from 'margoengine/stage/effects';
import { addEnvironment } from 'margoengine/stage/environment';
import { addShadows } from 'margoengine/stage/shadows';
import { addXRButton } from 'margoengine/stage/xr';

// Observable exports retain the real facade and every stage feature entry (each imports its package on call).
globalThis.modularStage = {
  Stage,
  createStage,
  Geometry,
  DirectGeometry,
  features: { addGLTF, addSky, addParticles, addEffects, addEnvironment, addShadows, addXRButton },
};
