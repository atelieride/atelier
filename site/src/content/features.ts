import type { IconName } from '../components/Icon.astro';
import type { DemoView } from '../../../src/demo/protocol';
import { REPO_URL } from '../lib/repo';

export interface FeatureRowData {
  id: string;
  eyebrow: string;
  title: string;
  text: string;
  bullets: string[];
  shot: 'sessions' | 'ask' | 'workspace' | 'background' | 'scheduled' | 'docker' | 'redis' | 'databases' | 'changes' | 'automations' | 'editor' | 'dictation' | 'accounts' | 'alive';
  /** The shot starts at the window's top-left corner (CLIPS in tests/e2e/site-shots.manual.ts): traffic lights drawn. */
  corner: boolean;
  /** Its phone crop (MOBILE in the same file) starts at the corner too. */
  phoneCorner?: boolean;
  alt: string;
  /** The shortcut shown beside the title on /features, in mono: the key, two
   *  spaces, what it does. Rows without one show nothing there. */
  shortcut?: string;
  /** The live demo can show this feature: the row gets "Try it", and the demo
   *  opens on `view`, the command the native menu sends for it, or a view of the demo itself (DEMO_VIEWS) when no
   *  command shows what the row promises (the editor: Files and a file open).
   *  A command, never a custom demo state: every command is already a state the app supports. Commands that
   *  show something rather than toggle it, so opening a second time never hides what the row promised (split-right,
   *  which adds a pane each time, is sent only from one pane: src/demo/shell/open-view.ts). */
  demo?: { view: DemoView };
}

export interface BentoItem { icon: IconName; title: string; text: string }

/** A tile of the home's "beside the session" grid: a link to its row on
 *  /features, a window onto the row's shot drawn 1:1, `focus` (CSS object-position) on the part that tells it. */
export interface Tile { id: FeatureRowData['id']; title: string; text: string; focus: string }
/** A cell of the home's "Your Claude. Your Mac." strip: a title, a mono word, a line. */
export interface MacCell { title: string; mono: string; text: string }
/** A piece of an answer: text, or a link as data (never an HTML string). */
export type FaqPart = string | { text: string; href: string };
export interface FaqItem { q: string; a: FaqPart[] }

export const rows: FeatureRowData[] = [
  {
    id: 'sessions', eyebrow: 'Sessions', title: 'Know who needs you.',
    text: 'Every session shows what it is doing. When one needs you, you know — and ⌘J takes you there.',
    bullets: ['Needs permission, has a question, working, done, failed', 'Notification center, Dock menu and banners', 'Context, cost and limits, for each of your Claude accounts'],
    shot: 'sessions', corner: true, alt: 'Sessions grouped by state: two need you, two are working, one is done',
    shortcut: '⌘J  next waiting',
    demo: { view: 'view-sessions' }
  },
  {
    id: 'ask', eyebrow: 'Ask', title: 'Catch up without interrupting.',
    text: 'Ask a session where it is, what\'s left or why it chose something. A read-only side chat answers from its conversation and your code, while the session keeps working, its context untouched.',
    bullets: ['Catch me up: your requests, done or not, where it is and the choices it made', 'File links that open the code, a verdict on how far it got; Help me decide when it asks you', 'Read-only: it never edits files, runs commands or interrupts the session', 'Runs on your Claude account, Sonnet by default; pick another model or account'],
    shot: 'ask', corner: false, alt: 'Ask docked beside a session waiting for permission: a Help me decide card, then Catch me up with its two requests, one done and one waiting for your OK, where it is and the choices it made',
    shortcut: '⌘I  Ask About This Session',
    demo: { view: 'demo:ask' }
  },
  {
    id: 'workspace', eyebrow: 'Workspace', title: 'Everything side by side.',
    text: 'Sessions, terminals and files are tabs. Put up to three side by side, and keep separate lines of work in workspaces and the activities inside them.',
    bullets: ['Split view with up to three panes (⌘\\)', 'Command palette (⌘K) for files, sessions and commands', 'Drag a tab out into its own window (⇧⌘O)'],
    shot: 'workspace', corner: false, alt: 'A Claude Code session next to a file in split view',
    shortcut: '⌘\\  split',
    demo: { view: 'split-right' }
  },
  {
    id: 'background', eyebrow: 'Background', title: 'See what runs in the background.',
    text: 'Click a session\'s chip to see its agents, shells and monitors. Open one beside the session and watch it live.',
    bullets: ['Live output of background shells and monitors', 'Each subagent\'s steps as it takes them', 'Scheduled wake-ups with a countdown'],
    shot: 'background', corner: false, alt: 'The Background tab of a session: two agents and a test run listed, the test run\'s output arriving live',
    shortcut: '⌘⌥B  Background',
    demo: { view: 'show-background' }
  },
  {
    id: 'scheduled', eyebrow: 'Scheduled prompts', title: 'Send it later.',
    text: 'Write the next prompt now and pick when it goes: in an hour, tomorrow at nine, or right after your usage limit resets. At that time Atelier types it into the session, once Claude is free.',
    bullets: ['Several per session, never two at the same minute', 'It waits while Claude works or asks, or skips that turn: your call', 'Sent by the background service, even with the app closed'],
    shot: 'scheduled', corner: false, alt: 'The Schedule a prompt sheet over a session: the prompt, presets up to "When usage resets", the session\'s next 24 hours on a rail',
    shortcut: '⌘⌥⏎  Schedule Prompt',
  },
  {
    id: 'docker', eyebrow: 'Docker', title: 'Your containers, next to Claude.',
    text: 'Atelier finds Docker Desktop, OrbStack or Colima on its own. Read your stack\'s logs, see why a container stopped, and send the lines that matter to a session.',
    bullets: ['Logs of one container or the whole stack, errors and traces folded', 'Why it stopped: exit code, last lines, environment with secrets masked', 'Read-only: Atelier never starts, stops or runs anything in a container'],
    shot: 'docker', corner: false, alt: 'The logs of a Docker container in Atelier: two errors selected, ready to send to a Claude session',
    shortcut: '⌥↵  send to the session',
    demo: { view: 'view-docker' }
  },
  {
    id: 'redis', eyebrow: 'Redis', title: 'Your Redis, keys and queues.',
    text: 'Atelier finds the Redis your project uses — on your Mac, in Docker or from Homebrew. Browse keys, watch your queues, and ask Claude why a job failed.',
    bullets: ['Keys by namespace, values pretty-printed, secrets masked until you show them', 'Queues of BullMQ, Bull, Sidekiq, Laravel, Celery, RQ, Asynq and Resque, failed jobs with their stack', 'Local only: every change asks first and can be undone'],
    shot: 'redis', corner: false, alt: 'The failed jobs of a BullMQ queue in Atelier: the error and its stack, one click from asking Claude why it failed',
    shortcut: '⌃⇧R  Redis',
    demo: { view: 'view-redis' }
  },
  {
    id: 'databases', eyebrow: 'Databases', title: 'Your Postgres, read-only and readable.',
    text: 'Connect your Postgres — on your Mac, in Docker or remote through an SSH tunnel. Browse tables as you scroll, read JSON as a tree, follow foreign keys both ways, and hand rows to Claude. Every query runs in a read-only transaction.',
    bullets: ['Structure, indexes, relations and DDL, and an overview of what the server is running', 'Send rows or a table\'s schema to a session; mask emails and secrets first', 'Local, in Docker or remote through an SSH tunnel; passwords encrypted like the connectors\' tokens'],
    shot: 'databases', corner: false, alt: 'The orders table of a Postgres database in Atelier, newest first, the row inspector open on the newest order with its customer\'s card from the foreign key',
    shortcut: '⌃⇧B  Databases',
    demo: { view: 'view-databases' }
  },
  {
    id: 'changes', eyebrow: 'Changes', title: 'See who changed what.',
    text: 'Every changed file carries the colour of the session that touched it — down to the exact command. Commit it right there.',
    bullets: ['Changes by session or by repository, reviewed with line comments sent back to Claude', 'Commit and push from the panel, several repositories at once, messages written by Claude', 'Source Control: sync, branches and stashes, history graph, pull request and CI chips'],
    shot: 'changes', corner: false, alt: 'The changed files coloured by session, one staged, and the commit drawer with a message Claude wrote, next to the file\'s diff',
    shortcut: '⌥⌘M  message by Claude',
    demo: { view: 'review-all' }
  },
  {
    id: 'automations', eyebrow: 'Automations', title: 'Tasks that start themselves.',
    text: 'Turn them on in Settings, then pick a ClickUp list, a Notion database or a Jira project and what a task must match. When one does, Atelier starts a Claude session on it in a worktree of its own, and says why.',
    bullets: ['Its own branch and worktree for each task; it never merges or pushes', 'Limits per rule, per day and across projects, and a pause near your usage limit', 'It stops to ask you, or decides and lists every choice at the end'],
    shot: 'automations', corner: false, alt: 'The Automations tab: a rule that is on, what it watches and what Claude does, its guardrails, and its runs at work and for review',
    shortcut: '⌘⇧A  Automations',
    demo: { view: 'view-automations' }
  },
  {
    id: 'editor', eyebrow: 'Editor', title: 'A real editor next to Claude.',
    text: 'Open, edit and save files without leaving the session. When Claude edits the same file, nothing gets lost.',
    bullets: ['Find and replace, comments, Markdown preview, a JSON tree and CSV tables','Compare, keep yours or reload when Claude changes a file', '⌘L mentions the selected lines in the session'],
    shot: 'editor', corner: false, alt: 'A TypeScript file with its changes marked in the margin, next to the session that made them',
    shortcut: '⌘L  @session.ts#L11-17',
    demo: { view: 'demo:editor' }
  },
  {
    id: 'dictation', eyebrow: 'Dictation', title: 'Talk to Claude.',
    text: 'Hold ⌥Space and speak. Transcription runs on your computer, so your voice never leaves it.',
    bullets: ['On-device transcription with whisper.cpp on Metal', 'Optional clean-up of the text by Claude Haiku (the text, never the audio)', 'Off until you turn it on'],
    shot: 'dictation', corner: false, alt: 'The dictation pill listening while Claude waits for an answer',
    shortcut: '⌥Space  hold to talk',
  },
  {
    id: 'accounts', eyebrow: 'Claude accounts', title: 'All your Claude accounts, side by side.',
    text: 'More than one Claude subscription? Pick the account as you start a session, with its limits in view. Every session remembers which one it runs as.',
    bullets: ['Each account\'s 5-hour and weekly limits, right where you choose', 'A chip on the sessions that run as another account', 'Resume, the session panel and dictation clean-up follow each session\'s account', 'Your own claude flags on every new session, or on one account\'s only'],
    shot: 'accounts', corner: false, alt: 'New Session with two Claude accounts, Personal and Work, each with its limits; Work is picked',
    shortcut: '⇥  switch account',
    demo: { view: 'new-session-account:work' }
  },
  {
    id: 'alive', eyebrow: 'Always alive', title: 'Close the app. Your sessions keep going.',
    text: 'A background service owns your terminals. Quit Atelier, install an update or restart your Mac: pick up where you left off.',
    bullets: ['Busy sessions can keep running when their window closes', 'Idle ones wait under Resume, and so can those you close to free memory: back in one click', 'Updates install on restart without closing sessions'],
    shot: 'alive', corner: true, phoneCorner: true, alt: 'Atelier reopened with the same sessions still running'
  }
];

export const bento: BentoItem[] = [
  { icon: 'terminal', title: 'Atelier terminal', text: 'A fast zsh with command blocks and output triggers.' },
  { icon: 'plug', title: 'Ports, one click away', text: 'Servers started in a terminal show their port; click to open.' },
  { icon: 'services', title: 'Service logs', text: 'Your project\'s tmux panes, read-only, next to the sessions. Turn them on in Settings.' },
  { icon: 'inbox', title: 'Tasks become sessions', text: 'Your ClickUp, Notion and Jira tasks start sessions. Read-only.' },
  { icon: 'sliders', title: 'Session panel', text: 'Model, permission mode, MCP servers and skills at a glance.' },
  { icon: 'tag', title: 'Names in step', text: 'Rename a session in Atelier and Claude\'s /resume follows.' },
  { icon: 'settings', title: 'Make it yours', text: 'Appearance, terminal, editor and notifications; every shortcut listed.' },
  { icon: 'swap', title: 'Calm by design', text: 'Reduce motion, swap the side panels, zoom the interface.' }
];

export const keys = [
  { keys: ['⌘', 'J'], label: 'Next session waiting' },
  { keys: ['⌘', 'K'], label: 'Command palette' },
  { keys: ['⌘', '\\'], label: 'Split view' },
  { keys: ['⌥', 'Space'], label: 'Dictate' },
  { keys: ['⌘', 'L'], label: 'Mention lines' },
  { keys: ['⌘', 'N'], label: 'New session' },
  { keys: ['⇧', '⌘', 'N'], label: 'Resume a session' },
  { keys: ['⌥', '⌘', 'K'], label: 'Commit' },
  { keys: ['⌥', '⌘', 'M'], label: 'Message with Claude' }
];

/** The home's eight tiles, in this order. */
export const tiles: Tile[] = [
  { id: 'editor', title: 'Editor', text: 'Edit a file while Claude does. Nothing gets lost.', focus: '0% 80%' },
  { id: 'changes', title: 'Changes and review', text: 'Each change in the colour of the session that made it. Commit from there.', focus: '96% 11%' },
  { id: 'workspace', title: 'Split view', text: 'Sessions, terminals and files, up to three side by side.', focus: '53% 0%' },
  { id: 'docker', title: 'Docker', text: 'Logs and why a container stopped. Read-only.', focus: '20% 74%' },
  { id: 'redis', title: 'Redis', text: 'Keys and queues, failed jobs with their stack.', focus: '2% 71%' },
  { id: 'databases', title: 'Databases', text: 'Your Postgres, browsed in a read-only transaction.', focus: '50% 80%' },
  { id: 'automations', title: 'Automations', text: 'ClickUp, Notion or Jira tasks that start a session.', focus: '0% 12%' },
  { id: 'dictation', title: 'Dictation', text: 'Hold ⌥Space and talk. Transcribed on your computer.', focus: '39% 100%' }
];

/** "Your Claude. Your Mac.". Accounts are never counted: Atelier has no limit. The last cell matches the privacy
 *  page: update checks reach useatelier.dev with the version, never anything about the user's work. */
export const yourMac: MacCell[] = [
  { title: 'The real CLI', mono: 'claude', text: 'Its status line, its commands, its updates.' },
  { title: 'All your Claude accounts', mono: 'personal · work · …', text: 'Add as many as you have. Pick one for each session, its limits in view.' },
  { title: 'Sessions stay alive', mono: 'atelierd', text: 'Quit, update or restart. Busy sessions keep going.' },
  { title: 'Nothing about your work', mono: 'no account', text: 'No account, no tracking. Update checks carry the app version, never your projects.' }
];

/** The home's questions, the first open. */
export const faq: FaqItem[] = [
  { q: 'Is it free?', a: ['Yes, and open source under the MIT license: the code is ', { text: 'on GitHub', href: REPO_URL }, '. You need Claude Code and your own Claude plan; Atelier adds nothing to pay. If it helps you, you can ', { text: 'support it', href: '/support' }, ' with what you like.'] },
  { q: 'Does it use my Claude subscription?', a: ['Every session is your own claude CLI, signed in as you, under your account and its terms. More than one subscription? Pick the account for each session.'] },
  { q: 'What happens when I quit or update?', a: ['A background service owns your terminals. Busy sessions keep running, idle ones wait under Resume, and updates install on restart without closing sessions.'] },
  { q: 'Does my code leave my computer?', a: ['Only through your own Claude Code, as without Atelier: your sessions, and Ask or commit messages when you use them. Atelier has no account and no tracking, and dictation is transcribed on your computer. The ', { text: 'privacy page', href: '/privacy' }, ' lists everything the app sends.'] },
  { q: 'Which systems does it run on?', a: ['macOS 13 or later on Apple Silicon, notarized by Apple. Windows 10 and 11 through the Microsoft Store.'] }
];
