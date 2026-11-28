import {Figure,dataToScene} from '@margoengine/sciviz';
import {molecule} from '@margoengine/sciviz/molecule';
import {atomScale,bondRadius,position} from './structure.mjs';

export function mountSpecimen(engine,sample) {
  const figure=Figure.attach(engine,{
    axes:false,limits:sample.limits,aspect:sample.aspect,legend:false,tooltips:false,
  });
  const focus=position(dataToScene(sample.limits,sample.aspect),sample.center);
  return {
    figure,focus,
    layer(index,style) {
      const close=index===2;
      return molecule(figure,sample.molecule,{
        style,atomScale:close?.31:atomScale,bondRadius:close?.18:bondRadius,
        atomIndices:close?sample.chromophore:undefined,
      });
    },
  };
}
