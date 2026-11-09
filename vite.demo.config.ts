// The website's live demo: the real renderer with a fake backend, built
// into site/public/demo-app/ by `npm run build:demo`. Everything lives in src/demo/compile/build.ts.
import { defineConfig } from 'vite';
import { demoConfig } from './src/demo/compile/build';

export default defineConfig(demoConfig());
