import { resolve } from 'node:path';
import { defineConfig, resolveConfig } from 'electron-vite';
import { build, type LogLevel, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const shared = { '@shared': resolve(__dirname, 'src/shared') };

// In development Vite injects inline scripts and uses a websocket: the CSP is relaxed only there.
function devCsp(): Plugin {
  return {
    name: 'atelier-dev-csp',
    apply: 'serve',
    transformIndexHtml(html: string) {
      return html
        .replace(/script-src 'self'/, "script-src 'self' 'unsafe-inline'")
        .replace(/connect-src 'self'/, "connect-src 'self' ws://localhost:*");
    }
  };
}

/**
 * atelierd as a bundle of its own (out/main/daemon.js). Built in one graph with the main process, the modules both use
 * went to shared chunks that also carried main-only code, and the app asks for an atelierd restart whenever the code
 * daemon.js loads changes (main/daemon-fingerprint.ts): an app-only change asked every user to close their sessions.
 * It runs once the main process is written (its emptyOutDir would remove daemon.js), and again on every rebuild in dev.
 */
function standaloneDaemon(): Plugin {
  let outDir = '';
  let mode = '';
  let logLevel: LogLevel | undefined;
  return {
    name: 'atelier-standalone-daemon',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
      mode = config.mode;
      logLevel = config.logLevel;
    },
    async writeBundle() {
      // The current NODE_ENV as the default mode: resolveConfig sets it, and it must stay what the outer build chose.
      const { config } = await resolveConfig({ configFile: resolve(__dirname, 'electron.vite.daemon.config.ts'), mode, logLevel }, 'build', process.env.NODE_ENV ?? 'production');
      const daemon = config?.main;
      if (!daemon) throw new Error('electron.vite.daemon.config.ts has no main config');
      daemon.build = { ...daemon.build, outDir, emptyOutDir: false };
      await build(daemon);
    }
  };
}

export default defineConfig({
  main: {
    resolve: { alias: shared },
    plugins: [standaloneDaemon()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    }
  },
  preload: { resolve: { alias: shared } },
  renderer: {
    resolve: { alias: shared },
    plugins: [react(), devCsp()],
    // The app's page, and the tab tear-off's ghost (a static page of its own: no preload, no React).
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html'), ghost: resolve(__dirname, 'src/renderer/ghost.html') } } },
    // The Shiki worker loads languages with dynamic imports: it needs the ES format.
    worker: { format: 'es' }
  }
});
