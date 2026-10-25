import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Scene } from './scene.js';

createRoot(document.querySelector('#root')!).render(
  <StrictMode>
    <Scene />
  </StrictMode>,
);
