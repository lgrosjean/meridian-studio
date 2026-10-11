# Datasets

A dataset says which CSV a model reads and what each of its columns is: Meridian's
[`CsvDataLoader`](https://developers.google.com/meridian/reference/api/meridian/data/load/CsvDataLoader)
arguments, its `csv_path` written `csv`. It lives in `datasets/<name>.yaml`, and the sidebar unfolds it into the
CSV's columns, each with its role; the unused ones are greyed, and a column the YAML names but the CSV lacks shows
in red.

```yaml
name: synthetic
csv: data/national_media.csv          # relative to the project, or absolute
kpi_type: non_revenue
currency_code: USD
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

## Roles

`coord_to_columns` gives each role its column, or its list of columns:

| Role                   | Columns   | What they hold                                                         |
|------------------------|-----------|------------------------------------------------------------------------|
| `time`                 | one       | dates, `yyyy-mm-dd`, one row per week (and geo)                        |
| `geo`                  | one       | the geo of each row; leave it out for a national model                 |
| `kpi`                  | one       | what media moves: sales, conversions, revenue                          |
| `revenue_per_kpi`      | one       | money per KPI unit, with `kpi_type: non_revenue`                       |
| `population`           | one       | the population of each geo                                             |
| `controls`             | a list    | what moves the KPI that media does not: seasonality, price, distribution |
| `media`                | a list    | impressions, GRP or clicks of each paid channel                        |
| `media_spend`          | a list    | each paid channel's spend                                              |
| `reach`, `frequency`, `rf_spend` | lists | reach & frequency channels: their reach, frequency and spend    |
| `non_media_treatments` | a list    | levers that are not media: price, promotions                           |
| `organic_media`        | a list    | unpaid media: emails, organic social                                   |
| `organic_reach`, `organic_frequency` | lists | unpaid reach & frequency                                    |

**Channels.** Each media column maps to its channel's name in `media_to_channel`, each spend column to the same
names in `media_spend_to_channel`; likewise `reach_to_channel`, `frequency_to_channel`, `rf_spend_to_channel` and
the organic ones. Meridian pairs `media` and `media_spend` by position: list them in the same channel order. A
channel without impressions may name its spend column in both `media` and `media_spend`.

**`kpi_type`.** `revenue` when the KPI is money. `non_revenue` when it counts units (conversions, visits), with
`revenue_per_kpi` to read the results in money; without it, ROI priors apply to the KPI itself.

**Geo models.** With a `geo` column, every geo has a row for every date, and `population` scales the geos. A
national model needs neither.

## Filled from the CSV

**New dataset** asks for a CSV and fills the YAML as far as the CSV's content and column names allow:

- the column of dates becomes `time`, the column repeating them `geo`;
- a channel's impressions pair with its spend by name: `tv_imps` and `tv_spend` make channel `tv`; reach, frequency
  and spend likewise;
- the KPI, revenue per KPI and controls come by name.

A column it cannot place stays unused, greyed in the tree. **Complete from \<csv\>**, above the file, does it again,
after the CSV gains columns say; the lens counts the columns it would place, its tooltip says where.

## Completion and hover

Under `coord_to_columns`, completion offers the CSV's columns no role holds yet, likeliest first (dates for `time`,
numbers named like spend for `media_spend`…), each with what it holds:

```text
time                      dates · 2021-01-25 → 2024-01-15
Channel2_spend            numbers · 28.2K – 355K
sentiment_score_control   numbers · -2.49 – 1.7
```

In a `*_to_channel` map, it offers the role's columns not mapped yet, all at once if you like, each with its
channel (`tv_spend` gets `tv` when `tv_imps` is `tv`). A hover on a column says what it holds and which role has it.

## Mistakes, underlined with their fix

As you type, the dataset is checked against its CSV; each finding has a quick fix
(++cmd+period++ / ++ctrl+period++) where one exists:

- a column the CSV lacks, and the one it likely meant;
- dates not written `yyyy-mm-dd`, or text where numbers go;
- a column in two roles;
- a media column without a channel, a channel with impressions but no spend;
- `media_spend` listing its channels in another order than `media`;
- dates that repeat without a `geo` column;
- a `revenue_per_kpi` that `kpi_type: revenue` ignores.

These are about the YAML. What the CSV's values say (missing weeks, negative spend…) is the
[data checks](data-checks.md)' job.

## Roles from the tree

Right-click a column in the tree, **Set role…**: the roles are listed likeliest first, with **Not used** to take
the column out. Select several columns with ++cmd++-click (++ctrl++-click) to set them at once. A channel's
column asks for its channel, offering the one its partner column already has. The YAML is rewritten in place, its
layout and comments kept; a YAML that does not parse is left as it is.

The tree refreshes when a CSV changes.
