# Changelog

## Unreleased

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
