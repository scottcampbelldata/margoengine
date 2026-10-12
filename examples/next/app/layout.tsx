import type { ReactNode } from 'react';
export const metadata={title:'Margo Engine / Next.js',description:'Minimal Rust/Wasm engine with declarative React components.'};
export default function Layout({children}: {children:ReactNode}) {return <html lang="en"><body style={{margin:0,background:'#101720',color:'#e8eeed',fontFamily:'Arial,sans-serif'}}>{children}</body></html>;}
