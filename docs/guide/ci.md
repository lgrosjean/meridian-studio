# Checks in CI

The [data checks](data-checks.md) run without VS Code, from a copy of the repository's `runner/`: the runner's
`check` command takes the project's folder, then datasets or models (every dataset when none), and exits 1 on an
error. The data checks need only pandas and pyyaml, so CI installs neither Meridian nor TensorFlow.

## GitHub Actions

```yaml
# .github/workflows/data-checks.yml: the findings as annotations on the pull request
name: data checks
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@v4           # the runner only; pin it with ref: <a commit>
        with: { repository: lgrosjean/meridian-studio, path: .meridian-studio, sparse-checkout: runner }
      - uses: astral-sh/setup-uv@v6
      - run: uv run --no-project --with pandas --with pyyaml python .meridian-studio/runner/runner.py check . --format github
```

Each finding becomes an annotation on the line of the dataset naming the column, in the pull request's diff.

## Formats

=== "text"

    ```text
    datasets/weekly.yaml:4:9: T001 [error] 1 week missing from week: 2024-02-12. Meridian wants the dates regularly spaced
    Found 1 error and 0 warnings in 1 file.
    ```

    Where the YAML names the column; `All checks passed (N files).` when there is nothing to say.

=== "github"

    GitHub Actions workflow commands, one per finding, then the same summary line:

    ```text
    ::error file=datasets/weekly.yaml,line=4,col=9,title=T001::1 week missing from week: 2024-02-12. Meridian wants the dates regularly spaced
    ```

=== "json"

    A list of the findings:

    ```json
    [
      {
        "file": "datasets/weekly.yaml",
        "line": 4,
        "column": 9,
        "code": "T001",
        "severity": "error",
        "message": "1 week missing from week: 2024-02-12. Meridian wants the dates regularly spaced"
      }
    ]
    ```

| Exit code | When                                                 |
|-----------|------------------------------------------------------|
| 0         | no error (warnings may remain)                       |
| 1         | an error, or a file it could not check               |
| 2         | a bug in the runner                                  |

## A model's checks

Meridian's own data checks on a model need the runner's environment, Meridian included:

```sh
uv run --project .meridian-studio/runner .meridian-studio/runner/runner.py check . models/<name>.yaml
```
