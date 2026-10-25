import { Suspense } from 'react';
import { Scene } from './scene';

// A server component: the heading is HTML from the server, the scene hydrates in the browser.
export default function Page() {
  return (
    <main>
      <h1 style={{ padding: '24px 32px' }}>Margo Engine / Next.js</h1>
      <Suspense fallback={<div style={{ height: '70vh' }}>Loading 3D scene...</div>}>
        <Scene />
      </Suspense>
    </main>
  );
}
