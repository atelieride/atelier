// Find in Files' strings, loaded with the view's lazy chunk rather than with en.ts: the live demo's first paint has no
// room for them. en.ts keeps the activity item's label, whose name heads the view. Same rules as en.ts: written for
// macOS, in Windows' words there.
import { currentPlatform } from '@shared/platform';
import { localize } from '@shared/windows-words';
import { t } from '../i18n/en';

const num = (v: number): string => v.toLocaleString('en-US');
const files = (v: number): string => `${num(v)} ${v === 1 ? 'file' : 'files'}`;

const strings = {
  /** The activity item's name, without its key. */
  title: t.activity.search.replace(/ \(.*\)$/, ''),
  field: 'Search files',
  refresh: 'Refresh',
  stop: 'Stop',
  clear: 'Clear Results',
  collapseAll: 'Collapse All',
  expandAll: 'Expand All',
  filters: 'Filters',
  include: 'Files to include',
  exclude: 'Files to exclude',
  includeIgnored: 'Include ignored files',
  includeHint: 'src/, *.ts',
  excludeHint: '**/*.test.ts',
  recent: 'Recent',
  about: 'Searches every text file of the project, as the Files tree lists it: ignored files and build folders stay out unless you ask.',
  /** Followed by the key, then a period. */
  selectAndPress: 'Select text anywhere and press',
  /** "19 results in 5 files" in four pieces, the numbers apart (they are set in mono); past the cap, "20,000+ results". */
  totals: (results: number, inFiles: number, more: boolean): [string, string, string, string] =>
    [`${num(results)}${more ? '+' : ''}`, ` ${results === 1 && !more ? 'result' : 'results'} in `, num(inFiles), ` ${inFiles === 1 ? 'file' : 'files'}`],
  /** A file's count, in its pill's tip: "3,000 results". */
  results: (n: number) => `${num(n)} ${n === 1 ? 'result' : 'results'}`,
  searching: 'Searching…',
  progress: (searched: number, total: number) => `${num(searched)} / ${num(total)}`,
  notSearched: (n: number) => `${files(n)} not searched`,
  noResults: 'No results.',
  /** Followed by the filter, then a period. */
  noResultsIn: 'No results in',
  wholeProject: 'Search the whole project',
  multiline: 'Searches match within a line.',
  /** Around ".*": the way out of an invalid regular expression. */
  regexOff: ['Turn off', 'to search the text as written.'] as const,
  limit: (max: number) => `Showing the first ${num(max)} matches. Narrow the search or add a filter to see the rest.`,
  fileCap: (n: number) => `Searched the first ${num(n)} files. Add a filter to search the rest.`,
  fileCapIgnored: (n: number) => `Searched the first ${num(n)} files: the ignored files past that were not searched.`,
  stopped: (searched: number, total: number) => `Stopped · ${num(searched)} of ${num(total)} files searched`,
  stale: 'Files changed since this search',
  noProject: 'Open a folder to search its files.',
  openFolder: 'Open Folder…',
  list: 'Results',
  dismiss: 'Dismiss',
  copyLine: 'Copy Line',
  copyAll: 'Copy All Results',
  /** The summary's ✦ link, and the menus' item that does the same. */
  send: 'Send to session',
  sendMenu: 'Send to Session…',
  /** The results typed into a new session's prompt. */
  typedInNew: 'The search results are in the prompt. Review them and press Enter to send.',
  /** The skipped files' popover. */
  skippedTitle: (n: number) => `${files(n)} not searched`,
  tooLarge: (limit: string) => `Too large to search (over ${limit})`,
  unreadable: 'Unreadable',
  revealInFiles: t.menu.revealInFiles,
  close: 'Close'
} as const;

/** Windows names its own places and tools. macOS: as written. */
export const ts = currentPlatform() === 'win32' ? localize(strings) : strings;
