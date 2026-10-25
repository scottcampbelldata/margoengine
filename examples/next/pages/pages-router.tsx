import { Scene } from '../app/scene';

// The Pages Router works the same way: import the client Scene wherever you want 3D. Visit /pages-router.
export default function PagesRouterPage() {
  return (
    <main style={{ margin: 0, background: '#101720', color: '#e8eeed', fontFamily: 'Arial,sans-serif' }}>
      <h1 style={{ padding: '24px 32px' }}>Margo Engine / Next.js Pages Router</h1>
      <Scene />
    </main>
  );
}
