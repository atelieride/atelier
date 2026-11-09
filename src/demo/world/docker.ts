// The fictional Docker world: the acme-store compose project (an api, a web front
// end, postgres, redis, a crashed worker and mailpit), another project (billing-sandbox) and a standalone localstack.
// Pure data plus a pure resolver: tests/e2e/docker-fixture.ts stages it on the fake engine (which derives the ids),
// the browser demo compiles it into snapshots at build time.

/** A container as the fake engine and the demo describe it; `inspectOf` (tests/support/fake-docker.ts) expands it. */
export interface ContainerSpec {
  name: string;
  project?: string;
  service?: string;
  workingDir?: string;
  configFiles?: string[];
  image?: string;
  state?: 'running' | 'exited' | 'restarting' | 'paused' | 'created' | 'dead';
  exitCode?: number;
  health?: 'healthy' | 'unhealthy' | 'starting';
  env?: string[];
  ports?: { host: number; container: number }[];
  exposed?: number[];
  mounts?: { type: 'bind' | 'volume'; source: string; target: string; name?: string }[];
  restarts?: number;
  restartPolicy?: string;
  tty?: boolean;
  oom?: boolean;
  cmd?: string[];
  startedAt?: string;
  finishedAt?: string;
}

/** A log line at an absolute time (ms) — what the fake engine serves. */
export interface ContainerLog { at: number; err: boolean; text: string }

export const COMPOSE = `name: acme-store
services:
  api:
    image: acme/api:dev
    ports: ["3000:3000"]
    volumes: ["./src:/app/src"]
    depends_on: [postgres, redis]
  web:
    image: node:22-alpine
    ports: ["5173:5173"]
  postgres:
    image: postgres:16-alpine
    ports: ["5432:5432"]
  redis:
    image: redis:7
    ports: ["6379:6379"]
  worker:
    image: acme/api:dev
    command: node dist/worker.js
    restart: on-failure:3
    environment:
      REDIS_URL: redis://127.0.0.1:6379
  mailpit:
    image: axllent/mailpit
    ports: ["8025:8025", "1025:1025"]
`;

/** Line 42 of the project's src/auth/session.ts, where the api's stack trace points (the rest is filler). */
export const SESSION_TS_LINE_42 = "  if (expired(token)) throw new TokenExpiredError('jwt expired');";

// Times: log lines are [seconds after the scenario's start, text, stderr?]; the scenario starts LOG_BASE_AGO_MS ago.
export const LOG_BASE_AGO_MS = 140_000;
type Line = readonly [s: number, text: string, err?: boolean];

const API_LOGS: Line[] = [
  [0, 'info: server listening on http://0.0.0.0:3000'],
  [0.1, 'info: connected to postgres://postgres:5432/acme (pool 10)'],
  [0.2, 'info: redis ready at redis:6379'],
  [73, 'GET /api/products 200 18.4 ms'],
  [74, 'GET /api/cart 200 9.1 ms'],
  [77, '{"level":"warn","time":"2026-10-15T07:42:19Z","msg":"slow query 412 ms","sql":"SELECT * FROM orders WHERE customer_id = $1","rows":38,"ms":412}'],
  [79, 'POST /api/checkout 500 1.2 s'],
  [79.01, 'Error: checkout failed: TokenExpiredError: jwt expired', true],
  [79.01, '    at verify (/app/src/auth/session.ts:42:11)', true],
  [79.01, '    at checkout (/app/src/routes/checkout.ts:88:5)', true],
  [79.01, '    at Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)', true],
  [79.01, '    at next (/app/node_modules/express/lib/router/route.js:149:13)', true],
  [79.01, '    at processTicksAndRejections (node:internal/process/task_queues:95:5)', true],
  [82, 'GET /api/products?page=2 200 22.0 ms'],
  [88, 'info: job enqueued email.receipt id=8812'],
  [89, 'warn: worker heartbeat missed for 30 s'],
  [91, 'GET /api/session 401 3.2 ms'],
  [98, 'warn: retrying redis publish (attempt 2/5)'],
  [102, 'GET /healthz 200 1.0 ms'],
  [109, 'GET /api/products 200 15.3 ms'],
  [110, 'Error: unhandled rejection: ECONNRESET on socket 14', true],
  [117, 'GET /healthz 200 1.1 ms'],
  [122, 'GET /api/cart 200 11.0 ms'],
  [123, 'debug: cache hit products:page:1 (ttl 54 s)'],
  [127, 'Error: mail send failed: connect ECONNREFUSED mailpit:1025', true],
  [130, 'GET /api/products?page=3 200 19.2 ms'],
  [132, 'GET /healthz 200 1.0 ms'],
  [134, 'info: session refreshed user=4021']
];

/** A container of the world, before it is placed in time and in the project's directory. */
export interface WorldContainer {
  /** The name its id is returned under (`stageDocker`). */
  key: string;
  /** `acme`: the project's compose stack (working dir = the project root); `billing`: the other project. */
  compose?: 'acme' | 'billing';
  /** The spec, minus the compose labels and times; a bind mount's `source` is relative to the project root. */
  spec: Omit<ContainerSpec, 'project' | 'workingDir' | 'configFiles' | 'startedAt' | 'finishedAt'>;
  startedAgoMs?: number;
  finishedAgoMs?: number;
  /** Timed lines, or bare lines the engine spaces one second apart before its own "now". */
  logs?: Line[] | string[];
}

const UP = (3 * 60 + 12) * 60_000;
const UP_DB = (3 * 60 + 14) * 60_000;
const DAY = 86_400_000;

const WORKER_CRASHED: WorldContainer = {
  key: 'worker', compose: 'acme',
  spec: {
    name: 'worker', image: 'acme/api:dev', state: 'exited', exitCode: 1, restarts: 3, restartPolicy: 'on-failure',
    env: ['NODE_ENV=development', 'REDIS_URL=redis://127.0.0.1:6379', 'DATABASE_URL=postgres://acme:s3cr3t-pass@postgres:5432/acme', 'QUEUE_CONCURRENCY=4', 'STRIPE_KEY=sk_test_51Hx0000', 'SMTP_HOST=mailpit:1025'],
    cmd: ['node', 'dist/worker.js']
  },
  finishedAgoMs: 120_000, startedAgoMs: 140_000,
  logs: [
    [-2, 'info: worker booting (concurrency 4)'],
    [-1.9, 'info: connecting to redis at 127.0.0.1:6379'],
    [-1.8, 'Error: connect ECONNREFUSED 127.0.0.1:6379', true],
    [-1.8, '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1607:16)', true],
    [5, 'warn: restart 3/3 (on-failure)'],
    [5.2, 'Error: connect ECONNREFUSED 127.0.0.1:6379', true],
    [5.2, '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1607:16)', true],
    [5.3, 'info: exiting with code 1 · restart limit reached']
  ]
};

/** The website's hero shows the whale without a failure dot: the worker runs. */
const WORKER_HEALTHY: WorldContainer = {
  key: 'worker', compose: 'acme',
  spec: {
    name: 'worker', image: 'acme/api:dev', restartPolicy: 'on-failure', cmd: ['node', 'dist/worker.js'],
    env: ['NODE_ENV=development', 'REDIS_URL=redis://redis:6379', 'QUEUE_CONCURRENCY=4']
  },
  startedAgoMs: UP,
  logs: [
    [0.6, 'info: worker booting (concurrency 4)'],
    [0.7, 'info: connected to redis at redis:6379'],
    [88.1, 'info: job email.receipt id=8812 done in 214 ms']
  ]
};

/** Every container, in the order the engine lists them; `healthy` swaps the crashed worker for a running one. */
export function worldContainers(opts: { healthy?: boolean } = {}): WorldContainer[] {
  return [
    {
      key: 'api', compose: 'acme',
      spec: {
        name: 'api', image: 'acme/api:dev', health: 'healthy', ports: [{ host: 3000, container: 3000 }], restartPolicy: 'unless-stopped',
        mounts: [{ type: 'bind', source: 'src', target: '/app/src' }, { type: 'volume', name: 'acme_node_modules', source: '/var/lib/docker/volumes/acme_node_modules/_data', target: '/app/node_modules' }],
        env: ['NODE_ENV=development', 'PORT=3000', 'DATABASE_URL=postgres://acme:s3cr3t-pass@postgres:5432/acme', 'REDIS_URL=redis://redis:6379', 'JWT_SECRET=dev-jwt-0123456789', 'LOG_LEVEL=info'],
        cmd: ['node', 'dist/server.js']
      },
      startedAgoMs: UP, logs: API_LOGS
    },
    {
      key: 'web', compose: 'acme', spec: { name: 'web', image: 'node:22-alpine', ports: [{ host: 5173, container: 5173 }], cmd: ['npm', 'run', 'dev'] }, startedAgoMs: UP,
      logs: [
        [0.4, '  VITE v6.2.0  ready in 412 ms'],
        [0.5, '  ➜  Local:   http://localhost:5173/'],
        [74, '9:42:16 AM [vite] hmr update /src/pages/Checkout.tsx'],
        [130, '9:43:12 AM [vite] page reload src/main.tsx']
      ]
    },
    {
      key: 'postgres', compose: 'acme', spec: { name: 'postgres', image: 'postgres:16-alpine', health: 'healthy', ports: [{ host: 5432, container: 5432 }] }, startedAgoMs: UP_DB,
      logs: [
        [-0.6, '2026-10-15 07:39:41.501 UTC [1] LOG:  starting PostgreSQL 16.4 on aarch64-unknown-linux-musl'],
        [-0.3, '2026-10-15 07:39:41.912 UTC [1] LOG:  database system is ready to accept connections'],
        [77, '2026-10-15 07:42:19.433 UTC [61] LOG:  duration: 411.802 ms  statement: SELECT * FROM orders WHERE customer_id = $1'],
        [106, '2026-10-15 07:42:48.120 UTC [64] ERROR:  relation "order_items_v2" does not exist at character 15', true],
        [106, '2026-10-15 07:42:48.120 UTC [64] STATEMENT:  SELECT * FROM order_items_v2 WHERE order_id = $1', true]
      ]
    },
    {
      key: 'redis', compose: 'acme', spec: { name: 'redis', image: 'redis:7', ports: [{ host: 6379, container: 6379 }], exposed: [6379] }, startedAgoMs: UP_DB,
      logs: [
        [-0.7, '1:M 15 Oct 2026 07:39:41.990 * Ready to accept connections tcp'],
        [119, '1:M 15 Oct 2026 07:43:01.004 * 1 changes in 60 seconds. Saving...'],
        [119.1, '1:M 15 Oct 2026 07:43:01.017 * Background saving terminated with success']
      ]
    },
    opts.healthy ? WORKER_HEALTHY : WORKER_CRASHED,
    {
      key: 'mailpit', compose: 'acme', spec: { name: 'mailpit', image: 'axllent/mailpit', ports: [{ host: 8025, container: 8025 }, { host: 1025, container: 1025 }] }, startedAgoMs: UP,
      logs: [
        [0.8, 'INFO[2026/10/15 07:39:42] [smtpd] starting on [::]:1025 (no encryption)'],
        [0.9, 'INFO[2026/10/15 07:39:42] [http] accessing web UI on http://[::]:8025'],
        [128, 'WARN[2026/10/15 07:43:10] [smtpd] client sent unexpected EOF']
      ]
    },
    { key: 'billingDb', compose: 'billing', spec: { name: 'db', image: 'postgres:15', state: 'exited', exitCode: 0 }, finishedAgoMs: 3 * DAY },
    { key: 'billingApi', compose: 'billing', spec: { name: 'api', image: 'billing/api:latest', state: 'exited', exitCode: 0 }, finishedAgoMs: 3 * DAY },
    { key: 'localstack', spec: { name: 'localstack', image: 'localstack/localstack:3', ports: [{ host: 4566, container: 4566 }] }, startedAgoMs: 2 * DAY, logs: ['Ready.'] }
  ];
}

const BILLING = { project: 'billing-sandbox', workingDir: '/home/ada/code/billing', configFiles: ['/home/ada/code/billing/compose.yml'] };

/**
 * The world placed at `now` with the acme-store project at `root` (an absolute path, no trailing slash): full specs
 * (compose labels, absolute times and mount sources) and logs at absolute times, in the engine's listing order.
 */
export function dockerContainers(root: string, now: number, opts: { healthy?: boolean } = {}): { key: string; spec: ContainerSpec; logs?: ContainerLog[] | string[] }[] {
  const base = now - LOG_BASE_AGO_MS;
  const acme = { project: 'acme-store', workingDir: root, configFiles: [`${root}/compose.yml`] };
  return worldContainers(opts).map((c) => {
    const spec: ContainerSpec = {
      ...(c.compose === 'acme' ? acme : c.compose === 'billing' ? BILLING : {}),
      ...c.spec,
      ...(c.spec.mounts ? { mounts: c.spec.mounts.map((m) => (m.type === 'bind' ? { ...m, source: `${root}/${m.source}` } : m)) } : {}),
      ...(c.finishedAgoMs !== undefined ? { finishedAt: new Date(now - c.finishedAgoMs).toISOString() } : {}),
      ...(c.startedAgoMs !== undefined ? { startedAt: new Date(now - c.startedAgoMs).toISOString() } : {})
    };
    const logs = c.logs?.map((l) => (typeof l === 'string' ? l : { at: base + l[0] * 1000, err: !!l[2], text: l[1] })) as ContainerLog[] | string[] | undefined;
    return { key: c.key, spec, ...(logs ? { logs } : {}) };
  });
}
