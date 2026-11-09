import net from 'node:net';
import { LineDecoder, encode, type ServerMessage } from '../../src/shared/protocol';

export interface TestClient {
  socket: net.Socket;
  messages: ServerMessage[];
  send(msg: unknown): void;
  next(pred: (m: ServerMessage) => boolean, ms?: number): Promise<ServerMessage>;
  closed: Promise<void>;
  close(): void;
}

export function connectRaw(sock: string, firstLine: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sock);
    const dec = new LineDecoder();
    const messages: ServerMessage[] = [];
    const waiters: { pred: (m: ServerMessage) => boolean; res: (m: ServerMessage) => void }[] = [];
    let closedRes!: () => void;
    const closed = new Promise<void>((r) => { closedRes = r; });
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      for (const line of dec.push(chunk)) {
        const m = JSON.parse(line) as ServerMessage;
        messages.push(m);
        for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
      }
    });
    socket.on('close', () => closedRes());
    socket.on('error', () => closedRes());
    socket.on('connect', () => {
      socket.write(firstLine);
      resolve({
        socket, messages, closed,
        send: (msg) => socket.write(encode(msg)),
        next: (pred, ms = 5000) => {
          const found = messages.find(pred);
          if (found) { messages.splice(messages.indexOf(found), 1); return Promise.resolve(found); }
          return new Promise((res, rej) => {
            const w = { pred, res: (m: ServerMessage) => { clearTimeout(timer); messages.splice(messages.indexOf(m), 1); res(m); } };
            const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timeout in attesa del messaggio')); }, ms);
            waiters.push(w);
          });
        },
        close: () => socket.destroy()
      });
    });
    socket.once('error', reject);
  });
}

export function connectControl(sock: string, token: string): Promise<TestClient> {
  return connectRaw(sock, encode({ t: 'hello', token, v: 1 }));
}
