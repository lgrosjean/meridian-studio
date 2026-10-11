# Budget scenarios

A scenario runs Meridian's
[`BudgetOptimizer`](https://developers.google.com/meridian/reference/api/meridian/analysis/optimizer/BudgetOptimizer)
on a fitted model: how to split a budget across the channels, within bounds. **New scenario** writes
`scenarios/<name>.yaml` on a model:

```yaml
name: plus-10
model: synthetic-v1                  # models/synthetic-v1.yaml, fitted first
# window: { start: 2024-01-01, end: 2024-12-30 }   the period whose spend is reallocated; default the whole fit
budget: +10%                         # historical, an amount, or a change like +10%
bounds: { lower: 0.3, upper: 0.3 }   # how far a channel may move from its historical spend, as a fraction
channels:                            # per-channel bounds, overriding bounds
  ch0: { lower: 0.1, upper: 0.5 }
```

## Budget, or a target

- **`budget`**: `historical` keeps the window's spend; a number is an amount; `+10%` or `-5%` moves from the
  historical spend.
- **`target`** instead lets the budget float until it is met: `{ roi: 2.0 }`, the total ROI to reach, or
  `{ mroi: 1.5 }`, the marginal ROI below which nothing more is spent. `budget` is then ignored.

## Bounds

`bounds` says how far every channel may move from its historical spend, as fractions: `{ lower: 0.3, upper: 0.3 }`
(Meridian's default) keeps each between 70% and 130% of what it spent. `channels` overrides them channel by
channel, by the names the dataset gives them.

## Optimize

Click **▶ Optimize** above the file, or on the scenario in the tree; it is also a [task](runs.md#tasks), which can
depend on the model's fit. It reloads the model's latest fit (`model.binpb`): the project's copy, or, when it is
gone (another machine, with a [shared tracking server](models.md#where-runs-and-files-go)), MLflow's.

The results open beside the editor: the budget, outcome and ROI before and after, and each channel's spend, ROI
and outcome before and after. Meridian's "before" is the historical mix scaled to the scenario's budget: the same
money, split as before.

![A budget scenario: its YAML with ▶ Optimize above it, and the spend by channel before and after Meridian's optimizer](https://raw.githubusercontent.com/lgrosjean/meridian-studio/main/media/screenshots/scenario.png)

They are also in `scenarios/<name>.result.json`, with the fit they came from (its MLflow run), and Meridian's
optimization summary in `scenarios/<name>.html`.

Each optimization is an MLflow run, under its fit's run: the scenario as parameters (`budget`, `bounds`, `channels`,
`target`, `window`), the budget, outcome and ROI before and after as metrics, in total and by channel, and Meridian's
summary, the scenario's YAML and its result as artifacts. A scenario refused before it starts (a budget it cannot
read, say) makes no run. **Open MLflow**, on the scenario, opens it.
