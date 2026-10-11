# Runs and tasks

## Meridian Runs

**Meridian Runs**, a tab of the bottom panel, lists every fit of every model with its metrics. Click one for its
results; tick two to compare them: their metrics, ROI by channel, and the configuration that differs.

Each model's own runs are also under it in the sidebar; an [outdated](models.md#history-and-mlflow) one is flagged.

## Tasks

Every fit and optimization is a VS Code task of type `meridian` (**Terminal › Run Task**). It runs in the
integrated terminal, stops and reruns like any task, and chains with `dependsOn`:

```jsonc
// .vscode/tasks.json: refit the model, then its scenario
{
  "version": "2.0.0",
  "tasks": [
    { "label": "fit v1", "type": "meridian", "file": "models/synthetic-v1.yaml" },
    { "label": "plus-10", "type": "meridian", "file": "scenarios/plus-10.yaml", "dependsOn": "fit v1" }
  ]
}
```

`file` is the model to fit or the scenario to optimize, relative to the workspace folder. A fit from a task runs the
dataset's [data checks](data-checks.md#before-a-fit) first, as ▶ Fit does.
