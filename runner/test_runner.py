"""Self-check: the data checks on CSVs made to break them; fit the synthetic example tiny, optimize on it; assert on the
protocol and the files.
Run: uv run --project runner runner/test_runner.py   (a minute or two on CPU)"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).parent
os.environ.setdefault("MLFLOW_DISABLE_AGENT_HINT", "1")


def refuse(constant):
    raise ValueError(f"{constant} is not JSON: the extension's parser would drop the line")


def run(*args) -> tuple[int, list[dict]]:
    p = subprocess.run([sys.executable, str(HERE / "runner.py"), *args], capture_output=True, text=True)
    events = [json.loads(l, parse_constant=refuse) for l in p.stdout.splitlines()]  # strict JSON, as the extension parses it
    if p.returncode == 2:
        print(p.stderr, file=sys.stderr)
    return p.returncode, events


def found(events) -> list[tuple[str, str, str]]:
    """The data checks' findings: (code, column, fail | review)."""
    return sorted((i["code"], i["vars"][0], i["status"]) for e in events if e["event"] == "checks" for i in e["items"])


def data_checks(project: Path):
    """Each rule on a CSV made to break it; then what turns them off: checks.ignore, checks.columns, # noqa, thresholds."""
    import numpy as np
    import pandas as pd

    sys.path.insert(0, str(HERE))
    import checks

    schema = json.loads((HERE.parent / "schemas/dataset.schema.json").read_text())
    assert [(c["const"], c["description"]) for c in schema["definitions"]["check"]["anyOf"]] == [(k, w) for k, (w, _) in checks.RULES.items()], "schema and checks.py list the same checks"
    assert {k: v["default"] for k, v in schema["properties"]["checks"]["properties"]["thresholds"]["properties"].items()} == checks.THRESHOLDS

    code, ev = run("check", str(project), "datasets/synthetic.yaml")  # the example is clean
    assert code == 0 and found(ev) == [] and ev[-1]["summary"]["rows"] == 156, ev

    dates = [pd.Timestamp("2024-01-01") + pd.Timedelta(weeks=k) for k in range(30) if k != 10]  # T001: a week missing
    dates[20] += pd.Timedelta(days=2)  # T002: a date off the weekly step
    n = len(dates)
    rng = np.random.default_rng(1)
    df = pd.DataFrame({
        "week": [d.strftime("%Y-%m-%d") for d in dates], "sales": rng.uniform(100, 200, n),
        "tv_imps": rng.uniform(1e5, 2e5, n), "tv_spend": rng.uniform(1e3, 2e3, n), "radio_grp": 0.0, "radio_spend": 0.0,
        "search_clicks": rng.uniform(1e3, 2e3, n), "search_spend": rng.uniform(5e2, 1e3, n), "print_imps": 0.0, "print_spend": 0.0,
        "price": rng.uniform(9, 11, n), "covid": 1.0,
    })
    df.loc[:1, "sales"] = np.nan  # empty KPI before it starts: fine
    df.loc[15, "sales"] = np.nan  # K001
    df.loc[18, "sales"] = -5  # K002
    df.loc[5, "tv_imps"] = -10  # M001, a warning: Meridian takes negative impressions
    df.loc[6, "tv_spend"] = -1  # M001, an error: not negative spend
    df.loc[[3, 4], ["radio_grp", "radio_spend"]] = [50, 10]  # M002: active 2 weeks of 29; S001: a tiny share
    df.loc[n - 4:, ["search_clicks", "search_spend"]] = 0  # M003; print never spends: M002, an error
    df.to_csv(project / "data/broken.csv", index=False)
    yaml = (
        "csv: data/broken.csv\nkpi_type: non_revenue\ncoord_to_columns:\n  time: week\n  kpi: sales\n  controls: [price, covid]\n"
        "  media: [tv_imps, radio_grp, search_clicks, print_imps]\n  media_spend: [tv_spend, radio_spend, search_spend, print_spend]\n"
        "media_to_channel: { tv_imps: tv, radio_grp: radio, search_clicks: search, print_imps: print }\n"
        "media_spend_to_channel: { tv_spend: tv, radio_spend: radio, search_spend: search, print_spend: print }\n"
    )
    (project / "datasets/broken.yaml").write_text(yaml)
    code, ev = run("check", str(project), "datasets/broken.yaml")
    assert code == 0 and found(ev) == [
        ("C001", "covid", "fail"), ("K001", "sales", "fail"), ("K002", "sales", "fail"), ("M001", "tv_imps", "review"), ("M001", "tv_spend", "fail"),
        ("M002", "print_spend", "fail"), ("M002", "radio_spend", "review"), ("M003", "search_spend", "review"), ("S001", "radio_spend", "review"),
        ("T001", "week", "fail"), ("T002", "week", "fail"),
    ], found(ev)
    assert "2024-03-11" in next(i["text"] for i in ev[0]["items"] if i["code"] == "T001")  # it says which week
    assert ev[-1]["summary"] == {"errors": 7, "warnings": 4, "silenced": 0, "rows": 29}, ev[-1]

    # Off: for the dataset (any case), for a column, on a line; a threshold moved.
    (project / "datasets/broken.yaml").write_text(
        yaml.replace("controls: [price, covid]", "controls: [price, covid]   # noqa: C001")
        + "checks:\n  ignore: [T002, s001]\n  thresholds: { trailing_weeks: 6 }\n  columns:\n    tv_imps: { ignore: [M001] }\n"
    )
    code, ev = run("check", str(project), "datasets/broken.yaml")
    assert [c for c, _, _ in found(ev)] == ["K001", "K002", "M001", "M002", "M002", "T001"] and ev[-1]["summary"]["silenced"] == 2, ev
    (project / "datasets/broken.yaml").write_text(yaml + "checks: { ignore: [X999] }\n")
    code, ev = run("check", str(project), "datasets/broken.yaml")
    assert code == 1 and "no check X999" in ev[-1]["message"], ev

    # A geo dataset: the same dates in every geo (T003).
    pd.DataFrame({"week": ["2024-01-01", "2024-01-08", "2024-01-15"] * 2 + ["2024-01-22"], "geo": ["a"] * 3 + ["b"] * 3 + ["a"], "sales": 1.0, "tv_imps": 1.0, "tv_spend": 1.0}).to_csv(project / "data/geo.csv", index=False)
    (project / "datasets/geo.yaml").write_text(
        "csv: data/geo.csv\nkpi_type: revenue\ncoord_to_columns:\n  time: week\n  geo: geo\n  kpi: sales\n  media: [tv_imps]\n  media_spend: [tv_spend]\n"
        "media_to_channel: { tv_imps: tv }\nmedia_spend_to_channel: { tv_spend: tv }\n"
    )
    code, ev = run("check", str(project), "datasets/geo.yaml")
    assert found(ev) == [("T003", "week", "fail")] and "a adds 2024-01-22" in ev[0]["items"][0]["text"], ev
    for f in ("datasets/broken.yaml", "datasets/geo.yaml"):
        (project / f).unlink()


def main():
    with tempfile.TemporaryDirectory() as tmp:
        project = Path(tmp) / "project"
        shutil.copytree(HERE.parent / "examples", project, ignore=shutil.ignore_patterns("mlruns", "mlflow.db", "*.result.json", "*.run.json", "*.runs.jsonl", "*.html"))
        ds = "datasets/synthetic.yaml"
        data_checks(project)

        (project / "scenarios/early.yaml").write_text("model: tiny\n")
        (project / "models/tiny.yaml").write_text("dataset: synthetic\n")
        code, ev = run("optimize", str(project), "scenarios/early.yaml")
        assert code == 1 and "Fit tiny first" in ev[-1]["message"], ev

        # A dataset naming a column the CSV lacks fails readably, before any sampling.
        yaml_text = (project / ds).read_text()
        (project / ds).write_text(yaml_text.replace("kpi: conversions", "kpi: conversion"))
        code, ev = run("fit", str(project), "models/tiny.yaml")
        assert code == 1 and "conversion" in ev[-1]["message"], ev
        (project / ds).write_text(yaml_text)

        (project / "models/tiny.yaml").write_text(
            "dataset: synthetic\nmodel_spec: { max_lag: 4 }\n"
            "priors:\n"
            "  roi_m: { dist: LogNormal, default: { mean: 1, sd: 1 }, ch1: { mean: 2, sd: 1 } }\n"
            "  alpha_m: { dist: TruncatedNormal, default: { loc: 0.5, scale: 10, low: 0, high: 1 }, ch0: { loc: 0.6, scale: 0.2, low: 0.4, high: 0.85 } }\n"
            "  ec_m: { dist: Gamma, concentration: 2, rate: 2 }\n"
            "  sigma: { dist: HalfNormal, scale: 3 }\n"
            "sampling: { n_prior: 50, n_chains: [1], n_adapt: 50, n_burnin: 0, n_keep: 50, seed: 1 }\n"
        )
        # A prior Meridian cannot take fails readably, before any sampling.
        good = (project / "models/tiny.yaml").read_text()
        (project / "models/tiny.yaml").write_text(good.replace("ch1: { mean: 2, sd: 1 }", "ch9: { mean: 2, sd: 1 }"))
        code, ev = run("fit", str(project), "models/tiny.yaml")
        assert code == 1 and "ch9 not in" in ev[-1]["message"], ev
        (project / "models/tiny.yaml").write_text(good)

        code, ev = run("fit", str(project), "models/tiny.yaml")
        assert code == 0, ev
        r = json.loads((project / "models/tiny.result.json").read_text(), parse_constant=refuse)
        assert set(r) == {"mlflow", "fit", "channels", "currency", "dataset_fingerprint"}, r
        assert r["dataset_fingerprint"].startswith("sha256:") and ev[-1]["summary"]["fingerprint"] == r["mlflow"]["run_id"]
        assert all(c["roi_lo"] <= c["roi"] <= c["roi_hi"] for c in r["channels"]), r["channels"]
        assert (project / r["mlflow"]["report"]).exists() and (project / r["mlflow"]["artifacts"] / "model.binpb").exists()
        assert "mlruns/" in (project / ".gitignore").read_text()
        runs = [json.loads(l, parse_constant=refuse) for l in (project / "models/tiny.runs.jsonl").read_text().splitlines()]
        assert len(runs) == 1 and runs[0]["mlflow"]["run_id"] == r["mlflow"]["run_id"], runs
        assert runs[0]["config"]["priors"]["roi_m"]["ch1"] == {"mean": 2, "sd": 1} and runs[0]["at"].endswith("+00:00"), runs[0]

        (project / "scenarios/tiny-plus-10.yaml").write_text(
            "model: tiny\nbudget: +10%\nbounds: { lower: 0.3, upper: 0.3 }\nchannels: { ch0: { lower: 0.1, upper: 0.5 } }\n"
        )
        code, ev = run("optimize", str(project), "scenarios/tiny-plus-10.yaml")
        assert code == 0, ev
        o = json.loads((project / "scenarios/tiny-plus-10.result.json").read_text(), parse_constant=refuse)
        b = o["budget"]
        assert abs(b["after"] / b["historical"] - 1.1) < 1e-3 and abs(b["before"] - b["after"]) < 1, b
        assert o["model_run_id"] == r["mlflow"]["run_id"] and (project / o["report"]).exists()
        assert set(ev[-1]["summary"]["roi"]) == {"before", "after"}, ev[-1]  # the tree shows ROI before → after
        assert [c["name"] for c in o["channels"]] == ["ch0", "ch1", "ch2", "ch3"]
        (project / "scenarios/bad.yaml").write_text("model: tiny\nbudget: lots\n")
        code, ev = run("optimize", str(project), "scenarios/bad.yaml")
        assert code == 1 and "+10%" in ev[-1]["message"], ev
    print("ok")


if __name__ == "__main__":
    main()
