// The search's worker thread (out/main/search-worker.js): main's messages in, a search's events out. It reads only
// what it is given, and nothing in it may need Electron: it runs as a plain Node worker.
import { parentPort } from 'node:worker_threads';
import { searchRunner, type WorkerIn } from './run';

const port = parentPort;
if (!port) throw new Error('The search worker runs only as a worker thread.');
const handle = searchRunner((m) => port.postMessage(m));
port.on('message', (m: WorkerIn) => handle(m));
