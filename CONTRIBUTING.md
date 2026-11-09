# Contributing to Atelier

Thanks for wanting to help. Atelier is a small project with one maintainer, so a little coordination goes a long way.

## What to expect

Time for reviews is limited. Every issue and pull request is welcome, but not all of them will get an answer, and a
pull request may wait a long time or be closed without a full review, especially when no issue came first. It is
never a judgement on you or your work: it is how a project this size keeps moving.

## Issues first

- **Bugs:** open an issue with the Atelier version and channel (Settings › About), your macOS or Windows version, what
  you did, what you expected and what happened. For crashes and update problems, the log helps:
  `~/Library/Application Support/Atelier/logs/app.log` on a Mac, `%USERPROFILE%\.atelier\logs\app.log` on Windows (it can
  contain your projects' paths: look before you share it).
- **Ideas and questions:** open an issue too. Say what you are trying to do, not only the change you have in mind.
- **Security problems:** never in a public issue. See [SECURITY.md](SECURITY.md).

## Pull requests

Open a pull request **after an issue where we agreed on the change**, so nobody spends a weekend on something that
can't be merged. Then:

1. Keep it to one change, with the tests that prove it: a failing test first, then the fix. For anything visible, an
   e2e test (`tests/e2e/`) and a screenshot in the pull request.
2. Run the checks: `npm test`, `npm run typecheck`, and `npm run e2e:affected` for app changes
   (`npm --prefix site test` for the website).
3. Write code, comments and commit messages in English; comments explain why, on their own. [CLAUDE.md](CLAUDE.md)
   has the conventions, the architecture and the security rules the code relies on (it reads well for people too).

Changes to the release pipeline (`.github/`, `scripts/`), the website's update endpoints (`site/functions/`), the
daemon (`src/daemon/`) or the dependencies get a slower, closer review: they run with the release keys or on every
user's machine.

## Development setup

[README.md](README.md#build-from-source) has the requirements and the commands. Set `ATELIER_HOME` to an empty folder
so a development instance never touches an installed Atelier, and never point tests at your real home folder, shell
configuration or Claude settings.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE) of this project.
