# Meridian Studio

> Unofficial, community project. Not affiliated with, endorsed by or sponsored by Google.
> Meridian and the Meridian logo are trademarks of Google LLC. Google's own product named
> Meridian Studio is at https://developers.google.com/meridian/studio; this extension is unrelated.

A VS Code / Cursor extension that runs [Google Meridian](https://github.com/google/meridian) from three
folders of YAML files:

| Sidebar   | Folder        | The YAML says                                   | Play runs                               |
|-----------|---------------|-------------------------------------------------|-----------------------------------------|
| Datasets  | `datasets/`   | a CSV and how Meridian reads it (`CsvDataLoader`'s arguments) | nothing: a fit reads the CSV |
| Models    | `models/`     | the dataset, `ModelSpec`, priors, sampling      | the fit, into MLflow + `<name>.result.json` |
| Scenarios | `scenarios/`  | the model, a budget, bounds per channel         | `BudgetOptimizer`, into `<name>.result.json` + `<name>.html` |

You edit the YAML in the editor; the extension lists, launches and records. A run leaves `<name>.run.json`
next to its file, which the tree reads (running, done, failed, outdated when the YAML or its input changed).
Fits and optimizations each produce Meridian's own HTML report, opened in a panel beside the editor from the results panel (its charts load Vega from gstatic.com, so they need the network).

A dataset is [`CsvDataLoader`](https://developers.google.com/meridian/reference/api/meridian/data/load/CsvDataLoader)'s
arguments in YAML, `csv` standing for `csv_path` (relative to the project, or absolute):

```yaml
name: synthetic
csv: data/national_media.csv
kpi_type: non_revenue
coord_to_columns:
  time: time
  kpi: conversions
  revenue_per_kpi: revenue_per_conversion
  controls: [competitor_activity_score_control, sentiment_score_control]
  media: [Channel0_impression, Channel1_impression]
  media_spend: [Channel0_spend, Channel1_spend]
media_to_channel: { Channel0_impression: ch0, Channel1_impression: ch1 }
media_spend_to_channel: { Channel0_spend: ch0, Channel1_spend: ch1 }
```

New dataset picks the CSV and writes this skeleton with the CSV's header in a comment.

`schemas/` holds a JSON schema per kind, wired to `datasets/`, `models/` and `scenarios/` through the YAML
extension (installed with this one): completion, hover docs and errors while you type.

## Setup

- Nothing to install by hand. The first Fit looks for [uv](https://docs.astral.sh/uv/); if it is missing,
  the extension offers to install it (Astral's installer, pinned, into the extension's own storage: no PATH
  or shell profile change). uv then installs Python and Meridian, once (a few minutes, about 1 GB).
- Build: `bun install && bun run build`, then F5 in Cursor opens `examples/` with the extension loaded.
- Install for good: `bun run package` then `cursor --install-extension meridian-studio-0.1.0.vsix`.
- Check the uv install: `bun run build && HOME=$(mktemp -d) PATH=/usr/bin:/bin $(which node) scripts/check-uv.js` (downloads uv).
- Check: `bun run test` (the tree's dataset columns, then the runner: fits the example tiny, optimizes it).

## Files

```
<project>/
  data/national_media.csv          your CSVs
  datasets/synthetic.yaml          which CSV, which columns, which channels
  models/synthetic-v1.yaml
  models/synthetic-v1.result.json  the latest fit: quality, ROI per channel, where MLflow put the artifacts
  models/synthetic-v1.runs.jsonl   every fit, one line each: when, the config it ran, what it found
  scenarios/plus-10.yaml
  scenarios/plus-10.result.json    spend and outcome per channel, before and after
  scenarios/plus-10.html           Meridian's optimization summary
  mlflow.db, mlruns/               the local MLflow store (ignored by git)
```

Set `meridian.mlflowTrackingUri` to log fits to a remote MLflow server instead of the local store.

## License

MIT, see `LICENSE`. [Google Meridian](https://github.com/google/meridian) is Apache 2.0 and is installed by
uv at run time, not bundled. The icons in `media/` reproduce the Meridian logo, a Google trademark: they are
not covered by this license.
