import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { NO_WEBGPU, hasWebGPU, showStartError } from './browser';
import { Scene } from './scene.js';

async function boot() {
  if (!(await hasWebGPU())) {
    showStartError(NO_WEBGPU);
    return;
  }
  createRoot(document.querySelector('#root')!).render(
    <StrictMode>
      <Scene />
    </StrictMode>,
  );
}

boot().catch((error) => {
  showStartError(error instanceof Error ? error.message : String(error));
});
