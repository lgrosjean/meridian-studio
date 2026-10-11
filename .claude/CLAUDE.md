# Commits and pull requests

No attribution to Claude in commit messages or pull request descriptions: no Co-Authored-By trailer, no "Generated
with Claude Code" line, no Claude session link (claude.ai/code/session_…).

# Documentation

> [!IMPORTANT]
> Before a pull request is merged, check that the documentation is up to date with it: the site (`docs/`, its guide
> and its reference), the README, the changelog's Unreleased section, the schemas' descriptions and the templates in
> `runner/templates/`. `bun run docs:build` builds the site strictly (a broken link or anchor fails it) and runs
> `scripts/check-docs.js`, which fails on a YAML key, a data check, a setting or a sidebar command the docs leave
> out. Neither tells a page that says something no longer true: reread the pages the change touches.
