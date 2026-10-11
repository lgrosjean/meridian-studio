# Models and fits

A model is a dataset, Meridian's `ModelSpec`, its priors and how to sample: `models/<name>.yaml`. **New model**
writes one on a dataset:

```yaml
name: synthetic-v1
dataset: synthetic                  # datasets/synthetic.yaml
# window: { start: 2022-01-03, end: 2023-12-25 }   fit on these dates only; default the whole CSV
model_spec:                         # meridian.model.spec.ModelSpec's arguments
  media_effects_dist: log_normal
  max_lag: 8
  adstock_decay_spec: geometric
  enable_aks: true
priors:
  roi_m:
    dist: LogNormal
    default: { mean: 1.0, sd: 1.0 }
    ch0: { mean: 1.5, sd: 0.8 }
sampling:
  n_chains: [2, 2]                  # two batches of two chains: less memory than four at once
  n_adapt: 1000
  n_burnin: 0
  n_keep: 1000
  seed: 1
```

The tree unfolds a model into its priors per channel and its runs. The link above the line naming the dataset opens
it, as does ++cmd++-click (++ctrl++-click) on its name. The keys are listed in the
[model reference](../reference/model.md).

## Priors

A model's priors are Meridian's
[`PriorDistribution`](https://developers.google.com/meridian/reference/api/meridian/model/prior_distribution/PriorDistribution)
fields, each one TensorFlow Probability distribution, named by `dist`, with its arguments:

- **once for every channel**: `ec_m: { dist: TruncatedNormal, loc: 0.8, scale: 0.8, low: 0.1, high: 10 }`;
- **or per channel**, with a `default` for the others.

A LogNormal also takes `mean` and `sd` in its own units (an ROI of 1.2 ± 0.6) instead of `loc` and `scale` on the
log; `shift: x` moves a distribution by x. Fields left out keep Meridian's defaults; completion lists all of them,
with what each one is.

```yaml
priors:
  roi_m:                    # used when model_spec.media_prior_type is roi (the default)
    dist: LogNormal
    default: { mean: 1.0, sd: 1.0 }
    tv: { mean: 1.5, sd: 0.8 }
  alpha_m:                  # adstock decay
    dist: Beta
    default: { concentration1: 1, concentration0: 1 }
    tv: { concentration1: 6, concentration0: 4 }
  ec_m: { dist: TruncatedNormal, loc: 0.8, scale: 0.8, low: 0.1, high: 10 }
  sigma: { dist: HalfNormal, scale: 3 }
```

Which of `roi_m`, `mroi_m`, `contribution_m` or `beta_m` a fit uses depends on `model_spec.media_prior_type`; the
tree flags a prior the prior type leaves unused.

## Fit

Click **▶ Fit** above the file, or on the model in the tree; a fit is also a [task](runs.md#tasks). It saves the
file, runs the dataset's [data checks](data-checks.md#before-a-fit), then Meridian: its own data checks, prior
sampling, the posterior, the analysis, and [its review](#meridians-review). A progress bar sits atop the view and the status bar shows the phase and the
time (**Fit synthetic-v1 · posterior · 2 min 10**; click it for the runner's output). **■ Stop** stops it.

When it ends, a notification says how it went, with **Show results**:

| Result           | What it says                                                               |
|------------------|----------------------------------------------------------------------------|
| health           | Meridian's [review](#meridians-review) of the fit, out of 100              |
| R², MAPE, wMAPE  | how well the fit follows the KPI                                           |
| r-hat (max)      | whether the chains converged: close to 1 they did                          |
| divergences      | the sampler's divergent transitions; more than a few, and the fit is suspect |
| ROI by channel   | its mean and interval, with each channel's contribution and spend          |

Meridian's own HTML report opens in the editor too: **Open Meridian report**, right-click on the model in the tree
(its charts load Vega from gstatic.com, so they need the network). The window it summarises is `summary_window`, or the fit's.

**Check**, above the model, runs Meridian's data checks with the model's spec without sampling:
[a few seconds](data-checks.md#meridians-own-checks-without-a-fit) instead of a fit's minutes.

## Meridian's review

Once the posterior is sampled, Meridian reviews the fit (`Meridian.review()`), in seconds to a minute. Convergence
first: when the chains did not converge, the other checks are skipped.

| Check                 | It looks at                                                                  | Runs                       |
|-----------------------|------------------------------------------------------------------------------|----------------------------|
| Convergence           | the largest r-hat: under 1.2 the chains converged                            | always                     |
| Baseline              | how likely the baseline (the KPI without media) is negative                  | always                     |
| Bayesian p-value      | whether the KPI observed is one the model would predict                      | always                     |
| Goodness of fit       | R², MAPE and wMAPE                                                           | always                     |
| Prior-posterior shift | the channels whose posterior did not move from their prior: little signal   | always                     |
| ROI consistency       | each channel's ROI against its prior                                         | with custom ROI priors     |
| Implausible ROI       | ROI too high or too low to be believed                                       | with a revenue per KPI     |
| High-variance ROI     | ROI too uncertain to act on                                                  | with a revenue per KPI     |
| Potential bias        | channels that do not correlate with the controls, a sign of a missing one   | with a revenue per KPI     |

Each check passes, asks for a review, or fails, with what Meridian says and recommends. Together they make a health
score out of 100, and an overall status: failed when a check fails.

- **The results panel** opens on them: the score among the tiles, then **Model health**, every check with what
  Meridian says. **Open health card** opens Meridian's own page of the review, with its charts and which channels a
  lift test would help most (its charts load Vega from gstatic.com, so they need the network).
- **Problems** gets the checks that did not pass, a review as a warning and a failure as an error, on the lines
  naming their channels in the model and in its dataset; a check of the whole model (convergence, baseline…), on the
  model's first line.
- **The score** shows in the tree, in the notification at the end of the fit and in [Meridian Runs](runs.md).

A review that breaks leaves the fit standing: its results come without a score, and the panel says why (the runner's
output has the details).

## History and MLflow

Every fit is an MLflow run, in the experiment named after the project's folder:

- **parameters**: `model_spec`, `sampling` and `priors`, flattened; and, from Meridian's own autologging, its
  version, the `ModelSpec` and priors as Meridian resolved them (its defaults included) and the sampling's arguments;
- **metrics**: r-hat, divergences, R², MAPE, wMAPE, the health score, the fit's seconds, and each channel's ROI,
  interval and contribution;
- **tags**: the [review](#meridians-review)'s overall status (`review.status`) and each check's
  (`review.convergence`, `review.prior_posterior_shift`…: `pass`, `review` or `fail`), to search runs by them;
- **input**: the dataset, as fitted (MLflow's Datasets), from its CSV;
- **artifacts**: the fitted model (`model.binpb`, which a [scenario](scenarios.md) reloads), Meridian's report
  (`summary.html`), its health card (`health.html`), the data as fitted (`dataset.parquet`), the model's and the
  dataset's YAML.

The run opens once the YAML and the CSV are read, before Meridian is built: a mistake in them makes no run, and a fit
that fails after that shows as FAILED. Each [optimization](scenarios.md#optimize) is a run too, under its fit's.

An optional `mlflow:` block names, describes and tags the model's runs ([reference](../reference/model.md#mlflow));
changing it leaves the fit current:

```yaml
mlflow:
  run_name: "{model} on {dataset}"   # default {model}, the file's name
  description: TV's ROI prior from the March geo test
  tags: { owner: marketing, ticket: MMM-42 }
  autolog: false                     # Meridian's autologging, on by default
```

### Where runs and files go

MLflow keeps runs (params, metrics, tags) in a tracking store and their files in an artifact store. By default both
are in the project, `mlflow.db` and `mlruns/`, which go into its `.gitignore`.

With a tracking server (the `meridian.mlflowTrackingUri` [setting](../reference/commands.md#settings)), the files go
where the server keeps them: `mlflow server --artifacts-destination s3://bucket/mmm` puts them in a bucket, and the
editor needs no credentials for it. The project then keeps a copy of each fit's model, report and health card in
`mlruns/`, for the optimizer and the results panel; when that copy is gone (another machine, a clean checkout), the optimizer fetches the
model from MLflow.

`meridian.mlflowArtifactLocation` sends a new experiment's files somewhere else, a shared folder say. MLflow sets it
when it creates the experiment and never moves it: it does not apply to a project that already has one.

### Open MLflow

**Open MLflow** opens MLflow's UI: on a model, a scenario or a past fit (right-click, or the button of its results
panel), on that run; from the Models view's title bar or the palette, on the project's experiment. With a tracking
server, its own UI; with the project's store, a local `mlflow server`, started on first use and stopped with the
editor.

The latest fit is also in `models/<name>.result.json`, and every fit appends a line to `models/<name>.runs.jsonl`
(when, the configuration, what it found): its runs, listed under the model; click one to see its results again.

**Outdated runs.** A run is flagged outdated when its model, its dataset or the CSV changed since, the dataset's
`checks` aside.

**Rename and delete** carry a file's run records along and update the files that name it.
