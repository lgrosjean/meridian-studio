# Data checks

A dataset's CSV is checked by the role of each column, like code by a linter: each finding has a code, sits in
Problems on the line naming its column, and is counted above the file (**Data: 2 errors, 1 warning**).

- **Errors** are what Meridian would refuse: the fit would stop on them.
- **Warnings** are what it would take but estimate badly.

The checks run when a dataset or a CSV is saved and when the window opens, once Meridian's environment is installed:
by a first fit, or by **Check the data** above the file (**Check data** on the dataset in the tree), which installs
it. They take under a second and need no fit.

## The checks

| Code | Columns                         | Finds                                                  |                                                  |
|------|---------------------------------|--------------------------------------------------------|--------------------------------------------------|
| T001 | time                            | weeks missing between the dates                        | error: Meridian wants them regularly spaced      |
| T002 | time                            | a date off the weekly step                             | error, likewise                                  |
| T003 | time                            | geos with different dates                              | error                                            |
| K001 | kpi                             | empty cells after the KPI's first value                | error: Meridian takes them only before it starts |
| K002 | kpi, revenue_per_kpi            | negative values                                        | error                                            |
| M001 | media, spend, reach, frequency  | negative values                                        | error; a warning for impressions and organic media |
| M002 | spend, organic media            | a channel active in few weeks (under 10%)              | warning; an error for a paid one never spending  |
| M003 | spend, organic media            | zero over the last 4 weeks, after activity             | warning: data not loaded yet?                    |
| S001 | spend                           | a channel under 1% of all spend                        | warning: its ROI will be very uncertain          |
| C001 | controls, treatments, organic   | a column that never varies over time                   | error                                            |

In a geo dataset, T003 compares the geos' dates, and C001 flags a column that never varies within any geo.

## Turning a check off

As code, in the dataset's YAML, where completion lists the codes with what each checks:

```yaml
checks:
  ignore: [S001]                       # for the whole dataset
  thresholds: { min_active_share: 0.1, trailing_weeks: 4, min_spend_share: 0.01 }
  columns:
    search_spend: { ignore: [M003] }   # for one column
coord_to_columns:
  controls: [price, covid]   # noqa: C001   (on any line naming the column)
```

A bare `# noqa` turns every check off for the columns its line names.

| Threshold          | Default | Used by                                                          |
|--------------------|---------|------------------------------------------------------------------|
| `min_active_share` | `0.1`   | M002: a channel active in fewer weeks than this share of them    |
| `trailing_weeks`   | `4`     | M003: a channel at zero over this many last weeks                |
| `min_spend_share`  | `0.01`  | S001: a channel spending less than this share of all spend       |

An unknown code or threshold in `checks` stops the checks with a message listing the right ones: a typo never
leaves a check on silently.

Which checks are off is not data: changing `checks` leaves the dataset's fits current.

## Meridian's own checks, without a fit

**Check**, above a model, runs Meridian's own data checks with that model's spec, without sampling: pairwise
correlation between variables, a variable that barely varies, cost per media unit, and the rest of what a fit would
find in its first seconds, in about fifteen seconds. They land in Problems on the lines naming their variables, in
the model and in its dataset.

## Before a fit

**▶ Fit runs the dataset's checks first.** When they find an error (data Meridian would refuse), the fit asks
first: **Show Problems**, or **Fit anyway**. A fit from a [task](runs.md#tasks) asks the same.

The same checks run without VS Code, on every pull request: [Checks in CI](ci.md).
