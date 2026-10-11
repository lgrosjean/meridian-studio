# Development

The extension is TypeScript, bundled by [bun](https://bun.sh); fits and optimizations run in a Python runner
(`runner/`, a [uv](https://docs.astral.sh/uv/) project) that the extension starts and reads JSON lines from.

| Path                     | What                                                                               |
|--------------------------|------------------------------------------------------------------------------------|
| `src/extension.ts`       | the sidebar, lenses, runs, results, tasks                                          |
| `src/dataset.ts`, `src/csv.ts` | a dataset's logic and the CSV's profile, without VS Code                     |
| `src/assist.ts`          | completion, hover, diagnostics and quick fixes for datasets                        |
| `src/datachecks.ts`      | the data checks in the editor                                                      |
| `runner/runner.py`       | the runner's commands: `fit`, `optimize`, `check`                                  |
| `runner/fit.py`, `runner/optimize.py`, `runner/priors.py` | Meridian: fit, budget optimizer, priors                   |
| `runner/review.py`       | Meridian's review of a fit: Problems, results, MLflow                              |
| `runner/checks.py`       | the data checks                                                                    |
| `runner/templates/`      | what New dataset, New model and New scenario write                                 |
| `schemas/`               | the YAML's JSON schemas, for completion and errors                                 |
| `docs/`, `mkdocs.yml`    | this site                                                                          |

## Run and test

- `bun install`, then ++f5++ opens `examples/` with the extension loaded.
- `bun run test`: type check, bundle, the tree's and the dataset helper's logic, then the runner (data checks, a
  tiny fit of the example and Meridian's review of it, an optimization, their MLflow runs; then the same against a local `mlflow server` keeping
  the files itself). A few minutes on CPU.
- `bun run test:vscode`: the extension in a real VS Code with the YAML extension (both downloaded into
  `.vscode-test/` the first time; on Linux without a display, `xvfb-run -a bun run test:vscode`). Its data checks
  part needs `uv sync --project runner`.
- `bun run build && HOME=$(mktemp -d) PATH=/usr/bin:/bin $(which node) scripts/check-uv.js` checks the uv install
  (downloads uv).
- `uv run --project runner scripts/gen_priors_schema.py` rewrites the priors part of the model schema from the
  installed Meridian, after an upgrade.
- `bun run package` builds the `.vsix`; `code --install-extension meridian-studio-*.vsix` installs it.

CI (`.github/workflows/test.yml`) runs the tests on every push.

## This site

Built by [Zensical](https://zensical.org) from `docs/` and `mkdocs.yml`:

- `bun run docs` serves it at <http://localhost:8000>, rebuilt as you edit;
- `bun run docs:build` builds it into `site/`, failing on a broken link, then checks that every YAML key of the
  schemas and every data check has its line in the reference.

`.github/workflows/docs.yml` builds it on every pull request, and publishes it to GitHub Pages from `main`.
