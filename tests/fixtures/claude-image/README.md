# Claude image fixtures

How Claude Code draws image reads and long paths, for `src/shared/wrapped-paths.test.ts` and the e2e.

- `normal-<width>.txt`, `transcript-<width>.txt`: recorded 2026-10-16 from a real Claude Code 2.1.302 in a tmux pane
  `<width>` columns wide (`capture-pane -p`, trailing spaces trimmed by tmux), in the normal view and in the
  transcript view (ctrl+o). It read `sample.png` twice: once from Claude's temp folder, once from this folder.
- `image-message.txt`: a message with `SendUserMessage` attachments (`[image]` rows; Remote Control only, so not
  recordable here), laid out cell by cell as Claude Code draws one, 120 columns: the `[image]` path box is
  `cols − 1 − size` wide and goes on under the path (column 11), then a folder, a wrapped `file://` URL and bare names.
- `sample.png`: a 180 × 180 PNG (the site's touch icon).
