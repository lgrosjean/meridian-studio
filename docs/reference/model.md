# Model YAML

`models/<name>.yaml`, validated against `schemas/model.schema.json`. How to write one:
[Models and fits](../guide/models.md).

| Key              | Value                                                                                 |
|------------------|---------------------------------------------------------------------------------------|
| `name`           | the model's name; scenarios name it in `model`                                        |
| `dataset`        | the dataset to fit: `datasets/<this>.yaml`                                            |
| `window`         | `{ start, end }`, dates: fit on these dates only; default the whole CSV               |
| `summary_window` | `{ start, end }`: the period Meridian's HTML report summarises; default the fit's     |
| `model_spec`     | `ModelSpec`'s arguments ([below](#model_spec))                                        |
| `priors`         | `PriorDistribution`'s fields ([below](#priors))                                       |
| `sampling`       | how many chains and draws ([below](#sampling))                                        |

## `model_spec`

[`meridian.model.spec.ModelSpec`](https://developers.google.com/meridian/reference/api/meridian/model/spec/ModelSpec)'s
arguments; those left out keep Meridian's defaults.

| Key                                    | Value                                                                       |
|----------------------------------------|-----------------------------------------------------------------------------|
| `media_effects_dist`                   | `log_normal` or `normal`: media effects across geos; unused in a national model |
| `hill_before_adstock`                  | `true`: Hill saturation before adstock instead of after; not for RF channels |
| `max_lag`                              | periods of carry-over in the adstock                                        |
| `adstock_decay_spec`                   | `geometric` or `binomial`, for all channels or per channel (others `geometric`) |
| `saturation_spec`                      | `hill` or `none`, for all channels or per channel (others `hill`)           |
| `media_prior_type`                     | `roi` (default), `mroi`, `contribution` or `coefficient`: which prior the media coefficients take |
| `rf_prior_type`                        | the same, for reach & frequency channels                                    |
| `organic_media_prior_type`             | `contribution` (default) or `coefficient`                                   |
| `organic_rf_prior_type`                | the same, for organic reach & frequency channels                            |
| `non_media_treatments_prior_type`      | `contribution` (default) or `coefficient`                                   |
| `non_media_baseline_values`            | non-media treatment → its baseline: a value, `min` (default) or `max`       |
| `knots`                                | time-effect knots: a count spread evenly, or period indices; national default 1; not with `enable_aks` |
| `enable_aks`                           | `true`: automatic knot selection; not with `knots`                          |
| `unique_sigma_for_each_geo`            | `true`: a residual variance per geo                                         |
| `baseline_geo`                         | the reference geo; default the most populated                               |
| `population_scaled_controls`           | controls scaled by population                                               |
| `population_scaled_non_media_channels` | non-media treatments scaled by population                                   |
| `holdout`                              | not supported yet: leave it out                                             |

## `priors`

[`PriorDistribution`](https://developers.google.com/meridian/reference/api/meridian/model/prior_distribution/PriorDistribution)'s
fields, each one TensorFlow Probability distribution:

```yaml
priors:
  roi_m:                                     # per channel, with a default for the others
    dist: LogNormal
    default: { mean: 1.0, sd: 1.0 }          # LogNormal: mean and sd in ROI units, or loc and scale of the log
    tv: { mean: 1.5, sd: 0.8 }
  sigma: { dist: HalfNormal, scale: 3 }      # once
```

| Argument                           | Distributions                                            |
|------------------------------------|----------------------------------------------------------|
| `loc`, `scale`                     | Normal, HalfNormal (`scale`), TruncatedNormal, StudentT, HalfCauchy, LogNormal (of the log), Deterministic (`loc`) |
| `mean`, `sd`                       | LogNormal only, in the distribution's own units           |
| `low`, `high`                      | Uniform, TruncatedNormal                                  |
| `concentration1`, `concentration0` | Beta                                                      |
| `concentration`, `rate`            | Gamma (`rate`: Exponential too)                           |
| `df`                               | StudentT                                                  |
| `shift`                            | any: moves the distribution by this much                  |

### Channels' priors

Per channel, by channel name, with a `default`. The column says which channels; Meridian's default in brackets.

| Parameter                     | Paid media             | Reach & frequency      | Organic media         | Organic R&F           |
|-------------------------------|------------------------|------------------------|-----------------------|-----------------------|
| ROI, with prior type `roi`    | `roi_m` (LogNormal(0.2, 0.9)) | `roi_rf` (LogNormal(0.2, 0.9)) |              |                       |
| marginal ROI, with `mroi`     | `mroi_m` (LogNormal(0, 0.5)) | `mroi_rf` (LogNormal(0, 0.5)) |                |                       |
| share of the KPI, with `contribution` | `contribution_m` (Beta(1, 99)) | `contribution_rf` (Beta(1, 99)) | `contribution_om` (Beta(1, 99)) | `contribution_orf` (Beta(1, 99)) |
| coefficient, with `coefficient` | `beta_m` (HalfNormal(5)) | `beta_rf` (HalfNormal(5)) | `beta_om` (HalfNormal(5)) | `beta_orf` (HalfNormal(5)) |
| its spread across geos        | `eta_m` (HalfNormal(1)) | `eta_rf` (HalfNormal(1)) | `eta_om` (HalfNormal(1)) | `eta_orf` (HalfNormal(1)) |
| adstock decay, on [0, 1]      | `alpha_m` (Uniform(0, 1)) | `alpha_rf` (Uniform(0, 1)) | `alpha_om` (Uniform(0, 1)) | `alpha_orf` (Uniform(0, 1)) |
| Hill half-saturation          | `ec_m` (TruncatedNormal(0.8, 0.8, 0.1, 10)) | `ec_rf` (LogNormal(0.7, 0.4) + 0.1) | `ec_om` (TruncatedNormal(0.8, 0.8, 0.1, 10)) | `ec_orf` (LogNormal(0.7, 0.4) + 0.1) |
| Hill slope                    | `slope_m` (Deterministic(1)) | `slope_rf` (LogNormal(0.7, 0.4)) | `slope_om` (Deterministic(1)) | `slope_orf` (LogNormal(0.7, 0.4)) |

### Controls, treatments and the model's own

| Field                 | Prior on                                                              | Meridian's default             |
|-----------------------|-----------------------------------------------------------------------|--------------------------------|
| `gamma_c`             | each control's coefficient, its mean across geos (per control)        | Normal(0, 5)                   |
| `xi_c`                | its standard deviation across geos (per control)                      | HalfNormal(5)                  |
| `contribution_n`      | each non-media treatment's share of the KPI, with prior type `contribution` | TruncatedNormal(0, 0.1, -1, 1) |
| `gamma_n`             | each non-media treatment's coefficient, its mean across geos          | Normal(0, 5)                   |
| `xi_n`                | its standard deviation across geos                                    | HalfNormal(5)                  |
| `knot_values`         | the time effects at the knots (once)                                  | Normal(0, 5)                   |
| `tau_g_excl_baseline` | each geo's level against the baseline geo (once)                      | Normal(0, 5)                   |
| `sigma`               | the noise's standard deviation (once)                                 | HalfNormal(5)                  |

Hover a field in the editor for Meridian's own description of it.

## `sampling`

| Key        | Default  | Value                                                                  |
|------------|----------|------------------------------------------------------------------------|
| `n_prior`  | `500`    | prior draws                                                            |
| `n_chains` | `[2, 2]` | MCMC chains; a list runs them in batches, which takes less memory      |
| `n_adapt`  | `1000`   | adaptation steps per chain                                             |
| `n_burnin` | `0`      | burn-in steps after adaptation                                         |
| `n_keep`   | `1000`   | draws kept per chain                                                   |
| `seed`     |          | for reproducible fits                                                  |
