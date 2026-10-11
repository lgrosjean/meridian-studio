# Changelog

## Unreleased

- Releases also publish to [Open VSX](https://open-vsx.org), where Cursor and VSCodium install extensions from:
  through trusted publishing (no token) once the namespace's owner registers the workflow, an access token until
  then.

## 0.1.3

- **Meridian's review of each fit**: once the posterior is sampled, Meridian's model health checks (convergence, a
  negative baseline, the Bayesian p-value, goodness of fit, the shift from prior to posterior, ROI consistent with its
  priors; with a revenue per KPI, implausible ROI, high-variance ROI and potential bias). Each passes, asks for a
  review or fails; together they make a health score out of 100. The results panel lists them (**Model health**) and
  opens Meridian's health card; what did not pass lands in Problems, on the lines naming its channels. A review that
  breaks leaves the fit standing, and the panel says why it is missing.
- The health score in the tree, the notification at the end of a fit and Meridian Runs; in MLflow, a metric
  (`health_score`), each check's status a tag (`review.status`, `review.convergence`…), the health card an artifact.
- A roadmap of what Meridian offers that the extension does not use yet, on the documentation site
  ([Roadmap](https://lgrosjean.github.io/meridian-studio/roadmap/)).
- A shorter README: what the extension does, how to install it and a quick start; the details are on the site.
- Releases from a tag, pushed or given to the release workflow run by hand, once its tests pass: `vX.Y.Z` publishes
  to the Marketplace, `vX.Y.Z-rc.N` publishes a pre-release, signed in through Microsoft Entra ID rather than a
  token; the `.vsix` on the GitHub release.

## 0.1.2

- **A documentation site**, [lgrosjean.github.io/meridian-studio](https://lgrosjean.github.io/meridian-studio/):
  getting started, a guide to datasets, data checks, models, scenarios, runs and CI, and a reference of every YAML
  key, command and setting.
- **MLflow**: Meridian's own autologging in each fit's run (its version, the `ModelSpec` and priors as Meridian
  resolved them, the sampling's arguments), and an optional `mlflow:` block in a model: its runs' name (`{model}`,
  `{dataset}`), description and tags, autologging off. The run opens before Meridian is built, not after the fit:
  a fit that fails while sampling shows as FAILED, and the run lasts as long as the fit.
- **MLflow's runs and files apart**: with a tracking server, a fit's files go to the server's artifact store, no
  longer to the project's `mlruns/`, which keeps a copy of the model and the report; the optimizer fetches the model
  from MLflow when that copy is gone. `meridian.mlflowArtifactLocation` sets where a new experiment keeps its files.
- **Open MLflow**: MLflow's UI on the experiment, a fit or a scenario; a local `mlflow server` when the store is the
  project's. From the palette, the Models view, a model, a scenario, a past run, or the results panel.
- The fit's run declares its dataset as input (MLflow's Datasets); each optimization is a run under its fit's, with
  the scenario as params, budget, outcome and ROI before and after as metrics, Meridian's summary as an artifact.
- **Data checks**, like a linter's: each CSV checked by the role of its columns, each finding with a code, in
  Problems on the line naming its column and counted above the file. T001–T003 the dates (weeks missing, off the
  step, different per geo), K001–K002 the KPI (empty after it starts, negative), M001–M003 the channels (negative,
  rarely active or never spending, zero over the last weeks), S001 a channel's tiny share of spend, C001 a control
  that never varies. Run on save and on opening once Meridian is installed, or by **Check data**. Turned off in the
  YAML (`checks: ignore`, per column, `# noqa: CODE`), thresholds there too; the runner's `check` command does it.
- **Check**, above a model: Meridian's own data checks with its spec, without sampling. ▶ Fit (and its task) runs the
  dataset's checks first, and stops on an error unless told **Fit anyway**.
- **Checks in CI**: `runner.py check <project> [datasets or models…] --format text|json|github`, exit 1 on an error;
  the data checks need only pandas and pyyaml. The documentation has a GitHub Actions workflow
  ([Checks in CI](https://lgrosjean.github.io/meridian-studio/guide/ci/)).
- **Datasets from their CSV.** New dataset fills the YAML from the CSV: dates → `time`, the column repeating them →
  `geo`, impressions paired with spend by name into channels, KPI, revenue per KPI and controls by name.
  **Complete from \<csv\>** above a dataset does it again; what it cannot place stays unused.
- Completion of the CSV's columns where a dataset names them, each with what it holds (dates, numbers and their
  range, zeros, empty cells), and of channels; a hover on a column.
- A dataset's mistakes underlined as you type, with quick fixes: a column the CSV lacks, dates not yyyy-mm-dd, text
  where numbers go, a column in two roles, unmapped columns, a channel without spend, `media_spend` in another
  channel order than `media`, dates that repeat without `geo`, `revenue_per_kpi` with `kpi_type: revenue`.
- The tree sets a column's role (right-click, several at once), and refreshes when a CSV changes. Rename and delete
  no longer show on a dataset's columns, a model's runs or its priors.
- **Priors cover all of Meridian's PriorDistribution** (36 fields: ROI, mROI, contribution, adstock, Hill, controls,
  noise…), each one TensorFlow Probability distribution, once for all channels or per channel with a default.
  The keys `roi` and `adstock` are now `roi_m` and `alpha_m` with a `dist`; the fit says how to convert.
- Completion and hover docs for every prior, generated from Meridian.
- The tree shows each channel's priors whatever their distribution, and flags a prior the prior type leaves unused.
- Open a model's dataset or a scenario's model from the link above the line naming it, or Cmd+click the name.
- While a fit or an optimization runs: a progress bar atop its view, and the status bar shows its phase and time
  ("Fit national-media-v1 · posterior · 2 min 10"; click for the output). When it ends, a notification says how
  it went, with Show results; the results panel no longer opens by itself.
- Meridian's data checks go to Problems on the lines naming their variables, in the model and its dataset; data
  Meridian refuses outright (a control that never varies) is a check too, instead of a crash.
- Meridian Runs, in the bottom panel: every fit of every model, and a comparison of any two.
- Fits and optimizations are VS Code tasks (type `meridian`), runnable from Run Task and chainable with `dependsOn`.

## 0.1.1

- Fix: a finished scenario showed "ROI ? → ?" in the tree; the optimizer now reports ROI, budget and outcome before and after.
- README: screenshots of the extension at work.

## 0.1.0

- Datasets, models and scenarios as YAML in `datasets/`, `models/`, `scenarios/`, with JSON schemas for completion.
- Datasets are Meridian's `CsvDataLoader` arguments; the tree shows each CSV column with its role.
- Fit and Optimize from the sidebar or the link above the file; results panel, Meridian's report in the editor.
- A model's priors and its run history (`<model>.runs.jsonl`) in the tree; fits tracked in a local or remote MLflow.
- uv installed on first use when missing.
- Apache License 2.0, as Meridian.
