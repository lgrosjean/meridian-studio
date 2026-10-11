# Getting started

## Install

=== "VS Code"

    Install [Meridian Studio](https://marketplace.visualstudio.com/items?itemName=lgrosjean.meridian-studio) from
    the Marketplace, or:

    ```sh
    code --install-extension lgrosjean.meridian-studio
    ```

=== "Cursor"

    Cursor installs from Open VSX, where Meridian Studio is not published yet. Download the `.vsix` from the
    [Marketplace page](https://marketplace.visualstudio.com/items?itemName=lgrosjean.meridian-studio), then:

    ```sh
    cursor --install-extension meridian-studio-<version>.vsix
    ```

It needs VS Code 1.100 or later, and installs Red Hat's [YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)
with it: completion and errors in the YAML come through it.

## A first model, on your CSV

Meridian takes one row per week (and per geo, in a geo model): the date, the KPI, then each channel's impressions
and spend, and the controls. Dates read `yyyy-mm-dd`.

1. **Open the folder** holding your CSV, click the Meridian icon in the activity bar, then **New dataset** and pick
   the CSV. `datasets/<name>.yaml` opens, filled from the CSV as far as its content and column names allow: the
   dates as `time`, impressions paired with their spend into channels, the KPI and controls by name. Complete
   what is left in the YAML, where the CSV's columns are offered, or from the tree:
   [Datasets](guide/datasets.md).
2. **New model** on that dataset writes `models/<name>.yaml`: Meridian's `ModelSpec`, priors, sampling. Click
   **▶ Fit** above the file. The dataset's [data checks](guide/data-checks.md) run first; the fit then takes a few
   minutes on CPU, and its results open beside the editor: [Models and fits](guide/models.md).
3. **New scenario** on that model writes `scenarios/<name>.yaml`: a budget, how far each channel may move. Click
   **▶ Optimize**: [Budget scenarios](guide/scenarios.md).

The project ends up as:

```text
<project>/
  data/national_media.csv          your CSVs
  datasets/synthetic.yaml          which CSV, which columns, which channels
  models/synthetic-v1.yaml
  models/synthetic-v1.result.json  the latest fit: quality, ROI per channel, where MLflow put the artifacts
  models/synthetic-v1.runs.jsonl   every fit, one line each
  scenarios/plus-10.yaml
  scenarios/plus-10.result.json    spend and outcome per channel, before and after
  scenarios/plus-10.html           Meridian's optimization summary
  mlflow.db, mlruns/               the local MLflow store (keep it out of git)
```

!!! tip "No CSV at hand?"
    The repository's [`examples/`](https://github.com/lgrosjean/meridian-studio/tree/main/examples) folder is a
    project on Meridian's simulated national data: a dataset, a model, a scenario. Open it and click ▶ Fit.

## The first run

The first fit installs what it needs:

- [uv](https://docs.astral.sh/uv/) if it is not on the machine, after asking: into the extension's own storage,
  without changing your `PATH`.
- Python and Meridian (with TensorFlow), in the extension's folder: a few minutes and about 1 GB, once.

Fits run on your machine, on CPU, and log to an MLflow store in the project, unless `meridian.mlflowTrackingUri`
points to an MLflow server ([settings](reference/commands.md#settings)).
