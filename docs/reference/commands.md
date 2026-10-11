# Commands and settings

## In the sidebar

| Command               | Where                                                     | What it does                                                    |
|-----------------------|-----------------------------------------------------------|-----------------------------------------------------------------|
| New dataset           | Datasets' title bar                                       | asks for a CSV and a name, writes `datasets/<name>.yaml` filled from it |
| New model             | Models' title bar                                         | asks for a dataset and a name, writes `models/<name>.yaml` |
| New scenario          | Scenarios' title bar                                      | asks for a model and a name, writes `scenarios/<name>.yaml` |
| Refresh               | each view's title bar                                     | rereads the files                                               |
| Run (▶)               | a model or scenario: inline, and above the file            | saves the file, then fits the model or optimizes the scenario   |
| Stop (■)              | a running model or scenario                               | stops the run                                                   |
| Show results          | a model or scenario that ran: inline, and above the file   | the latest run's results, beside the editor                     |
| Open Meridian report  | a model or scenario that ran, right-click                 | Meridian's HTML report, in the editor                           |
| Open MLflow           | Models' title bar; a model, scenario or past fit, right-click; the results panel; the palette | MLflow's UI on the project's experiment, or on that run ([Open MLflow](../guide/models.md#open-mlflow)) |
| Complete from the CSV | a dataset, right-click; **Complete from \<csv\>** above the file | places the CSV's unused columns ([Datasets](../guide/datasets.md#filled-from-the-csv)) |
| Check data            | a dataset, right-click; **Check the data** above the file  | the dataset's [data checks](../guide/data-checks.md)            |
| Check with Meridian   | a model, right-click; **Check** above the file             | Meridian's data checks with the model's spec, without sampling  |
| Set role…             | a dataset's column, inline and right-click                 | sets the role of the selected columns ([Datasets](../guide/datasets.md#roles-from-the-tree)) |
| Rename…, Delete       | a dataset, model or scenario, right-click                  | carry its runs along, and update the files that name it         |

Above a model or a scenario, a lens also shows its last run's state; click it for the runner's output (**Show runner
output**).

## Tasks

| Property | Value                                                                                                   |
|----------|---------------------------------------------------------------------------------------------------------|
| `type`   | `meridian`                                                                                              |
| `file`   | the model to fit or the scenario to optimize: `models/<name>.yaml` or `scenarios/<name>.yaml`, relative to the workspace folder |

Examples in [Runs and tasks](../guide/runs.md#tasks).

## Settings

| Setting                           | Default | Meaning                                                                             |
|-----------------------------------|---------|-------------------------------------------------------------------------------------|
| `meridian.mlflowTrackingUri`      | empty   | where fits and scenarios are logged (their params, metrics, tags). Empty: a SQLite store in the project (`mlflow.db`). A URI such as `http://mlflow.example.com:5000` logs to that server instead. Also read from `MLFLOW_TRACKING_URI`. |
| `meridian.mlflowArtifactLocation` | empty   | where a new experiment keeps its runs' files. Empty: `mlruns/` in the project with the project's store, the server's own artifact store with a server. MLflow sets it when it creates the experiment, and never moves it ([where runs and files go](../guide/models.md#where-runs-and-files-go)). |
