import { defineConfig } from 'vite';

// When deployed to GitHub Pages the site lives at https://<user>.github.io/BudGame2026/
// so every asset URL must be prefixed with /BudGame2026/. Vite injects this
// prefix into HTML asset references automatically and exposes it to JS as
// import.meta.env.BASE_URL (see src/characterData.js).
//
// To deploy under a different repo name, change `base` accordingly.
export default defineConfig({
  root: '.',
  base: process.env.VITE_BASE || '/BudGame2026/',
  publicDir: 'assets',
  server: {
    port: 5173,
    open: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
