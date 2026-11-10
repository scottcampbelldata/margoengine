import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Canvas, Mesh, BoxGeometry, PbrMaterial, type MeshRef } from '@margoengine/react';
import { engineRuntime } from '@margoengine/core/extension';
import { loadGLTF } from '@margoengine/gltf-pro';
import { clearcoat } from '@margoengine/materials';
import { Environment, EnvironmentLighting, loadEnvironmentImage } from '@margoengine/environment';
import { ContactShadows } from '@margoengine/staging';
import { PostStack } from '@margoengine/post/stack';
import { Tonemap } from '@margoengine/tonemap';
import { DOF } from '@margoengine/dof';
import { TAA } from '@margoengine/taa';
import { Selection } from '@margoengine/selection';
import { ViewCube } from '@margoengine/viewcube';
import { check, expose } from './harness.ts';

let reactMesh: MeshRef | null = null;
expose(
  'product',
  async (engine) => {
    const model = await loadGLTF(engine, '/examples/assets/khronos/ToyCar/ToyCar.glb');
    model.primitives[0].extension = clearcoat({ factor: 0.8, roughnessFactor: 0.1 });
    engine.camera.fitToBoundingBox(
      [model.bounds[0], model.bounds[1], model.bounds[2]],
      [model.bounds[3], model.bounds[4], model.bounds[5]],
    );
    const image = await loadEnvironmentImage('/examples/assets/skinning-ik-workshop.hdr');
    const environment = await Environment.attach(engine, image, {
      size: 16,
      specularSize: 16,
      samples: 32,
      brdfSize: 16,
      brdfSamples: 32,
    });
    const lighting = EnvironmentLighting.attach(engine, environment);
    lighting.add(model);
    const contact = ContactShadows.attach(engine, { opacity: 0.6, blur: 0.01, resolution: 64 });
    contact.fit(model.bounds);
    contact.add(model);
    const dof = new DOF({ focalDistance: 0.4, maxRadius: 2 });
    const tonemap = new Tonemap({ curve: 'neutral' });
    const stack = PostStack.attach(engine, [dof, tonemap]);
    const taa = TAA.attach(engine, { historyWeight: 0.9, depth: () => stack.depthTexture });
    const selection = Selection.attach(engine, { algorithm: 'jfa', width: 2, color: [1, 0.5, 0] });
    selection.set([model.primitives[0].node]);
    const cube = ViewCube.attach(engine, { size: 40 });
    return {
      ready: () => environment.device === engine.gpu,
      beforeSnapshot() {
        taa.reset();
      },
      assert() {
        check(
          reactMesh && [...engine.scene.meshes.values()].some((mesh) => mesh === reactMesh),
          'React mesh did not join the product scene',
        );
        check(model.primitives.length > 0 && model.primitives[0].extension, 'material extension missing');
        check(cube.element.isConnected, 'view cube missing');
        check(taa.velocity?.texture, 'TAA did not draw its velocity target');
        check(dof.outputTexture && stack.depthTexture, 'DOF stack targets missing');
        return { primitives: model.primitives.length, reactMesh: true, viewCube: true, taa: true, dof: true };
      },
      dispose() {
        cube.dispose();
        selection.dispose();
        taa.dispose();
        stack.dispose();
        contact.dispose();
        lighting.dispose();
        environment.dispose();
        model.dispose();
      },
      assertDisposed() {
        check(!cube.element.isConnected, 'view cube retained DOM');
      },
    };
  },
  async (placeholder, options) => {
    placeholder.remove();
    const host = document.createElement('div');
    host.style.cssText = 'width:256px;height:192px;position:relative';
    document.body.append(host);
    const root = createRoot(host);
    let resolveMesh!: () => void;
    const meshReady = new Promise<void>((resolve) => {
      resolveMesh = resolve;
    });
    const engine = await new Promise<ReturnType<typeof engineRuntime>>((resolve, reject) => {
      root.render(
        createElement(
          Canvas,
          {
            ...options,
            frameloop: 'demand',
            style: { width: 256, height: 192 },
            onCreated: (stage) => resolve(engineRuntime(stage.engine)),
            onError: reject,
          },
          createElement(
            Mesh,
            {
              position: [0.12, 0, 0],
              ref: (mesh) => {
                reactMesh = mesh;
                if (mesh) resolveMesh();
              },
            },
            createElement(BoxGeometry, { args: [0.02, 0.02, 0.02] }),
            createElement(PbrMaterial, { color: '#84d6bd' }),
          ),
        ),
      );
    });
    await meshReady;
    engine.stop();
    let disposed = false;
    return {
      engine,
      dispose() {
        if (disposed) return;
        disposed = true;
        flushSync(() => root.unmount());
        check(host.childElementCount === 0, 'React retained canvas on unmount');
        host.remove();
        check(reactMesh === null, 'React mesh ref retained after unmount');
      },
    };
  },
);
