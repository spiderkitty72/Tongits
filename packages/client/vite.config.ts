import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * Puts the script and styles inside index.html so the built app also opens straight from disk
 * (file://), where browsers refuse to load separate module scripts.
 */
function inlineIntoHtml(): Plugin {
  return {
    name: 'inline-into-html',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find((f) => f.type === 'asset' && f.fileName === 'index.html');
      if (!html || html.type !== 'asset') return;
      let source = String(html.source);
      for (const [name, file] of Object.entries(bundle)) {
        if (file.type === 'chunk' && file.isEntry) {
          const tag = new RegExp(`<script[^>]*src="[^"]*${name.replace(/[.]/g, '\\.')}"[^>]*></script>`);
          // Escape "</script" inside the code so the inline tag isn't closed early.
          const code = file.code.replace(/<\/script/gi, '<\\/script');
          source = source.replace(tag, () => '');
          source = source.replace('</body>', () => `<script>${code}</script>\n</body>`);
          delete bundle[name];
        } else if (file.type === 'asset' && name.endsWith('.css')) {
          const tag = new RegExp(`<link[^>]*href="[^"]*${name.replace(/[.]/g, '\\.')}"[^>]*>`);
          source = source.replace(tag, () => `<style>${String(file.source)}</style>`);
          delete bundle[name];
        }
      }
      html.source = source;
    },
  };
}

// The engine is used straight from source so the client always matches the server's rules.
export default defineConfig({
  // Relative asset paths let the same build run from a server root, a sub-path such as GitHub Pages, or a file.
  base: './',
  resolve: {
    alias: { '@tongits/engine': fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)) },
  },
  plugins: [inlineIntoHtml()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: { output: { format: 'iife', inlineDynamicImports: true } },
  },
  server: { port: 5173 },
});
