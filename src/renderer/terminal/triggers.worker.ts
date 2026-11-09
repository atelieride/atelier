/// <reference lib="webworker" />
// Output triggers run here: a pathological regex can only block this worker, which the window's
// watchdog stops and replaces (trigger-engine.ts), never the terminals.
import { triggerWorkerCore } from './triggers.worker-core';

const handle = triggerWorkerCore((m) => self.postMessage(m), () => performance.now());
self.onmessage = (e: MessageEvent) => handle(e.data);
