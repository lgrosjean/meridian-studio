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

CI (`.github/workflows/test.yml`) runs the tests on every push to a branch, and on a tag before its release.

## Releases

A tag publishes the extension to the VS Code Marketplace once the tests pass on it (`.github/workflows/release.yml`):

| Tag           | Publishes            |
|---------------|----------------------|
| `v0.4.0`      | 0.4.0, a release     |
| `v0.3.0-rc.1` | 0.3.0, a pre-release |

The tag names the version in `package.json`; the workflow stops when they differ. The Marketplace takes
`major.minor.patch` only: the `-rc.N` suffix picks the channel, not the number, and a version published once, as a
release or a pre-release, cannot be published again. Each publication has its own number, then; VS Code's
[convention](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#prerelease-extensions) is
odd minors for pre-releases (0.3.x), even ones for releases (0.4.x). The `.vsix` goes on the tag's GitHub release,
with the version's section of the changelog.

```sh
# "version": "0.3.0" in package.json, committed
git tag v0.3.0-rc.1
git push origin v0.3.0-rc.1
```

### Signing in to the Marketplace

No token: the workflow signs in to Microsoft Entra ID as a managed identity that trusts the repository's
`marketplace` environment, through GitHub's OIDC, and `vsce publish --azure-credential` publishes as that identity.
(The Marketplace's personal access tokens are global Azure DevOps tokens, which Microsoft retires on December 1,
2026.) Once:

1. **A managed identity**, user-assigned, in any Azure subscription: a free one does, the identity costs nothing and
   needs no role.

    ```sh
    az group create --name meridian-studio --location westeurope
    az identity create --resource-group meridian-studio --name marketplace-publisher
    ```

2. **Its federated credential**, trusting this repository's `marketplace` environment. GitHub names a repository
   created since July 15, 2026 by its IDs as well as its name (`owner@id/repo@id`), hence the subject:

    ```sh
    az identity federated-credential create --resource-group meridian-studio \
      --identity-name marketplace-publisher --name github-marketplace \
      --issuer https://token.actions.githubusercontent.com --audiences api://AzureADTokenExchange \
      --subject 'repo:lgrosjean@34337781/meridian-studio@1412399345:environment:marketplace'
    ```

3. **The `marketplace` environment** in GitHub (Settings › Environments): deployments from the tags `v*` and the
   branch `main` only (a required reviewer, optionally, then approves each publication), and two secrets,
   `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`:

    ```sh
    az identity show --resource-group meridian-studio --name marketplace-publisher --query clientId --output tsv
    az account show --query tenantId --output tsv
    ```

4. **A dry run**: Actions › release › Run workflow, on `main`. It runs the tests and packages, prints the subject
   GitHub signs (step 2's), signs in, prints the identity's ID and checks its rights on the publisher, and publishes
   nothing. The first time, the check fails: add that ID to the publisher's members
   ([marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage/publishers/lgrosjean), Members),
   role Contributor, and run it again.

## This site

Built by [Zensical](https://zensical.org) from `docs/` and `mkdocs.yml`:

- `bun run docs` serves it at <http://localhost:8000>, rebuilt as you edit;
- `bun run docs:build` builds it into `site/`, failing on a broken link, then checks that every YAML key of the
  schemas and every data check has its line in the reference.

`.github/workflows/docs.yml` builds it on every pull request, and publishes it to GitHub Pages from `main`.
