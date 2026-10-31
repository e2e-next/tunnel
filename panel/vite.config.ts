import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Which tunnel `npm run dev` talks to. 8000 is the real default admin port;
// TUNNEL_ADMIN=http://127.0.0.1:8020 npm run dev points it at a scratch server.
const admin = process.env.TUNNEL_ADMIN ?? 'http://127.0.0.1:8000'

// The panel ships as exactly two committed files plus the font: one script, one
// stylesheet, fixed names, no hashes, nothing fetched over the network.
export default defineConfig(({ command }) => ({
  // '/static/' is what makes the built CSS ask for the font at
  // /static/panel-InterVariable-latin.woff2, where the package serves it. The
  // dev server serves the panel from the root instead, so there it is '/'.
  base: command === 'serve' ? '/' : '/static/',
  plugins: [react(), tailwindcss()],
  server: {
    // In dev the page comes from Vite and the data from the running tunnel, so
    // the two endpoints the panel reads are proxied through. /ca.pem is not
    // under /__admin__: a device downloads it from the root.
    proxy: {
      '/__admin__': { target: admin, changeOrigin: true },
      '/ca.pem': { target: admin, changeOrigin: true },
    },
  },
  build: {
    // Straight into the package: the three files are committed, so installing
    // the package builds nothing. `make panel` writes them, `make panel-check`
    // fails when what is committed is not what the sources build.
    outDir: '../assets/panel/',
    // Never empty it: it is the directory the npm package ships, not a build
    // scratch space, and a stray `rm -rf` of it through a config flag is not
    // something to leave armed. Nothing goes stale either way — all three
    // output names are fixed, so every build overwrites exactly what it wrote
    // last time.
    emptyOutDir: false,
    cssCodeSplit: false,
    assetsInlineLimit: 0, // the font stays a real file, not a base64 blob
    modulePreload: false,
    rollupOptions: {
      input: 'src/main.tsx',
      output: {
        entryFileNames: 'panel.js',
        assetFileNames: (info) =>
          info.names?.[0]?.endsWith('.css') ? 'panel.css' : 'panel-[name][extname]',
        codeSplitting: false,
      },
    },
  },
}))
