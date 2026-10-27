import { Stage, createStage, Geometry } from 'margoengine';
import { Geometry as DirectGeometry } from '@margoengine/core';
import { addGLTF } from 'margoengine/stage/gltf';
import { addCAD } from 'margoengine/stage/cad';
import { addSky } from 'margoengine/stage/sky';
import { addParticles } from 'margoengine/stage/particles';
import { addEffects } from 'margoengine/stage/effects';
import { addEnvironment } from 'margoengine/stage/environment';
import { addShadows } from 'margoengine/stage/shadows';

// Observable exports retain the real facade and every stage feature entry (each imports its package on call).
globalThis.modularStage = {
  Stage,
  createStage,
  Geometry,
  DirectGeometry,
  features: { addGLTF, addCAD, addSky, addParticles, addEffects, addEnvironment, addShadows },
};
