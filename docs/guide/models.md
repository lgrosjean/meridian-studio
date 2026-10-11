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
sampling, the posterior, the analysis. A progress bar sits atop the view and the status bar shows the phase and the
time (**Fit synthetic-v1 · posterior · 2 min 10**; click it for the runner's output). **■ Stop** stops it.

When it ends, a notification says how it went, with **Show results**:

| Result           | What it says                                                               |
|------------------|----------------------------------------------------------------------------|
| R², MAPE, wMAPE  | how well the fit follows the KPI                                           |
| r-hat (max)      | whether the chains converged: close to 1 they did                          |
| divergences      | the sampler's divergent transitions; more than a few, and the fit is suspect |
| ROI by channel   | its mean and interval, with each channel's contribution and spend          |

Meridian's own HTML report opens in the editor too: **Open Meridian report**, right-click on the model in the tree
(its charts load Vega from gstatic.com, so they need the network). The window it summarises is `summary_window`, or the fit's.

**Check**, above the model, runs Meridian's data checks with the model's spec without sampling:
[a few seconds](data-checks.md#meridians-own-checks-without-a-fit) instead of a fit's minutes.

## History and MLflow

Every fit is an MLflow run, in the experiment named after the project's folder:

- **parameters**: `model_spec`, `sampling` and `priors`, flattened;
- **metrics**: r-hat, divergences, R², MAPE, wMAPE, the fit's seconds, and each channel's ROI, interval and
  contribution;
- **artifacts**: the fitted model (`model.binpb`, which a [scenario](scenarios.md) reloads), Meridian's report
  (`summary.html`), the data as fitted (`dataset.parquet`), the model's and the dataset's YAML.

Fits log to `mlflow.db` and `mlruns/` in the project, which go into its `.gitignore`; the
`meridian.mlflowTrackingUri` [setting](../reference/commands.md#settings) logs them to a server instead.

The latest fit is also in `models/<name>.result.json`, and every fit appends a line to `models/<name>.runs.jsonl`
(when, the configuration, what it found): its runs, listed under the model; click one to see its results again.

**Outdated runs.** A run is flagged outdated when its model, its dataset or the CSV changed since, the dataset's
`checks` aside.

**Rename and delete** carry a file's run records along and update the files that name it.
