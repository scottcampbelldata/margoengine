import '@kitware/vtk.js/Rendering/Profiles/Volume';
import '@kitware/vtk.js/Rendering/Profiles/Geometry';
import vtkFullScreenRenderWindow from '@kitware/vtk.js/Rendering/Misc/FullScreenRenderWindow';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction';
import vtkPiecewiseFunction from '@kitware/vtk.js/Common/DataModel/PiecewiseFunction';
import vtkVolume from '@kitware/vtk.js/Rendering/Core/Volume';
import vtkVolumeMapper from '@kitware/vtk.js/Rendering/Core/VolumeMapper';
import vtkImageMarchingCubes from '@kitware/vtk.js/Filters/General/ImageMarchingCubes';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import { colormap } from '@margoengine/sciviz/colormaps';
import { streamline } from '@margoengine/sciviz/maths';
import { copyCanvas, SIZE } from './margo.mjs';

export async function vtkRenderer(host, data, signal) {
  const full = vtkFullScreenRenderWindow.newInstance({
    container: host,
    background: [15 / 255, 20 / 255, 28 / 255],
    containerStyle: { position: 'relative', width: `${SIZE}px`, height: `${SIZE}px` },
  });
  try {
    const renderer = full.getRenderer(),
      renderWindow = full.getRenderWindow();
    const camera = renderer.getActiveCamera();
    camera.setPositionAndFocalPoint([2.6, 1.7, 2.9], [0, 0, 0]);
    camera.setViewUp(0, 1, 0);
    camera.setViewAngle(60);
    camera.setClippingRange(0.01, 100);
    let vertices = 0,
      triangles = 0,
      lines = 0;
    if (data.id === 'volume' || data.id === 'isosurface') {
      const n = data.scale,
        image = vtkImageData.newInstance();
      image.setDimensions(n, n, n);
      image.setSpacing(2 / (n - 1), 2 / (n - 1), 2 / (n - 1));
      image.setDirection(1, 0, 0, 0, 0, -1, 0, 1, 0);
      image.setOrigin(-1, -1, 1);
      image
        .getPointData()
        .setScalars(vtkDataArray.newInstance({ name: 'scalars', values: data.values.slice(), numberOfComponents: 1 }));
      if (data.id === 'volume') {
        const actor = vtkVolume.newInstance(),
          mapper = vtkVolumeMapper.newInstance();
        mapper.setInputData(image);
        mapper.setSampleDistance(2 / (n * 1.5));
        mapper.setAutoAdjustSampleDistances(false);
        const colors = vtkColorTransferFunction.newInstance(),
          opacity = vtkPiecewiseFunction.newInstance(),
          map = colormap('aurora');
        for (let i = 0; i < 256; i++) {
          const t = i / 255,
            rgb = map.sample(t);
          colors.addRGBPoint(t, rgb[0], rgb[1], rgb[2]);
          opacity.addPoint(t, t * t);
        }
        actor.setMapper(mapper);
        actor.getProperty().setRGBTransferFunction(0, colors);
        actor.getProperty().setScalarOpacity(0, opacity);
        actor.getProperty().setScalarOpacityUnitDistance(0, 2 / n);
        actor.getProperty().setInterpolationTypeToLinear();
        actor.getProperty().setShade(false);
        renderer.addVolume(actor);
      } else {
        const contour = vtkImageMarchingCubes.newInstance({
          contourValue: 0.5,
          computeNormals: true,
          mergePoints: true,
        });
        contour.setInputData(image);
        contour.update();
        const mesh = contour.getOutputData();
        vertices = mesh.getPoints().getNumberOfPoints();
        triangles = mesh.getPolys().getNumberOfCells();
        const mapper = vtkMapper.newInstance(),
          actor = vtkActor.newInstance();
        mapper.setInputData(mesh);
        mapper.setScalarVisibility(false);
        actor.setMapper(mapper);
        actor.getProperty().setColor(34 / 255, 203 / 255, 238 / 255);
        renderer.addActor(actor);
      }
    } else if (data.id === 'streamlines') {
      const positions = [],
        cells = [];
      // Shared NOAA/RK4 geometry: a frame rendering comparison, not an integrator speed comparison.
      for (let y = 0; y < data.scale; y++)
        for (let x = 0; x < data.scale; x++) {
          signal?.throwIfAborted();
          const path = streamline(
            data.field,
            [-1 + (2 * (x + 0.5)) / data.scale, -1 + (2 * (y + 0.5)) / data.scale, 0],
            { step: 0.01, maxSteps: 512, direction: 'both' },
          );
          if (path.speeds.length < 2) continue;
          const start = positions.length / 3,
            count = path.speeds.length;
          cells.push(count);
          for (let i = 0; i < count; i++) {
            positions.push(path.positions[3 * i], 0, -path.positions[3 * i + 1]);
            cells.push(start + i);
          }
          lines++;
        }
      const mesh = vtkPolyData.newInstance();
      mesh.getPoints().setData(Float32Array.from(positions), 3);
      mesh.getLines().setData(Uint32Array.from(cells));
      vertices = positions.length / 3;
      const mapper = vtkMapper.newInstance(),
        actor = vtkActor.newInstance();
      mapper.setInputData(mesh);
      mapper.setScalarVisibility(false);
      actor.setMapper(mapper);
      actor.getProperty().setColor(34 / 255, 203 / 255, 238 / 255);
      actor.getProperty().setLineWidth(1);
      renderer.addActor(actor);
      camera.setParallelProjection(true);
      camera.setParallelScale(1);
      camera.setPositionAndFocalPoint([0, 10, 0], [0, 0, 0]);
      camera.setViewUp(0, 0, -1);
    } else throw new RangeError(`No VTK scene ${data.id}`);
    renderer.resetCameraClippingRange();
    const canvas = host.querySelector('canvas');
    return {
      canvas,
      memory: () => ({
        gpuBytes: null,
        jsDataBytes: null,
        vertices,
        triangles,
        lines,
        reason: 'No public live GPU allocation inventory; mesh counts use public output APIs',
      }),
      async frame() {
        renderWindow.render();
        return copyCanvas(canvas);
      },
      dispose() {
        full.delete();
        host.replaceChildren();
      },
    };
  } catch (error) {
    full.delete();
    host.replaceChildren();
    throw error;
  }
}
