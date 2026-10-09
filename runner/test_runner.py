"""Self-check: fit the synthetic example tiny, optimize on it; assert on the protocol and the files.
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


def main():
    with tempfile.TemporaryDirectory() as tmp:
        project = Path(tmp) / "project"
        shutil.copytree(HERE.parent / "examples", project, ignore=shutil.ignore_patterns("mlruns", "mlflow.db", "*.result.json", "*.run.json", "*.runs.jsonl", "*.html"))
        ds = "datasets/synthetic.yaml"

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
            "dataset: synthetic\nmodel_spec: { max_lag: 4 }\npriors: { roi: { ch1: { mean: 2, sd: 1 } }, adstock: { ch0: { loc: 0.6, scale: 0.2, low: 0.4, high: 0.85 } } }\n"
            "sampling: { n_prior: 50, n_chains: [1], n_adapt: 50, n_burnin: 0, n_keep: 50, seed: 1 }\n"
        )
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
        assert runs[0]["config"]["priors"]["roi"]["ch1"] == {"mean": 2, "sd": 1} and runs[0]["at"].endswith("+00:00"), runs[0]

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
