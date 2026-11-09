// pg's pure-JS client, which client.ts imports past pg's index (the index swaps in pg-native when NODE_PG_FORCE_NATIVE
// is set). @types/pg types only the package root: this gives the deep import the same Client.
declare module 'pg/lib/client' {
  import { Client } from 'pg';
  export = Client;
}
