# Dataset YAML

`datasets/<name>.yaml`: Meridian's
[`CsvDataLoader`](https://developers.google.com/meridian/reference/api/meridian/data/load/CsvDataLoader)
arguments, its `csv_path` written `csv`, plus the [data checks](../guide/data-checks.md)' settings. The editor
validates it against `schemas/dataset.schema.json`. How to write one: [Datasets](../guide/datasets.md).

| Key                  | Value                                                                                        |
|----------------------|----------------------------------------------------------------------------------------------|
| `name`               | the dataset's name; models name it in `dataset`                                              |
| `csv`                | the CSV, relative to the project or absolute; dates in the time column read `yyyy-mm-dd`     |
| `kpi_type`           | `revenue`: the KPI is money. `non_revenue`: units, with `revenue_per_kpi` to read results in money |
| `currency_code`      | ISO 4217, for the reports: `EUR`, `USD`                                                      |
| `coord_to_columns`   | each role → its CSV column, or list of columns ([below](#coord_to_columns))                  |
| `media_to_channel`   | each `media` column → its channel's name; required with `media`                              |
| `media_spend_to_channel` | each `media_spend` column → the same channel names                                       |
| `reach_to_channel`, `frequency_to_channel`, `rf_spend_to_channel` | each reach & frequency column → its channel |
| `organic_reach_to_channel`, `organic_frequency_to_channel` | each organic reach & frequency column → its channel |
| `checks`             | which data checks are off, and their thresholds ([below](#checks))                           |

## `coord_to_columns`

| Role                   | Value     | What it holds                                                              |
|------------------------|-----------|----------------------------------------------------------------------------|
| `time`                 | a column  | dates, `yyyy-mm-dd`, one row per period (and geo)                          |
| `geo`                  | a column  | the geo of each row; leave it out for a national model                     |
| `kpi`                  | a column  | what media moves: sales, conversions, revenue                              |
| `revenue_per_kpi`      | a column  | money per KPI unit, with `kpi_type: non_revenue`                           |
| `population`           | a column  | population per geo; reset to 1 in a national model                         |
| `controls`             | a list    | what moves the KPI that media does not: seasonality, price, distribution   |
| `media`                | a list    | execution per paid channel: impressions, GRP, clicks                       |
| `media_spend`          | a list    | spend per paid channel, the same channels as `media`, in the same order    |
| `reach`                | a list    | reach & frequency channels: their reach                                    |
| `frequency`            | a list    | reach & frequency channels: their frequency                                |
| `rf_spend`             | a list    | reach & frequency channels: their spend                                    |
| `non_media_treatments` | a list    | levers that are not media: price, promotions, discount                     |
| `organic_media`        | a list    | unpaid media: blog posts, emails, organic social                           |
| `organic_reach`        | a list    | unpaid reach & frequency channels: their reach                             |
| `organic_frequency`    | a list    | unpaid reach & frequency channels: their frequency                         |

## `checks`

| Key          | Value                                                                                   |
|--------------|-----------------------------------------------------------------------------------------|
| `ignore`     | codes of the checks off for the whole dataset: `[S001, M003]`                           |
| `thresholds` | `min_active_share` (`0.1`, M002), `trailing_weeks` (`4`, M003), `min_spend_share` (`0.01`, S001) |
| `columns`    | column → `{ ignore: [codes] }`, the checks off for that column                          |

`# noqa: CODE` (or `# noqa: CODE1, CODE2`) at the end of a line naming a column turns those checks off for that
column; a bare `# noqa`, all of them. The codes: [Data checks](../guide/data-checks.md#the-checks).
