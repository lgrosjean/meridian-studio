"""Scenario YAML → Meridian's BudgetOptimizer on a fitted model → result.json and an HTML summary."""
import json
import os
import re
from pathlib import Path

import yaml

from loader import Fail, clean, sha
from tracking import experiment, flat


def read_scenario(project: Path, path: str) -> dict:
    file = project / path
    if not file.exists():
        raise Fail(f"{path} does not exist")
    s = yaml.safe_load(file.read_text()) or {}
    if not s.get("model"):
        raise Fail("model: names the fitted model to optimize (models/<name>.yaml)")
    s["_file"] = file
    return s


def budget_of(given, historical: float) -> float | None:
    """None or 'historical' keeps the window's spend; a number is an amount; '+10%' / '-5%' moves from historical."""
    if given is None or given == "historical":
        return None
    if isinstance(given, (int, float)):
        return float(given)
    m = re.fullmatch(r"\s*([+-]?\d+(?:\.\d+)?)\s*%\s*", str(given))
    if not m:
        raise Fail(f"budget: historical, an amount, or a change like +10% (got {given!r})")
    return historical * (1 + float(m.group(1)) / 100)


def bounds_of(s: dict, channels: list[str]) -> tuple[list[float], list[float]]:
    """How far each channel may move from its historical share, as fractions; Meridian's default is 0.3 both ways."""
    base = s.get("bounds") or {}
    per = s.get("channels") or {}
    unknown = set(per) - set(channels)
    if unknown:
        raise Fail(f"channels: {', '.join(sorted(unknown))} not in the model's channels {channels}")
    lo = [float((per.get(c) or {}).get("lower", base.get("lower", 0.3))) for c in channels]
    hi = [float((per.get(c) or {}).get("upper", base.get("upper", 0.3))) for c in channels]
    return lo, hi


def optimize(project: Path, path: str, emit) -> dict:
    s = read_scenario(project, path)
    model_path = f"models/{s['model']}.yaml"
    result_file = project / "models" / f"{s['model']}.result.json"
    if not (project / model_path).exists():
        raise Fail(f"{model_path} does not exist")
    if not result_file.exists():
        raise Fail(f"Fit {s['model']} first")
    fitted = json.loads(result_file.read_text())
    import mlflow

    experiment(project)
    binpb = project / fitted["mlflow"]["artifacts"] / "model.binpb"
    if not binpb.exists():  # deleted, or fitted on another machine: MLflow may have it (a tracking server's store)
        try:
            mlflow.artifacts.download_artifacts(run_id=fitted["mlflow"]["run_id"], artifact_path="model.binpb", dst_path=str(binpb.parent))
        except Exception as e:  # not in this store, or not reachable: what to do is the same
            raise Fail(f"{os.path.relpath(binpb, project)} is gone, and MLflow cannot give it ({type(e).__name__}): fit {s['model']} again") from e

    from meridian.analysis import optimizer
    from meridian.schema.serde import meridian_serde

    emit(event="phase", name="model", state="run")
    mmm = meridian_serde.load_meridian(str(binpb))
    emit(event="phase", name="model", state="done")
    channels = [str(c) for c in mmm.input_data.media_channel.values]
    w = s.get("window") or {}
    start, end = (str(w["start"]) if w.get("start") else None), (str(w["end"]) if w.get("end") else None)
    spend = mmm.input_data.media_spend.sel(time=slice(start, end))
    historical = float(spend.sum())
    lo, hi = bounds_of(s, channels)
    target = s.get("target") or {}
    unknown = set(target) - {"roi", "mroi"}
    if unknown:
        raise Fail(f"target: roi or mroi, not {', '.join(sorted(unknown))}")

    budget = None if target else budget_of(s.get("budget"), historical)

    from mlflow.exceptions import MlflowException

    # One run per optimization, under its fit's run: MLflow shows it there. Opened once the scenario holds.
    name = s["_file"].stem
    try:
        fit_run = mlflow.get_run(fitted["mlflow"]["run_id"]).info
        parent = fit_run.run_id if fit_run.lifecycle_stage == "active" else None  # not under a deleted run
    except MlflowException:  # the fit was logged to another store
        parent = None
    tags = {"studio.kind": "scenario", "studio.project": str(project.resolve()), "studio.scenario": path, "studio.model": model_path}
    with mlflow.start_run(run_name=name, parent_run_id=parent, tags=tags) as run:
        mlflow.log_params(flat({k: s[k] for k in ("budget", "bounds", "channels", "target", "window") if s.get(k) is not None}))
        emit(event="phase", name="optimize", state="run")
        r = optimizer.BudgetOptimizer(mmm).optimize(
            start_date=start, end_date=end,
            fixed_budget=not target,
            budget=budget,
            spend_constraint_lower=lo, spend_constraint_upper=hi,
            target_roi=target.get("roi"), target_mroi=target.get("mroi"),
        )
        emit(event="phase", name="optimize", state="done")

        emit(event="phase", name="outputs", state="run")
        r.output_optimization_summary(f"{name}.html", str(project / "scenarios"))
        before, after = r.nonoptimized_data, r.optimized_data
        rows = [
            {
                "name": c,
                "spend_before": float(before.spend.sel(channel=c)),
                "spend_after": float(after.spend.sel(channel=c)),
                "roi_before": float(before.roi.sel(channel=c, metric="mean")),
                "roi_after": float(after.roi.sel(channel=c, metric="mean")),
                "outcome_before": float(before.incremental_outcome.sel(channel=c, metric="mean")),
                "outcome_after": float(after.incremental_outcome.sel(channel=c, metric="mean")),
            }
            for c in channels
        ]
        # Meridian's "before" is the historical mix scaled to the scenario's budget: same money, old split.
        totals = {
            "budget": {"historical": historical, "before": float(before.budget), "after": float(after.budget)},
            "outcome": {"before": float(before.total_incremental_outcome), "after": float(after.total_incremental_outcome)},
            "roi": {"before": float(before.total_roi), "after": float(after.total_roi)},
        }
        result = {
            "model": s["model"],
            "model_run_id": fitted["mlflow"]["run_id"],
            "window": {"start": str(after.start_date), "end": str(after.end_date)},
            "report": f"scenarios/{name}.html",
            **totals,
            "channels": rows,
        }
        fingerprint = sha(json.dumps(result, sort_keys=True))  # what it found, whichever run logged it
        result["mlflow"] = {"run_id": run.info.run_id, "experiment_id": run.info.experiment_id}
        mlflow.log_metrics(flat(totals) | {f"{k}.{row['name']}": row[k] for row in rows for k in row if k != "name"})
        mlflow.log_artifact(str(project / "scenarios" / f"{name}.html"))
        mlflow.log_text(s["_file"].read_text(), "scenario.yaml")
        mlflow.log_dict(clean(result), "result.json")
    (project / "scenarios" / f"{name}.result.json").write_text(json.dumps(clean(result), indent=2, allow_nan=False) + "\n")
    emit(event="phase", name="outputs", state="done")
    rounded = {k: {kk: round(vv, 4) for kk, vv in v.items()} for k, v in totals.items()}
    return rounded | {"channels": len(rows), "fingerprint": fingerprint}
