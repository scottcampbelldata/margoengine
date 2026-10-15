import { Stage, createStage, Geometry } from 'margoengine';
import { Geometry as DirectGeometry } from '@margoengine/core';

// Observable exports retain the real facade and its lazy methods in an app build.
globalThis.modularStage = { Stage, createStage, Geometry, DirectGeometry };
