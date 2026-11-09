# Changelog

Release notes for Atelier. Each version has a `## <version>` section: the release workflow requires it and the app
shows it in Settings › About and in "What's new".

## 0.2.0-beta.28

- **Databases**: browse your Postgres, read-only. Open it from View › Databases (⌃⇧B, Ctrl+Shift+B on Windows) and add
  a connection — on your Mac, in Docker or remote, directly or through an SSH tunnel; passwords are stored encrypted,
  like the connectors' tokens. Tables open like files (a preview tab a double click keeps) and load as you scroll, with
  filters, sort and a row inspector that follows foreign keys both ways; JSON reads as a tree, and Tab on a row shows it
  whole as a record. Each table's structure, indexes, relations and DDL, an overview of what the server is running, a
  database switcher. Send rows or a table's schema to a session (Mask values hides emails and secrets first). Every
  query runs in a read-only transaction: nothing in the view can change your data. Its icon stays in the activity bar
  once a connection is saved (Settings › Databases).
- **Split view with tab groups**: each pane has its own tabs. New tabs open in the focused pane; drag a
  tab into another pane's strip, or onto a pane's edge for a new pane, or use Move to Left/Right Pane (⌃⌘←/→,
  Ctrl+Alt+Shift+arrows on Windows). A pane closes with its last tab; its × unsplits and moves its tabs next door
  without closing anything. Each workspace keeps its own layout.
- **Spaces**: Docker, Redis, Databases and Automations each keep their own tabs and split, and the activity bar switches
  between them; Sessions keeps your sessions, terminals and files. Docker opens a tab for its overview, each Compose
  project and each container, Redis one per view (Keys, Queues, Live, Overview), Automations one per automation.
- **Source Control › All Repositories**: every repository of Changes in one view, each with its branch, its message
  and one button (Commit, Sync or Publish Branch), and Sync All on top (Pull, Push, Fetch or Commit All). Switch with
  One ⇄ All in the head, or Show All Repositories in ⌘K. Sync buttons say what they do: Pull, Push or Sync.
- **Commit with nothing staged** asks to stage all your changes and commit them; Always remembers the answer (Settings ›
  Source Control › When nothing is staged: Ask, Stage all, Don't commit). The commit drawer has Stage All.
- **Word wrap** from where you are: View › Word Wrap, ⌥Z in an editor (Alt+Z on Windows), or Toggle word wrap in ⌘K.
- **Videos play in a tab** (mp4, mov, webm…), and text files up to 50 MB open plain and read-only with Open Anyway.
- **Narrow layouts**: in a narrow sidebar, chips shrink to their glyph before they cut a name, a terminal shows its
  first port and a count, row questions fit, and the smallest window keeps a work area.
- **A quieter look**: no halos or glows under the pointer, flat selections, nothing lifts or grows; only what waits for
  you breathes. The brand color is the logo's own.
- The **+** in the Sessions head offers New Claude Session (⌘N) or Session in Folder… (⌘⌥⇧N, Ctrl+Alt+Shift+N on
  Windows).
- On macOS the cobalt and gold themes give Atelier their icon in the Dock, ⌘Tab, Finder and Spotlight; every other
  theme keeps Aurora's.
- A turn interrupted with Esc before Claude wrote anything goes back to ready instead of reading "working". The Sync
  button is right the moment a pull, push or sync ends. A clicked tab comes whole into view.

## 0.2.0-beta.27

- **A quieter sidebar**, with one thing lit at a time: toggles light only their icon, Changes and the active view lose
  their box, waiting sessions keep their amber ring and line without a frame. Numbers sit on the sidebar's areas
  (Sessions, Terminals…), never beside states. A + in the Sessions and Terminals heads, and on each workspace, starts a
  session or a terminal right there.
- **Workspaces as groups** in the sidebar, in place of cards: the chevron folds or opens one without leaving yours, its
  name switches to it, and a row of another workspace takes you there in one click. Drop a row or a tab on a
  workspace's head to move it.
- **Readable diffs**: fuller colors, tinted gutters, removed text no longer faded, and the words that changed inside a
  line are marked.
- **Overview ruler**: beside files and diffs, in place of the scrollbar, it shows where the changes, Find's matches and
  the cursor are. Click a mark to go there, drag the thumb to scroll.
- **A quieter session bar**: one discreet chip with the context ring and the model opens the Session panel, which now
  shows lines, cost and context. Ask is a discreet chip too (⌘I as before, Ctrl+Shift+I on Windows), and its panel no
  longer repeats the session's state under its header. On narrow bars the chip stays.
- **Changes**: grouping, This workspace · All and Show folders sit behind a Filters funnel in the head, lit when the
  view isn't the usual one. Changes shows every change of the working tree by default, hand edits included; This
  workspace hides only the files other workspaces' sessions touched. All clean is one quiet line with each repository
  and its branch.
- A finished session's avatar no longer carries a check; a shelved file shows its name only (the folder is in its
  tooltip). New Session's limit bars read on the picked account card in every theme.

## 0.2.0-beta.26

- **Terminal font**: pick any monospaced font installed on your computer in Settings › Terminal › Font, or with Change
  Terminal Font… (View menu and ⌘K), which previews each font on the window's terminals as you move through the list.
  Enter keeps it, Esc goes back. The editor keeps its own font.
- **Move a tab to another project's window**: a file or a plain terminal goes to another open project with Move to
  Window › in its tab or row menu, Move Tab to “…” in ⌘K, or by dragging the tab or a pop-out over that window. A file
  brings its unsaved changes along; Claude sessions stay in their project.
- **Ask**: select any part of an answer and copy it formatted (bold, lists and code paste as such into documents and
  chats); Copy Thread copies the whole conversation. Catch Me Up works any time: a button beside the question box, the
  ⋯ menu, or Catch Me Up on This Session in ⌘K.
- **Two cobalt and gold themes**, a light one and a dark one, in Settings › Appearance and Change Theme…. The Λ mark
  inside the window takes each theme's colors.
- **Workspaces in every project**: Settings › Appearance › Use workspaces in every project turns them on everywhere at
  once; turned off again, each project goes back to its own choice.
- **Services and Automations are off until you turn them on**: Services (tmux) in Settings › Appearance, Use automations
  in Settings › Automations. If you already have automations, they stay on.
- **A quieter session bar**: above a single terminal it no longer repeats the session's avatar and name, which the tab
  right above shows; split panes and pop-outs keep both. The hint that Claude gets a new name with your next message is
  on the tab now.
- **Palette search**: free text (resume:, conversations, tasks, scheduled prompts) finds the words you typed, close
  together and in any order, accents ignored, instead of letters scattered over a long first prompt.
- The Session panel's chosen model stays readable while Claude works, and its quick actions fit, Restart When Done
  included. Shelf rows keep their chips at the end of the row; a session's account chip never shrinks to one letter.
- **Windows**: the terminal font pickers list the PC's monospaced fonts (Cascadia Code, Consolas…).

## 0.2.0-beta.25

- **Ask**: a read-only companion inside each session. Ask About This Session (⌘I, Ctrl+Shift+I on Windows; the Ask pill
  in the session bar, the session's menus, ⌘K) opens a panel beside the terminal to ask about that session without
  interrupting it. Catch me up lists your requests as done, in progress or not started, where it is and the choices it
  made; any other question gets an answer with file chips that open the editor; Use as prompt puts it in Claude's
  prompt without sending it. It reads the session's chat and code and never writes. Each question runs Claude Code on
  your account: Settings › Ask picks the model, the account and the length of the answers.
- **Workspaces**: keep parallel fronts of a project apart. Turn them on per project (View › Toggle Workspaces for This
  Project); each workspace has its own sessions, terminals, tabs and split, and can have its own folder, where its new
  sessions and terminals start. New Workspace… (⌘⌥T), Go lists them with ⌘⌥1…9 (Ctrl+Alt+1…9 on Windows), `#` in ⌘K.
  The active one fills the sidebar, the others are cards: drop a row or a tab on a card to move it. Changes shows
  This workspace or All.
- **Restart Session** quits and resumes a conversation in the same terminal, so Claude loads its settings and MCP
  servers again (session menus, Session panel, ⌘K). While Claude works, Restart When Done waits for the turn. A New MCP
  chip marks sessions started before an MCP server was added (Settings › Claude › Notice new MCP servers).
- **Keep closed sessions under Resume** (Settings › Claude, off by default): closing a Claude session stops it and
  frees its memory; it waits under Resume in the sidebar until you resume or dismiss it.
- **Usage limits**: when Claude Code continues a turn by itself after your usage limit resets (2.1.234 and later), the
  session reads "Usage limit · continues at HH:MM" under Working instead of an error, raises no notification, and
  Atelier never types into it; scheduled prompts wait for it. Settings › Claude › Claude Code compatibility lists what
  Claude Code sends that Atelier doesn't recognize yet: names and codes only, kept on this computer, ready to copy.
- **Settings**: the Terminal and Editor previews stay in view while you scroll their rows.
- A full-screen Claude scrolls right after a restart or an update, without typing first. The sidebar marks the tab in
  front: a file in front no longer leaves the last session selected. A terminal row's Pin and Close take no room until
  you point at the row, so its chips reach the end. Staging checkboxes in Changes show the click at once.
- **Windows**: Ask works on Windows too; Atelier finds Claude Code installed with npm, WinGet or Scoop (✦ messages said
  it was missing); before Windows 11 24H2 a session closes at once instead of after a few seconds.
- Restart atelierd when convenient (File › Restart atelierd…, it closes running sessions): it turns on the usage-limit
  pause and the compatibility notes, keeps a session's task link when its resume stops early, restores other
  full-screen programs' mouse and cursor after a reopen, and brings the faster close on Windows.

## 0.2.0-beta.24

- **Not released**: its Windows build stopped on another timed test, for the same reason as 0.2.0-beta.23.
  Everything it was meant to bring is in 0.2.0-beta.25.

## 0.2.0-beta.23

- **Not released**: its Windows build stopped on two timed tests during a slow spell of the build machine.
  Everything it was meant to bring is in 0.2.0-beta.25.

## 0.2.0-beta.22

- **Themes**: Aurora, Daylight, Minimal · Ink, Minimal · Paper, Ember and Tide. Pick one in Settings › Appearance, or
  with Change Theme… (View menu and ⌘K), which previews each theme as you move through the list. Terminals and the
  editor follow the theme; with a light one, terminals can stay dark (Settings › Appearance › Terminal colors).
- **Closing a window** stops its idle sessions and asks when some are busy: Keep in Background or Stop and Close. ⌘Q
  asks once. The Shelf always survives a close. It needs a restart of atelierd (File › Restart atelierd…), which
  closes running sessions; until then a close keeps everything running, as before.
- **Resume All and Resume Pinned** bring the sessions under Resume back one at a time, with a progress strip at the top
  of Sessions and a Stop button. A conversation that can't be resumed ends the wait instead of holding the run.
- **A cleaner session bar**: the state chip and the phone, Changes and close buttons are gone (all still in the
  session's row, tab bar and menus). "Starting…" stays visible in a narrow bar.
- **Welcome window**: forget a recent folder with the × on its row, or Delete on the focused row.
- **Changes**: a worktree's fold chevron sits at the right end of its header.
- **Windows**: updates come from the Microsoft Store inside Atelier. Help › Check for Updates… asks the Store; on
  Windows 11 24H2 and later the update installs in the background and the footer offers Update ready · Restart, on
  earlier versions Update available · Open Microsoft Store.

## 0.2.0-beta.21

- **Scheduled prompts**: write a session's next prompt now and pick when it goes: in an hour, tomorrow at nine, or
  right after your usage limit resets. Schedule Prompt… (⌘⌥↵) in the session's menus and ⌘K. At that time Atelier
  types it in once Claude is free, waiting or skipping a busy turn as you choose, even with the app closed. It turns
  on after a restart of atelierd (File › Restart atelierd…), which closes running sessions.
- **Shelf**: drag a file tab onto the Sessions sidebar to keep it at hand, one shelf per project, files outside the
  project too. Add to Shelf in the tab and tree menus and ⌘K; reorder by dragging or with Move Up/Down; a row dropped
  on a terminal types its path.
- **Files opens on the file in front**: its folders expand and its row is marked.
- **Editor**: line endings follow the file's majority, and a lone CR shows the mixed-endings band; UTF-16 files with a
  BOM open as read-only text; edits stay unsaved, and saving says why, when the file on disk is no longer UTF-8; Keep
  Mine and Save never overwrite a version you haven't seen; a preview, tree or table that fails keeps unsaved changes.
- **Questions in the window**: always on top and in charge of the keys; the system dialog takes over if the window
  hangs; every window is asked about quitting.
- A repository git refuses to read (`safe.directory`) is never shown as clean, offers the command that fixes it, and
  ⌘K still finds its files. Closing a terminal shows "Closing…" in its row until it is gone.
- Enter and Esc of an input method's composition stay the input method's in ⌘K and dictation.
- **Windows**: AltGr characters in the editor, Ctrl+Shift+G for Source Control, F10 reaches full-screen programs,
  terminals no longer reflow on resize, a maximized window reopens maximized, mapped drives keep their letter, Git
  Bash paths (`/c/…`) open from terminals, signing out waits for unsaved files, dictation explains a CPU without
  AVX2. Restart atelierd when convenient to pick up its fixes (on the Mac too).

## 0.2.0-beta.20

- **Not released**: its build stopped on a check of these notes. Everything it was meant to bring is in 0.2.0-beta.21.

## 0.2.0-beta.19

- **CSV and TSV files as tables**: Source, Split and Table views, with a menu on each column, parse options, a band
  listing the rows that don't fit, Go to Row and a peek at long cells. Copy a selection as CSV or Markdown.
- **Launch flags for Claude**: Settings › Claude › Launch flags adds your own `claude` flags to every new session, for
  all accounts or one (model, settings, `--dangerously-skip-permissions`, shown with a Bypass badge). ⌥↵ in New Session
  starts one without them. Automations never use them.
- **Questions in the window, not in system dialogs**: closing a busy session or terminal asks in its row, unsaved files
  ask under their tab, Move to Trash in the tree row; quitting, reloading and Restart atelierd ask in an Aurora sheet.
- **One header bar**: New is the project chip's +, the usage meter is a pair of rings; on Windows, one bar for
  everything.
- **Automations are easier to set up**: folders and lists in searchable pickers, statuses, tags and people as chips
  with suggestions from ClickUp, Notion and Jira, due days typed in a stepper.
- **Changes**: the notice for files that several sessions touched is compact, sessions as avatars and files as chips.
- **Source Control is sturdier**: stashes applied and dropped only by their id, new branches that track nothing,
  pushes that name their remote, a gone upstream offered as Publish, History and counts that follow the right
  repository, linked worktrees and submodules read right, clearer messages when a hook stops a pull or a switch.
- **Windows**: Claude session states with a Git for Windows installed per user or a home folder with spaces, PATH as
  Windows' settings and your PowerShell profile leave it, Copy Path with `C:\…` paths. Restart atelierd (File ›
  Restart atelierd) when convenient to pick these up; restarting closes running sessions.
- The menu bar's session icon is a coloured disc with a dark Λ, level with the other icons.

## 0.2.0-beta.18

- **Not released**: its Windows build stopped on two tests. Everything it was meant to bring is in 0.2.0-beta.19.

## 0.2.0-beta.17

- **Automations: tasks that start themselves.** Pick a ClickUp list, a Notion database or a Jira project and what a
  task must match; when one does, Atelier starts a Claude session on it in a worktree of its own, even with no window
  open for the project, and says why. Runs never merge: you review them in the Automations view (⇧⌘A), with the
  decisions a run made on its own. Settings › Automations caps how many run at once, keeps the Mac awake and pauses
  them all. On the Mac and on Windows.
- **Jira tasks**: connect Jira in Settings › Connectors (Atlassian sign-in, or an API token), pick the projects or a
  saved filter Atelier may read, then `jira:` (or `task:`) in ⌘K. Read-only, like ClickUp and Notion.
- **Sessions in the menu bar**: Atelier's Λ for each session that needs you, in the colour of its state (amber waiting,
  rose on an error, green done and not seen yet); click it to open the session. On Windows, one icon in the
  notification area. Turn it off in Settings or the palette.
- **Windows**: Ctrl+V pastes in terminals, Claude sessions included; the menu folds behind a ☰ button; the empty
  workspace's buttons stay on one line.
- Claude sessions redraw from atelierd after the Mac wakes or a display changes, instead of staying garbled; View ›
  Redraw Terminal does it by hand.
- ClickUp task statuses keep their name and colour.

## 0.2.0-beta.16

- **Atelier for Windows**, in the Microsoft Store (Windows 10 2004 or later and Windows 11, x64): sessions with live
  states, the editor, terminals (PowerShell with command blocks, Command Prompt, Git Bash, WSL), Source Control, Docker,
  Redis and dictation, with a menu in the title bar and Windows shortcuts. Git for Windows is optional: without it
  Atelier works as an editor.
- **macOS: restart the background service when convenient** (File › Restart atelierd): its update prepares the Windows
  version; nothing changes on the Mac. Restarting closes running sessions, so pick a quiet moment.
- **Split panes are easier to tell apart**: every tab in a split carries its pane's number, hovering a tab lights its
  pane and the other way round, and each pane's X unsplits it.
- A Claude limit that resets early no longer sticks at its old percentage in the usage meter.
- A narrow terminal row keeps the terminal's name; the command gives way first.

## 0.2.0-beta.15

- **Commit, push and pull from Atelier**: stage files in Changes and commit from the drawer (⌥⌘K), with a message
  Claude writes from the staged diff and what you asked your sessions (✦, ⌥⌘M). Amend, Undo, Commit and Push, your
  hooks with their log, and Commit all for several repositories at once. Source Control syncs, pulls, pushes and
  publishes, switches, creates and deletes branches, and keeps your stashes; the new Git menu has it all. Discard moves
  files to the Trash first. Settings › Source Control › Git actions › Read-only keeps Atelier as it was.
- **A tab in its own window**: drag a tab out of the window, or Move Tab to New Window (⇧⌘O) from its menu, the
  sidebar or the palette. Terminals keep running, a file takes its unsaved edits and undo history along; Move Back,
  ⌘W or dragging the bar back into the window docks it. Pop-outs come back after a restart.
- **Notion tasks**: start sessions from Notion tasks too. Pick the databases Atelier may read in Settings ›
  Connectors, then `notion:` (or `task:` for every source) in ⌘K. Read-only, like ClickUp.
- **JSON as a tree**: JSON files get Source · Split · Tree (⇧⌘V). Filter the tree, copy a value's path (jq,
  JavaScript or JSON Pointer), Show in Source, read arrays of objects as a table; the source folds, and invalid JSON
  says where and why. Smooth up to 5 MB.
- **Images Claude reads or sends open from the terminal**, even when Claude wraps the path over several rows or lists
  bare names under a folder. Images in Claude's temp folder open read-only; folders open in Finder.
- **Self-paced `/loop` in the Background inspector**: the next check, why Claude picked that pace, and the checks so far.
- Each project window reopens where it was and as big; the arrow keys pick the account in New Session.
- `claude` subcommands (`claude rc`, `claude mcp`…) work in Atelier's terminals. Needs File › Restart atelierd.

## 0.2.0-beta.14

- **Claude accounts**: if you use more than one Claude config dir (`CLAUDE_CONFIG_DIR`), add them in Settings › Claude ›
  Accounts (Atelier offers the dirs it sees in your sessions). Pick the account in New Session, with its limits, or use
  File › New Session with Account and "New session as …" in the palette. Each session resumes, shows its settings and
  MCP servers, and polishes dictation with its own account; chips and the usage meter carry the account's name and
  color. With one account nothing changes.
- **A force quit never takes every session down**: atelierd and each terminal now run in launchd jobs of their own, so
  force-quitting Atelier, or an app started from one of its terminals (a browser, an editor), no longer ends every
  Claude session. Needs File › Restart atelierd.
- **Lighter at rest**: attention cues play a few cycles and then rest, nothing moves while the window is in the
  background, and the cursor stops blinking 10 s after you stop typing. Ports, git, tmux, PR checks and Redis are
  polled only when something can have changed, and dictation no longer wakes the GPU while idle.
- Keys typed while a new terminal is still connecting are kept instead of lost.
- The Notification Center header stays on one line, with an unread count.

## 0.2.0-beta.11

- **Docker, next to your sessions** (View › Docker, ⌃⇧D): Atelier finds Docker Desktop, OrbStack, Colima or Rancher
  Desktop on its own. Your project's compose stacks come first: logs of a container or of the whole stack, Inspect with
  "Why it stopped", resources, disk usage and events. Select log lines and send them to a session or ask in a new one.
  A notification when a container crashes, runs out of memory or turns unhealthy. Read-only: Atelier never changes
  your containers.
- **Redis, keys and queues** (View › Redis, ⌃⇧R): Atelier finds the Redis your project uses — from its `.env`, in
  Docker, in a terminal, from Homebrew. Browse keys and values, watch the queues of BullMQ, Bull, Sidekiq, Laravel,
  Celery, RQ, Asynq and Resque with their failed jobs, follow Live commands and the Overview, ask Claude why a job
  failed. Delete, TTL and edits ask first and can be undone for 30 s; Settings › Redis makes it read-only.
- **Markdown preview**: Markdown files get Source · Split · Preview in the file bar (⇧⌘V). GitHub alerts, tables,
  task lists, highlighted code, local images and an "On this page" outline; Split scrolls both sides together. Find,
  ⌘L and the change markers work in the preview too.
- **Open any file**: drop files from Finder on the window, File › Open File… (⌥⌘O), Open With in Finder, or the
  `atelier` command in a terminal (Atelier › Install 'atelier' Command). A file outside the project opens in a tab of
  its own, editable, without touching its folder. File tabs and the tab in front come back after a restart.
- **Send a selection to another terminal**: right-click works in full-screen Claude too, with Copy, Send to… (a
  terminal or session: Enter types, ⌘Enter runs) and Run in New Terminal.
- **Click in the command you're typing** to move the cursor there (Settings › Terminal).
- A new terminal takes the lowest "Terminal N" not on screen (after File › Restart atelierd); updates that change only
  the app no longer ask for an atelierd restart.

## 0.2.0-beta.10

- **What's new, right after an update**: this sheet. It lists every release since the version you ran before,
  versions you skipped included; reopen it from Atelier › What's New… or the palette.
- **Find and replace in the editor** (⌘F, ⌥⌘F): a floating card with match count, case, whole word and regex,
  Replace all with Undo, and marks on the scrollbar. Every editor now takes multiple cursors (⌥↵, ⌘D, ⌘⇧L).
- **A task's actions in the palette**: Enter on a ClickUp task offers Start in New Session, Paste into Session… (the
  prompt typed into a session you already have), Copy Task (Markdown) and Copy Task ID. ⌘Enter still starts and sends.
- **Rename where you asked**: Rename from a sidebar row edits the row (also with no tab open), from a tab the tab; the
  name starts selected, so you just type the new one.
- **Pinned sessions stay pinned** after an atelierd restart: first in To resume with their pin, and pinned again once
  resumed.
- **The usage meter follows the selected session's Claude account** when you use more than one config dir
  (`CLAUDE_CONFIG_DIR`), and never mixes two accounts' limits. Needs File › Restart atelierd.
- **New terminals follow your zsh config**: edit `.zshrc` (or another startup file) and the next terminal or session
  picks up the change; Settings › Terminal to turn it off or add files to watch.
- **Sessions show when their last message was** ("5m ago") instead of "ready" (after File › Restart atelierd). A file
  joining Changes flashes in with its session's color; pinning shortens no one's title; the context ring shows at
  any value.
- **Fewer atelierd restarts**: an update asks for one only when atelierd's own code changed; the footer shows the app's
  version.
- A designed disk image window; service log lines cut short expand on click, with Wrap lines per card; arrow keys in
  the Welcome window; coming back to the window gives the keyboard back to the pane.
- Update checks say whether they are the first of the day, week or month, to count active installs (no identifier;
  see Settings › About).

## 0.2.0-beta.9

- **Signed with a Developer ID and notarized by Apple**: Atelier now opens like any Mac app: no more "Open Anyway" in
  System Settings. This version has a new identity: install it
  once from the DMG; macOS asks again for the microphone, and the Keychain once for "Atelier Safe Storage" (choose
  Always Allow). Later versions install themselves from inside the app.
- **Updates through useatelier.dev**: Atelier looks for updates at useatelier.dev instead of calling GitHub's API, so
  shared office networks no longer hit GitHub's limits.
- **Background**: what your sessions run in the background — servers, watchers, subagents, scheduled jobs — in a tab
  of its own (View › Background, ⌘⌥B) with live output and an agent's timeline, and in a popover from the work chips.
- **Fetch in Source Control**: a Fetch button in the sidebar and in History, Fetch All Repositories, and automatic
  fetches you set in Settings › Source Control. Only remote-tracking refs move; nothing else is written.
- Plain terminals have their own group in the palette; full names in the tooltips of sidebar rows, tabs and the
  session bar; an agent's task keeps its full text.

## 0.2.0-beta.8

- **Worktrees in Changes**: the git worktrees inside the project nest under their repository, with their branch, what
  is left to merge and the sessions working there; a committed one is a single line, an idle one a chip. A violet card
  warns when the same file changes on two branches. Review can open one worktree, and Compare with main shows it
  against main. Tabs of a worktree's files carry its glyph; sessions working in one show its name.
- **When Atelier isn't sure who changed a file**: one chip for all the sessions that could have done it, and a collapsed
  "Maybe" group under each of them. The chip (or Who Changed This… in the row's menu) opens "Why unsure": when the file
  changed, each candidate's command and where it ran. Pick the session, or someone outside Claude, with Undo. Showing
  where each command ran needs File › Restart atelierd.
- **Next / previous change** in a file: arrows with a "2 / 5" counter in the file bar, Go › Next Change (⌥F5) and
  Previous Change (⌥⇧F5).
- **Reveal in Finder for terminals** (⌘⌥R, or right-click): the folder the shell is in now; Claude's folder for a session.
- **"Finished" only after a long turn** (Settings › Notifications, 1 min by default): quick replies stay quiet; errors
  always notify.
- Option is no longer Meta in terminals by default, so ⌥ types @ # [ ] { } ~ on Italian and other European layouts.
  Settings › Terminal › "Option key as Meta" brings back ⌥B / ⌥F word moves.
- ClickUp tasks open in the ClickUp app when it is installed (Settings › Connectors to turn it off), and the card names
  your workspace after its spaces.
- Right-click inside tmux or vim goes to the program; Shift-right-click opens Atelier's menu.
- Collapse folders in Files; sessions grouped by state and compact Changes rows by default.
- Long dictations get the time to be polished; the project window opens where the welcome window was.
- Fixes: `"error": null` lines in service logs are no longer errors; wide tooltips stay next to what they describe;
  squash- or rebase-merged worktrees have nothing left to merge, and removed ones leave Changes.

## 0.2.0-beta.7

- **Source Control** (the new git icon in the left bar, or ⌃⇧G): every repository of the project in a switcher, its
  branches, tags, worktrees and stashes, and a History tab with a graph of every branch, each commit's files and diffs,
  any branch or tag viewed without checking it out, branch compare and files opened as they were at a commit. Read-only:
  it never checks out, commits, fetches or pushes, and it follows new commits as they happen.
- **Connectors, ClickUp first** (Settings › Connectors): sign in once in your browser and Atelier lists the ClickUp
  tasks assigned to you. Atelier is read-only: it never changes anything in ClickUp, whatever the account allows. The
  connection is kept encrypted in your macOS Keychain; Disconnect forgets it.
- **Start a session from a task**: ⌘K shows your tasks (or type `task:`). Enter starts a session named after the task
  with its description typed into Claude's prompt, ready for you to read and send; ⌘Enter sends it right away, ⌥Enter
  opens it to the side. The session keeps a task chip: one click opens the task in ClickUp.
- **Session panel**: click the model chip (or View › Session Panel) to switch model, step through permission modes,
  compact or clear, and see the MCP servers, skills and plugins configured for the project. Commands are typed only
  when Claude is waiting for you and never on top of a draft you haven't sent.
- **Session names in step with Claude**: a session shows the same name in Atelier and in Claude's own `/resume`.
  Rename it in Atelier and Claude gets the name with your next message (nothing is typed into its prompt); rename it
  inside Claude and Atelier follows; unnamed sessions show the title Claude gives them. Needs File › Restart atelierd.
- **Notifications you notice**: "Play a sound" is now Atelier's own chime, also with the window in front (never for a
  session on screen). Settings › Notifications has Send Test and a shortcut to macOS's notification settings.
- **Images** (png, jpeg, gif, webp, bmp, ico, avif) open as pictures, with Fit / 100%, dimensions and size.
- **Swap side panels** (Settings › Appearance, View menu, palette) puts the sidebar on the right.
- Closing a tab goes back to the one you used before it.
- ⌘V with files copied in Finder pastes their paths (Claude attaches images).
- Ctrl+C or Esc on a working Claude shows the session ready again.
- Gosu syntax highlighting (`.gs`, `.gsx`, `.gsp`); Changes remembers By repo / By session.

## 0.2.0-beta.6

- **Background work**: a session whose Claude is waiting on background commands, subagents or scheduled jobs reads as
  Working, with chips for what is running, and gets one "Finished" when the work really ends. Needs Atelier's
  background service restarted once (File › Restart atelierd).
- **Who changed what**: changes made by commands are attributed to the session that ran them; when several sessions
  could have made a change, every candidate shows a dashed dot instead of a guess. Also needs File › Restart atelierd.
- **New tab bar**: the active tab lifts out of the bar with the brand gradient on top and flows into the file below;
  with many tabs the mouse wheel scrolls them sideways, the active tab always comes into view, and "+" and Changes
  stay in place.
- **New app icon** for macOS 26: full size in the Dock and Finder, with the system's glass look.
- **Terminal › Aliases** in Settings lists the aliases from your shell.
- A new session shows as a session from its first moment ("Starting…"), and a resumed one shows its screen right away.
- **Split view**: up to three tabs side by side (sessions, terminals, files). Split Right (⌘\), Open to the Side from
  any tab, row or file menu (or ⌥-click), or drag a tab onto the edge of the workspace. ⌘⌥←/⌘⌥→ move between panes,
  dividers resize them (double-click for equal widths). Each project remembers its panes after a restart, without
  starting anything by itself.
- **Listening ports**: terminals and sessions running a server show its port (`:3000`); one click opens it in the
  browser. Needs Atelier's background service restarted once (File › Restart atelierd).
- **Pull request and CI**: a session working on a branch with a pull request shows `#123` with its checks (green,
  failing, running); click to open it, ⌥-click for the checks. Uses the GitHub CLI when it is installed and signed in;
  can be turned off in Settings › Claude.

## 0.2.0-beta.5

Not published: built on a new build machine, it would have asked 0.2.0-beta.3 to be installed by hand (fixed in
0.2.0-beta.6).

## 0.2.0-beta.4

Not published: the release build stopped compiling the new app icon on a macOS 15 build machine (fixed in
0.2.0-beta.5).

## 0.2.0-beta.3

First beta. Atelier is a macOS app (Apple Silicon) for running many Claude Code sessions side by side.

- **Sessions that stay alive**: Claude Code runs in real terminals owned by a background service, so sessions survive
  closing the window, updating the app and restarting the Mac (resume them from the sidebar or with ⌘⇧N).
- **Know who needs you**: each session shows its state (needs permission, has a question, working, done, failed),
  model, context and cost; ⌘J jumps to the next session waiting for you; notification center (⌘⇧J), Dock menu and
  banners for finished or blocked sessions.
- **Tabs for terminals and files**, a command palette (⌘K or F1) and context menus everywhere; pinned sessions, groups
  by state, sessions and terminals in any folder of the project. Closing a tab only hides it: sessions keep running in
  the sidebar until you close them there.
- **Files and editor**: file tree with git colors, a fast editor (save, find, comment, change language), safe handling
  of conflicts with Claude's edits, files moved to the Trash, never deleted.
- **Review Claude's work**: Changes view colored by the session that touched each file, a Review tab with hunks and
  line comments you can send back to the session as `@file#L10-24` references.
- **Atelier terminal profile**: a clean, fast zsh with command blocks (⌘↑/⌘↓, copy command or output) and output
  triggers that notify or highlight; your own zsh or bash are one click away.
- **Dictation** (off by default, Settings › Dictation): hold ⌥Space to talk to Claude; transcription runs locally
  (whisper.cpp on Metal, a 574 MB model downloaded on first setup), optionally polished.
- **Settings** (⌘,) for appearance, terminal, editor, Claude defaults, notifications, dictation and shortcuts.
- **Automatic updates**: Atelier checks for new versions in the background, verifies their signature and installs them
  on the next restart without closing your sessions. Choose the Stable or Beta channel in Settings › About.

## 0.2.0-beta.2

Not published: the release build stopped on a test that depended on the build machine's shell (fixed in 0.2.0-beta.3).

## 0.2.0-beta.1

Not published: the release build stopped on two tests that depended on the build machine (fixed in 0.2.0-beta.3).
