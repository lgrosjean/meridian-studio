# Changelog

## 0.1.1

- Fix: a finished scenario showed "ROI ? → ?" in the tree; the optimizer now reports ROI, budget and outcome before and after.
- README: screenshots of the extension at work.

## 0.1.0

- Datasets, models and scenarios as YAML in `datasets/`, `models/`, `scenarios/`, with JSON schemas for completion.
- Datasets are Meridian's `CsvDataLoader` arguments; the tree shows each CSV column with its role.
- Fit and Optimize from the sidebar or the link above the file; results panel, Meridian's report in the editor.
- A model's priors and its run history (`<model>.runs.jsonl`) in the tree; fits tracked in a local or remote MLflow.
- uv installed on first use when missing.
- Apache License 2.0, as Meridian.
