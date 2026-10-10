# Changelog

## Unreleased

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
