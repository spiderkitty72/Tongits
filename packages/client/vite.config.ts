import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// The engine is used straight from source so the client always matches the server's rules.
export default defineConfig({
  // Relative asset paths let the same build run from a server root or a sub-path such as GitHub Pages.
  base: './',
  resolve: {
    alias: { '@tongits/engine': fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)) },
  },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2020' },
  server: { port: 5173 },
});
