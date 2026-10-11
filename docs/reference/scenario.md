# Scenario YAML

`scenarios/<name>.yaml`, validated against `schemas/scenario.schema.json`. How to write one:
[Budget scenarios](../guide/scenarios.md).

| Key        | Value                                                                                          |
|------------|------------------------------------------------------------------------------------------------|
| `name`     | the scenario's name                                                                            |
| `model`    | the fitted model: `models/<this>.yaml`, fitted first                                           |
| `window`   | `{ start, end }`, dates: the period whose spend is reallocated; default the whole fit          |
| `budget`   | `historical` (default), an amount, or a change from historical like `+10%`; ignored with `target` |
| `bounds`   | how far every channel may move from its historical spend ([below](#bounds))                    |
| `channels` | channel → its own bounds, overriding `bounds`: `{ tv: { lower: 0.1, upper: 0.5 } }`            |
| `target`   | a flexible budget: spend until the target is met ([below](#target))                            |

## `bounds`

Fractions of each channel's historical spend; a channel in `channels` takes its own.

| Key     | Default | Value                                      |
|---------|---------|--------------------------------------------|
| `lower` | `0.3`   | at most this fraction below, from 0 to 1   |
| `upper` | `0.3`   | at most this fraction above                |

## `target`

One of:

| Key    | Value                                             |
|--------|---------------------------------------------------|
| `roi`  | the total ROI to reach                            |
| `mroi` | the marginal ROI below which nothing more is spent |

The budget then floats until the target is met, and `budget` is ignored.
