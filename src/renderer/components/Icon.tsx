const paths = {
  sessions: <path d="M3.5 4.5h13v9h-8l-5 3.5z" />,
  files: <path d="M3 5h5l2 2h7v9H3z" />,
  // A file tab (a workspace card counts them).
  file: <><path d="M6 2.5h5.5L15 6v11.5H6z" /><path d="M11.5 2.5V6H15" /></>,
  // A workspace: two stacked panes, the brand mark's shape.
  workspace: <><rect x="6" y="2.5" width="11" height="9.5" rx="2.4" /><rect x="3" y="7" width="11" height="9.5" rx="2.4" /></>,
  // An activity inside a workspace: the same two panes in outline, the back one behind the front one.
  wsActivity: <path d="M6.5 6.6V5.4a1.9 1.9 0 0 1 1.9-1.9h6.7a1.9 1.9 0 0 1 1.9 1.9v6.2a1.9 1.9 0 0 1-1.9 1.9h-.5M4.9 6.8h7.8a1.9 1.9 0 0 1 1.9 1.9v6.4a1.9 1.9 0 0 1-1.9 1.9H4.9A1.9 1.9 0 0 1 3 15.1V8.7a1.9 1.9 0 0 1 1.9-1.9z" />,
  services: <><rect x="3" y="4" width="14" height="5" rx="1.2" /><rect x="3" y="11" width="14" height="5" rx="1.2" /><path d="M6 6.5h.01M6 13.5h.01" /></>,
  // Classic 8-tooth gear (it used to be a sun, which looked like the light theme).
  settings: <><path d="M8.53 3.87L8.7 1.8h2.6l.17 2.07 1.82.76 1.59-1.34 1.83 1.83-1.34 1.59.76 1.82 2.07.17v2.6l-2.07.17-.76 1.82 1.34 1.59-1.83 1.83-1.59-1.34-1.82.76-.17 2.07H8.7l-.17-2.07-1.82-.76-1.59 1.34-1.83-1.83 1.34-1.59-.76-1.82-2.07-.17V8.7l2.07-.17.76-1.82-1.34-1.59 1.83-1.83 1.59 1.34z" /><circle cx="10" cy="10" r="2.6" /></>,
  search: <><circle cx="9" cy="9" r="5.5" /><path d="M13 13l4 4" /></>,
  plus: <path d="M10 4v12M4 10h12" />,
  // Three dots (a row's "More" menu): drawn with a heavier stroke.
  more: <path d="M5 10h.01M10 10h.01M15 10h.01" />,
  // Windows' application menu button in the header.
  menu: <path d="M4 6h12M4 10h12M4 14h12" />,
  mic: <><rect x="7.5" y="2.5" width="5" height="9" rx="2.5" /><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5M7.5 17.5h5" /></>,
  stop: <rect x="5.5" y="5.5" width="9" height="9" rx="2" />,
  terminal: <path d="M4 6l4 4-4 4M10 15h6" />,
  maximize: <path d="M12 3h5v5M8 17H3v-5M17 3l-6 6M3 17l6-6" />,
  git: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="15" r="2" /><circle cx="14" cy="7" r="2" /><path d="M6 7v6M14 9c0 3-4 3.5-8 4" /></>,
  x: <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />,
  chevron: <path d="M7.5 5l5 5-5 5" />,
  chevronDown: <path d="M5 7.5l5 5 5-5" />,
  chevronLeft: <path d="M12.5 5l-5 5 5 5" />,
  check: <path d="M4.5 10.5l3.5 3.5 7.5-8" />,
  folderOpen: <path d="M3 6V5h5l2 2h6v2M3 15l2.5-6H18l-2.5 6z" />,
  resume: <><path d="M4 10a6 6 0 1 0 2-4.5" /><path d="M4 3.5V6h2.5" /></>,
  restart: <><path d="M16 10a6 6 0 1 1-1.8-4.3" /><path d="M16 3.5v3.6h-3.6" /></>,
  sparkle: <path d="M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6z" />,
  // Ask: the sessions bubble with a small sparkle inside, filled (a stroked one blurs at 14 px).
  ask: <><path d="M3.5 4.5h13v9h-8l-5 3.5z" /><path d="M10 6.4l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z" fill="currentColor" stroke="none" /></>,
  appearance: <><circle cx="10" cy="10" r="6.5" /><path d="M10 3.5v13M10 6.5h3.5M10 10h4.5M10 13.5h3.5" /></>,
  code: <path d="M7 6l-4 4 4 4M13 6l4 4-4 4" />,
  bell: <><path d="M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5H4z" /><path d="M8.5 17.2h3" /></>,
  keyboard: <><rect x="2.5" y="5.5" width="15" height="9" rx="1.8" /><path d="M5.5 8.5h.01M8.5 8.5h.01M11.5 8.5h.01M14.5 8.5h.01M6.5 11.5h7" /></>,
  info: <><circle cx="10" cy="10" r="7" /><path d="M10 9v4.5M10 6.5h.01" /></>,
  compact: <path d="M4 8.5h12M4 11.5h12M7 2.5l3 2.5 3-2.5M7 17.5l3-2.5 3 2.5" />,
  expand: <path d="M4 8.5h12M4 11.5h12M7 5l3-2.5L13 5M7 15l3 2.5 3-2.5" />,
  collapseAll: <path d="M6 3.5l4 4 4-4M6 16.5l4-4 4 4" />,
  chevronUp: <path d="M5 12.5l5-5 5 5" />,
  phone: <><rect x="5.5" y="2.5" width="9" height="15" rx="2.2" /><path d="M8.8 14.8h2.4" /></>,
  inbox: <><path d="M3 11l2.1-5.9A1.5 1.5 0 0 1 6.5 4h7a1.5 1.5 0 0 1 1.4 1.1L17 11v4a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15z" /><path d="M3 11h4l1.2 2h3.6L13 11h4" /></>,
  // Pushpin: the head is a closed shape, so `fill: currentColor` (pinned rows) fills it.
  pin: <><path d="M8.5 3.5h3v4l2.5 3h-8l2.5-3z" /><path d="M7.5 3.5h5M10 10.5V17" /></>,
  // The Shelf: two books and a leaning one on a shelf.
  shelf: <><path d="M3 16.5h14" /><path d="M5 16.5v-9h3v9M9.5 16.5V5h3v11.5" /><path d="M13.8 16.3l-.9-7.4 2.6-.4 1 7.5" /></>,
  eye: <><path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z" /><circle cx="10" cy="10" r="2.2" /></>,
  'eye-off': <><path d="M4.6 6.4C3.3 7.7 2.5 10 2.5 10s2.8 5 7.5 5c1.3 0 2.5-.4 3.5-1M8 5.3c.6-.2 1.3-.3 2-.3 4.7 0 7.5 5 7.5 5s-.6 1.1-1.7 2.3" /><path d="M3 3l14 14" /></>,
  // Review: lines of a diff under a magnifier.
  review: <><path d="M3.5 5h9M3.5 8.5h5M3.5 12h3.5" /><circle cx="13" cy="12.5" r="3" /><path d="M15.2 14.7l2.3 2.3" /></>,
  // Changes' Filters: a funnel.
  filter: <path d="M3.5 4.5h13l-5 6.2v4.8l-3 1.5v-6.3z" />,
  // Line comment: a speech bubble with a line of text.
  comment: <><path d="M4 4.5h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H9l-3.5 3v-3H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" /><path d="M6.5 8h7M6.5 10.5h4.5" /></>,
  // Send to a session: a paper plane.
  bolt: <path d="M11.5 2.5L4.5 11.2h5l-1 6.3 7-8.7h-5z" />,
  trash: <><path d="M3.5 5.5h13M8 5.5V3.8h4v1.7M5.3 5.5l.8 10.7h7.8l.8-10.7" /><path d="M8.5 8.5v5M11.5 8.5v5" /></>,
  send:<><path d="M3 9.5l14-6-5 14-2.5-6z" /><path d="M9.5 11.5L17 3.5" /></>,
  // Pull request states: a branch line on the left, the PR's end on the right.
  prOpen: <><circle cx="6" cy="4.8" r="1.9" /><circle cx="6" cy="15.2" r="1.9" /><circle cx="14" cy="15.2" r="1.9" /><path d="M6 6.7v6.6M14 13.3V8.6a2.4 2.4 0 0 0-2.4-2.4H10.2" /><path d="M12 4.4l-1.8 1.8L12 8" /></>,
  prDraft: <><circle cx="6" cy="4.8" r="1.9" /><circle cx="6" cy="15.2" r="1.9" /><circle cx="14" cy="15.2" r="1.9" /><path d="M6 6.7v6.6M14 5.2v.01M14 9.2v.01" /></>,
  prMerged: <><circle cx="6" cy="4.8" r="1.9" /><circle cx="6" cy="15.2" r="1.9" /><circle cx="14" cy="11" r="1.9" /><path d="M6 6.7v6.6M6 6.7c.4 2.6 2.6 4.3 6.1 4.3" /></>,
  prClosed: <><circle cx="6" cy="4.8" r="1.9" /><circle cx="6" cy="15.2" r="1.9" /><circle cx="14" cy="15.2" r="1.9" /><path d="M6 6.7v6.6M14 10.2v3.1M12.2 4.2l3.6 3.6M15.8 4.2l-3.6 3.6" /></>,
  // Split view: a window in two columns; the arrows step between panes.
  split: <><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M10 4v12" /></>,
  // Show or hide the sidebar: a window with its left column.
  sidebar: <><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M8 4v12" /></>,
  splitFocus: <><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M10 4v12M5.5 10h2.5M7 8.6l1.4 1.4L7 11.4" /></>,
  // Scheduled wake-ups.
  clock: <><circle cx="10" cy="10" r="7" /><path d="M10 6.2V10l2.6 1.8" /></>,
  // Scheduled prompts: a clock that sends — an arc open toward a small paper plane.
  sendLater: <><path d="M16.2 9.2A6.6 6.6 0 1 0 10.6 16.7" /><path d="M9.6 6.6v3.6l2.3 1.4" /><path d="M13 15.6l4.6-2.4-1.6 4.9-1-1.7z" /></>,
  // Automations: a cycle around a play mark — work that starts by itself (the bolt is Background's).
  automation: <><path d="M15.6 7.6A6.2 6.2 0 1 0 16.2 11" /><path d="M16.4 4.6v3.3h-3.3" /><path d="M8.6 7.6v4.8l3.9-2.4z" /></>,
  // Automations: Pause All / Resume All.
  pause: <path d="M7.5 5v10M12.5 5v10" />,
  play: <path d="M7 4.8v10.4L15.2 10z" />,
  // Unsplit: the same window with no divider, its two halves folding into one (the tab stays open).
  unsplit: <><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M5.6 10h2.6M6.8 8.4L8.4 10l-1.6 1.6M14.4 10h-2.6M13.2 8.4L11.6 10l1.6 1.6" /></>,
  // Connectors: a plug, its two prongs and the cord.
  plug: <><path d="M7.5 3v3.5M12.5 3v3.5" /><path d="M5 6.5h10v2.5a5 5 0 0 1-10 0z" /><path d="M10 14v3.5" /></>,
  // Connectors with chosen sources: Notion's mark and a database.
  notion: <><rect x="4" y="3.5" width="12" height="13" rx="2.5" /><path d="M7.5 13.2V7l5 6.2V7" /></>,
  // Jira: our own diamond pair, never Atlassian's logo.
  jira: <><path d="M10 2.8L17.2 10 10 17.2 2.8 10z" /><path d="M10 7l3 3-3 3-3-3z" /></>,
  database: <><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M3 8h14M8 8v8" /></>,
  // Session panel: two sliders, a session's settings.
  sliders: <><path d="M3.5 6.5h7M15 6.5h1.5M3.5 13.5h1.5M9.5 13.5h7" /><circle cx="12.8" cy="6.5" r="2.1" /><circle cx="7.2" cy="13.5" r="2.1" /></>,
  // Context usage: a pie with one slice out.
  pie: <><path d="M9 4a6.5 6.5 0 1 0 6.5 6.5H9z" /><path d="M11.5 2.5v5.5H17a5.5 5.5 0 0 0-5.5-5.5z" /></>,
  // Copy: a sheet over another.
  copy: <><rect x="7" y="7" width="9.5" height="9.5" rx="1.8" /><path d="M13 7V5.2a1.7 1.7 0 0 0-1.7-1.7H5.2a1.7 1.7 0 0 0-1.7 1.7v6.1A1.7 1.7 0 0 0 5.2 13H7" /></>,
  // Clear (/clear): an eraser over its line.
  eraser: <><path d="M8.2 16.5h8.3" /><path d="M4.3 12.4l6.6-6.6a1.6 1.6 0 0 1 2.3 0l2.6 2.6a1.6 1.6 0 0 1 0 2.3l-5.4 5.4a1.3 1.3 0 0 1-.9.4H7.3a1.3 1.3 0 0 1-.9-.4l-2.1-2.1a1.1 1.1 0 0 1 0-1.6z" /><path d="M8 8.8l4.6 4.6" /></>,
  // Source Control: a tag, a lock (read-only), a worktree (a branch with its own folder), a
  // stash (a box), swap sides, compare (two branches side by side), a commit node.
  tag: <><path d="M3 3.5h6.5l7.5 7.5-6 6-7.5-7.5z" /><circle cx="7" cy="7.5" r="1" /></>,
  lock: <><rect x="4" y="9" width="12" height="8" rx="1.5" /><path d="M7 9V6.5a3 3 0 0 1 6 0V9" /></>,
  worktree: <><path d="M3 6.5h5l1.5 1.5H17v8H3z" /><circle cx="8" cy="12" r="1.4" /><path d="M9.4 12H13" /></>,
  stash: <><rect x="3" y="4" width="14" height="4" rx="1" /><path d="M4.5 8v7.5h11V8M8 11h4" /></>,
  swap: <path d="M5 7h10l-3-3M15 13H5l3 3" />,
  sync: <path d="M7 16V4M4 7l3-3 3 3M13 4v12M10 13l3 3 3-3" />,
  arrowDown: <><path d="M10 4v12" /><path d="M5 11l5 5 5-5" /></>,
  // Worktrees in Changes: a branch leaving the trunk, and two lines joining (the same file on two branches).
  branchOff: <><path d="M6 3v14" /><path d="M6 8c0 3 4 3 7 3h3" /><path d="M13.5 8.5L16 11l-2.5 2.5" /></>,
  meet: <><path d="M4 4c0 5 6 4 6 9v3" /><path d="M16 4c0 5-6 4-6 9" /></>,
  compare: <><circle cx="5.5" cy="5" r="1.8" /><circle cx="14.5" cy="15" r="1.8" /><path d="M5.5 6.8V15h6M14.5 13.2V5h-6" /><path d="M10 13l1.5 2-1.5 2M10 3l-1.5 2L10 7" /></>,
  commit: <><circle cx="10" cy="10" r="3" /><path d="M2.5 10h4.5M13 10h4.5" /></>,
  // Fetch: a turning arrow around a down arrow; it spins while a fetch runs.
  fetch: <><path d="M16.2 8.2A6.5 6.5 0 1 0 15.6 13" /><path d="M16.5 3.8v4.6h-4.6" /><path d="M10 6.8v5.4M7.9 10.2l2.1 2.1 2.1-2.1" /></>,
  // A person: "you said so" on a hand-resolved attribution, "someone outside Claude" in Why unsure.
  person: <><circle cx="10" cy="7" r="3.2" /><path d="M4 17c1.2-3 3.4-4.5 6-4.5s4.8 1.5 6 4.5" /></>,
  // A question in a circle: an unsure attribution.
  question: <><circle cx="10" cy="10" r="7" /><path d="M8 8a2 2 0 1 1 3 1.7c-.7.4-1 .9-1 1.6" /><path d="M10 14h.01" /></>,
  // ClickUp, in our own stroke: an up chevron over a wide arc (evokes the brand, not its artwork).
  clickup: <><path d="M5.5 9.5L10 5.2l4.5 4.3" /><path d="M4 12.6c1.7 2.1 3.7 3.2 6 3.2s4.3-1.1 6-3.2" /></>,
  // Soft wrap: a line that turns back under itself (the Background tab's log).
  wrap: <><path d="M3.5 5.5h13M3.5 14.5h4" /><path d="M3.5 10h10a2.25 2.25 0 0 1 0 4.5h-3.5" /><path d="M12 12.8l-1.8 1.7 1.8 1.7" /></>,
  // Docker: the whale, filled — the one exception to the stroked set (a stroked whale read as a
  // generic glyph). Our own drawing, containers stacked 5-3-1 on its back.
  whale: (
    <g fill="currentColor" stroke="none">
      <path d="M1.6 10.6h14.1c.4-1.5 1.7-2.4 3.2-2.2.3.1.1.5 0 .7-.4.9-1.2 1.5-2.2 1.6-1.4 3.8-4.8 6.1-9 6.1-3.6 0-5.8-2.4-6.1-6.2z" />
      <rect x="3" y="8.1" width="1.9" height="1.9" rx=".3" /><rect x="5.3" y="8.1" width="1.9" height="1.9" rx=".3" /><rect x="7.6" y="8.1" width="1.9" height="1.9" rx=".3" />
      <rect x="9.9" y="8.1" width="1.9" height="1.9" rx=".3" /><rect x="12.2" y="8.1" width="1.9" height="1.9" rx=".3" />
      <rect x="5.3" y="5.8" width="1.9" height="1.9" rx=".3" /><rect x="7.6" y="5.8" width="1.9" height="1.9" rx=".3" /><rect x="9.9" y="5.8" width="1.9" height="1.9" rx=".3" />
      <rect x="9.9" y="3.5" width="1.9" height="1.9" rx=".3" />
    </g>
  ),
  externalLink: <path d="M8 4.5H4.5v11h11V12M11 4h5v5M16 4l-7 7" />,
  // Redis: three stacked rhombuses, stroked — ours, not Redis's mark.
  redis: <><path d="M10 3.2l7 3.4-7 3.4-7-3.4z" /><path d="M3 10.1l7 3.4 7-3.4" /><path d="M3 13.5l7 3.4 7-3.4" /></>,  // A pencil (Edit), a list of rows (queues and jobs), a pulse (the live monitor).
  edit: <><path d="M12.6 4.6l2.8 2.8L7.6 15.2l-3.4.6.6-3.4z" /><path d="M11.2 6l2.8 2.8" /></>,
  list: <><path d="M7.5 5.5h9M7.5 10h9M7.5 14.5h9" /><path d="M3.8 5.5h.01M3.8 10h.01M3.8 14.5h.01" /></>,
  // Source Control's views: one repository's card, every repository's block.
  repoOne: <rect x="3.5" y="5" width="13" height="10" rx="2.6" />,
  repoAll: <><rect x="3.5" y="3.5" width="13" height="3.6" rx="1.2" /><rect x="3.5" y="8.2" width="13" height="3.6" rx="1.2" /><rect x="3.5" y="12.9" width="13" height="3.6" rx="1.2" /></>,
  pulse: <path d="M2.5 10.5h3.2l1.8-4.5 3 9 2-6.5 1.3 2h3.7" />,
  // Markdown preview: the outline (a list of headings, the last one indented), a picture, a picture that didn't load,
  // back to the top, warning and caution alerts.
  outline: <><path d="M7.5 5h9M7.5 10h9M10 15h6.5" /><path d="M3.5 5h.01M3.5 10h.01M6 15h.01" /></>,
  // JSON navigation: a stem with two branches; Unfold All mirrors collapseAll.
  // CSV viewer: the Table view, a grid.
  table: <><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M3 8.5h14M3 12.5h14M8 8.5V16" /></>,
  tree: <><path d="M5 3.5v11a2 2 0 0 0 2 2h4M5 8.5h6" /><circle cx="14" cy="8.5" r="2" /><circle cx="14" cy="16.5" r="2" /></>,
  unfoldAll: <path d="M6 7.5l4-4 4 4M6 12.5l4 4 4-4" />,
  path: <path d="M4 15l4-10M9 15l4-10M3 8h12M2.5 12h12" />,
  image: <><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M3 13l4-4 3 3 2-2 5 5" /><circle cx="13" cy="7.8" r="1.1" /></>,
  imageOff: <><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M3 13l4-4 3 3 2-2 5 5" /><path d="M2.5 2.5l15 15" /></>,
  arrowUp: <><path d="M10 16V4" /><path d="M5 9l5-5 5 5" /></>,
  window: <><rect x="3" y="6" width="11" height="11" rx="2" /><path d="M9 3h8v8M17 3l-7 7" /></>,
  // Move back into the main window: the window's frame, open at its top-right corner, an arrow coming in through it
  // (the mirror of `window`, whose arrow goes out).
  dock: <><path d="M10 3.5H5.5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V10" /><path d="M17 3l-7.5 7.5M9.5 5.5v5h5" /></>,
  // A pop-out's handle (two columns of three dots, ⋮⋮): drawn with a heavier stroke, like More.
  grip: <path d="M7.5 5h.01M12.5 5h.01M7.5 10h.01M12.5 10h.01M7.5 15h.01M12.5 15h.01" />,
  warning: <><path d="M10 3.5l7 12.5H3z" /><path d="M10 8.5v3.5M10 14.2v.01" /></>,
  caution: <><path d="M7 3h6l4 4v6l-4 4H7l-4-4V7z" /><path d="M10 6.8v4M10 13.3v.01" /></>,
  // Launch flags: a flag, and a shield struck through for skipped permissions.
  flag: <path d="M5 17V3.5h8.5l-1.8 3.2 1.8 3.3H5" />,
  // Databases: the cylinder. A table (a header row and a first column), a view
  // (a table seen through a lens) and a materialized view (a table with a stored copy behind it), for tabs and the catalog.
  databases: <><ellipse cx="10" cy="5.2" rx="6" ry="2.2" /><path d="M4 5.2v9.6c0 1.2 2.7 2.2 6 2.2s6-1 6-2.2V5.2" /><path d="M4 10c0 1.2 2.7 2.2 6 2.2s6-1 6-2.2" /></>,
  dbTable: <><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M3 8.5h14M8 8.5V16" /></>,
  record: <><rect x="3" y="3.5" width="14" height="13" rx="2" /><path d="M6 7.5h2M10.5 7.5h3.5M6 10.5h2M10.5 10.5h3.5M6 13.5h2M10.5 13.5h2" /></>,
  view: <><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M3 8.5h14" /><path d="M6.5 12.3c1-1.3 2.2-2 3.5-2s2.5.7 3.5 2c-1 1.3-2.2 2-3.5 2s-2.5-.7-3.5-2z" /></>,
  matview: <><rect x="3" y="6" width="12" height="11" rx="2" /><path d="M3 10.3h12M7.5 10.3V17" /><path d="M6 3h9a2 2 0 0 1 2 2v9" /></>,
  // An enum (two value chips), a function (ƒ), a primary key, a foreign key's arrow, a JSON key taken out as a column
  // (a branch), Refresh.
  enumList: <><rect x="3" y="4" width="9" height="4.6" rx="2.3" /><rect x="8" y="11.4" width="9" height="4.6" rx="2.3" /></>,
  fn: <><path d="M13.5 4.2c-.5-.5-1.1-.7-1.8-.7-1.2 0-2 .8-2.3 2.2L7.6 14.5c-.3 1.4-1.1 2.2-2.3 2.2-.6 0-1.2-.2-1.6-.6" /><path d="M7 8h6" /></>,
  key: <><circle cx="7" cy="12.5" r="3.2" /><path d="M9.3 10.2L16 3.5M13.5 6l2 2" /></>,
  fkArrow: <path d="M7 13l6-6M8.5 7H13v4.5" />,
  jsonBranch: <path d="M6 4v6.5a3 3 0 0 0 3 3h7M13 10.5l3 3-3 3" />,
  refresh: <><path d="M15.5 8A6 6 0 0 0 4.6 7M4.5 12a6 6 0 0 0 10.9 1" /><path d="M4.5 3.5V7H8M15.5 16.5V13H12" /></>,
  shieldOff: <><path d="M10 2.5 4 5v4.6c0 3.7 2.6 6.8 6 7.9 3.4-1.1 6-4.2 6-7.9V5z" /><path d="M7.5 7.5l5 5M12.5 7.5l-5 5" /></>
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 18, stroke = 1.6 }: { name: IconName; size?: number; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
