import { createMarkdownProcessor } from '@astrojs/markdown-remark';
import { parseChangelog, type Release } from './changelog';
import { anchorReleaseHtml } from './search';

export interface RenderedRelease extends Release { html: string; entries: { title: string; id: string }[] }

/** CHANGELOG.md → the releases as HTML with their entries' anchors: shared by /changelog and /search.json. */
export async function renderReleases(md: string): Promise<RenderedRelease[]> {
  const processor = await createMarkdownProcessor({ syntaxHighlight: false });
  return Promise.all(parseChangelog(md).map(async (r) => ({ ...r, ...anchorReleaseHtml((await processor.render(r.body)).code, r.version) })));
}
