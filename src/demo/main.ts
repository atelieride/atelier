// The live demo's entry: the fake backend and the storage shim first, then the real renderer,
// unchanged. The order of these two imports is the whole point: install.ts (and everything it imports) evaluates
// before any module of the renderer.
import './install';
import '../renderer/main.tsx';
