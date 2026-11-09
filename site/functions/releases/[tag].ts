// GET /releases/<tag>: answered by src/lib/update-endpoints.ts.
import { pagesHandler } from '../../src/lib/update-endpoints';

export const onRequestGet = pagesHandler;
export const onRequestHead = pagesHandler;
