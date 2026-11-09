# Security

## Reporting a vulnerability

Please report security problems privately to **[hello@useatelier.dev](mailto:hello@useatelier.dev)**, with
"Security" in the subject, never in a public issue. Include the Atelier version, your system, what an attacker could
do and how to reproduce it. Once a fix ships, the release notes credit you if you like.

## Supported versions

Fixes go into the next release of both channels. Atelier updates itself (on Windows, through the Microsoft Store), so
only the latest stable and the latest beta are supported.

## Scope

Of particular interest:

- the update pipeline: the signed feed, the downloads and their checks (`src/main/auto-update.ts`,
  `src/main/update-download.ts`, `site/functions/`);
- `atelierd`, the background service that owns the terminals (its socket and tokens);
- anything that lets a project, a repository, a terminal's output or a web page write files, run processes or reach
  the network through Atelier;
- the Git writes, which run only through a closed list of operations (`src/main/git/write.ts`).

The rules the code relies on are listed in [CLAUDE.md](CLAUDE.md#security-rules-the-code-relies-on).
