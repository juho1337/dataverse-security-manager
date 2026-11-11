import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { buildStamp } from './scripts/build-stamp.mjs';

// PPTB loads a tool from file:// inside a sandboxed webview, so the build must be a classic script:
// one IIFE bundle, no type="module", no crossorigin, script tag at the end of <body>.
function classicScriptHtml(): Plugin {
  return {
    name: 'ptl-classic-script-html',
    enforce: 'post',
    transformIndexHtml(html) {
      let scriptTag = '';
      const withoutScript = html.replace(/\s*<script\b[^>]*\bsrc="[^"]+"[^>]*><\/script>/g, (tag) => {
        scriptTag = tag
          .replace(/\s+type="module"/, '')
          .replace(/\s+crossorigin(="[^"]*")?/, '')
          .trim();
        return '';
      });
      return withoutScript
        .replace(/\s+crossorigin(="[^"]*")?/g, '')
        .replace('</body>', `  ${scriptTag}\n  </body>`);
    },
  };
}

export default defineConfig({
  // Build stamp shown in the app footer (version, commit, build time).
  define: { __DSM_BUILD__: JSON.stringify(buildStamp()) },
  base: './',
  plugins: [react(), classicScriptHtml()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    cssCodeSplit: false,
    modulePreload: false,
    sourcemap: true,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: 'app[extname]',
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
  },
});
