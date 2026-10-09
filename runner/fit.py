"""Model YAML → Meridian fit → result.json and one MLflow run."""
import dataclasses
import datetime as dt
import inspect
import json
import os
import tempfile
import time
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

from loader import Fail, clean, channels_of, frame, input_data


def read_model(project: Path, path: str) -> dict:
    file = project / path
    if not file.exists():
        raise Fail(f"{path} does not exist")
    m = yaml.safe_load(file.read_text()) or {}
    if not m.get("dataset"):
        raise Fail("dataset: names the dataset to fit (datasets/<name>.yaml)")
    m["_file"] = file
    return m


def model_spec(m: dict, data):
    from meridian.model import spec

    from priors import prior_distribution

    kw = dict(m.get("model_spec") or {})
    accepted = set(inspect.signature(spec.ModelSpec).parameters) - {"prior"}
    unknown = set(kw) - accepted
    if unknown:
        raise Fail(f"model_spec: unknown {', '.join(sorted(unknown))}; accepted: {', '.join(sorted(accepted))}")
    if kw.get("holdout") is not None:
        raise Fail("model_spec.holdout is not supported yet; leave it null")  # ponytail: HoldoutSpec translation when asked
    prior = prior_distribution(m.get("priors"), data)
    if prior is not None:
        kw["prior"] = prior
    return spec.ModelSpec(**kw)


def window(df: pd.DataFrame, t: str, w: dict | None) -> pd.DataFrame:
    if not w:
        return df
    times = pd.to_datetime(df[t])
    keep = (times >= pd.Timestamp(w.get("start", times.min()))) & (times <= pd.Timestamp(w.get("end", times.max())))
    return df[keep].reset_index(drop=True)


def gitignore(project: Path):
    file = project / ".gitignore"
    lines = file.read_text().splitlines() if file.exists() else []
    missing = [l for l in ("mlruns/", "mlflow.db") if l not in lines]
    if missing:
        file.write_text("\n".join(lines + missing) + "\n")


def flat(d: dict, prefix: str = "") -> dict:
    out = {}
    for k, v in d.items():
        if isinstance(v, dict):
            out |= flat(v, f"{prefix}{k}.")
        else:
            out[f"{prefix}{k}"] = v
    return out


def fit(project: Path, path: str, emit) -> dict:
    m = read_model(project, path)
    ds_path = f"datasets/{m['dataset']}.yaml"
    d, df, fingerprint = frame(project, ds_path)
    df = window(df, d["coord_to_columns"].get("time", "time"), m.get("window"))
    channels = channels_of(d)

    from meridian.analysis import analyzer, summarizer
    from meridian.model import model
    from meridian.schema.serde import meridian_serde

    t0 = time.time()
    emit(event="phase", name="data", state="run")
    data = input_data(df, d)
    mmm = model.Meridian(data, model_spec(m, data))
    emit(event="phase", name="data", state="done")

    eda = mmm.eda_outcomes
    items = [
        {"status": f.severity.name.lower(), "title": o.check_type.name.replace("_", " ").capitalize(), "text": f.explanation}
        for o in (getattr(eda, x.name) for x in dataclasses.fields(eda))
        for f in o.findings
    ]
    emit(event="checks", items=items)
    if any(i["status"] == "fail" for i in items):
        raise Fail("Meridian's data checks failed (see Problems)")

    s = dict(m.get("sampling") or {})
    n_prior = s.pop("n_prior", 500)
    emit(event="phase", name="prior", state="run")
    mmm.sample_prior(n_prior, seed=s.get("seed"))
    emit(event="phase", name="prior", state="done")
    batches = s.get("n_chains", [2, 2])
    # ponytail: one phase for all batches; per-batch events need a sample_posterior call per batch and a merge.
    emit(event="phase", name="posterior", state="run", of=len(batches) if isinstance(batches, list) else 1)
    mmm.sample_posterior(
        n_chains=batches, n_adapt=s.get("n_adapt", 1000), n_burnin=s.get("n_burnin", 0),
        n_keep=s.get("n_keep", 1000), seed=s.get("seed"),
    )
    emit(event="phase", name="posterior", state="done")

    emit(event="phase", name="analysis", state="run")
    a = analyzer.Analyzer(mmm)
    rhat = max(float(np.nanmax(np.asarray(v))) for v in a.get_rhat().values())
    acc = a.predictive_accuracy()["value"].sel(geo_granularity="national").to_series()  # geo models also give "geo"
    sm = a.summary_metrics().sel(distribution="posterior")
    fit_block = {
        "r_hat_max": round(rhat, 4),
        "divergences": int(mmm.inference_data.sample_stats["diverging"].sum()),
        "r2": round(float(acc["R_Squared"]), 4),
        "mape": round(float(acc["MAPE"]), 4),
        "wmape": round(float(acc["wMAPE"]), 4),
        "seconds": round(time.time() - t0),
    }
    rows = [
        {
            "name": ch,
            "roi": float(sm.roi.sel(channel=ch, metric="mean")),
            "roi_lo": float(sm.roi.sel(channel=ch, metric="ci_lo")),
            "roi_hi": float(sm.roi.sel(channel=ch, metric="ci_hi")),
            "contribution": float(sm.pct_of_contribution.sel(channel=ch, metric="mean")) / 100,
            "spend": float(sm.spend.sel(channel=ch)),
        }
        for ch in channels
    ]
    emit(event="phase", name="analysis", state="done")

    emit(event="phase", name="outputs", state="run")
    import mlflow

    gitignore(project)
    if not os.environ.get("MLFLOW_TRACKING_URI"):
        mlflow.set_tracking_uri(f"sqlite:///{project / 'mlflow.db'}")
    exp = project.resolve().name
    if mlflow.get_experiment_by_name(exp) is None:
        mlflow.create_experiment(exp, artifact_location=(project / "mlruns").resolve().as_uri())
    mlflow.set_experiment(exp)
    name = m["_file"].stem
    with tempfile.TemporaryDirectory() as tmp, mlflow.start_run(run_name=name) as run:
        tmp = Path(tmp)
        mlflow.set_tags({
            "studio.project": str(project.resolve()), "studio.model": path, "studio.dataset": ds_path,
            "studio.dataset_fingerprint": fingerprint, 
        })
        mlflow.log_params(flat({
            "model_spec": m.get("model_spec") or {}, "sampling": m.get("sampling") or {}, "priors": m.get("priors") or {},
        }))
        mlflow.log_metrics(fit_block | {
            f"{k}.{r['name']}": r[k] for r in rows for k in ("roi", "roi_lo", "roi_hi", "contribution")
        })
        meridian_serde.save_meridian(mmm, str(tmp / "model.binpb"))
        sw = m.get("summary_window") or m.get("window") or {}
        summarizer.Summarizer(mmm).output_model_results_summary(
            "summary.html", str(tmp), sw.get("start") and str(sw["start"]), sw.get("end") and str(sw["end"])
        )
        df.to_parquet(tmp / "dataset.parquet")
        (tmp / "model.yaml").write_text(m["_file"].read_text())
        (tmp / "dataset.yaml").write_text(d["_file"].read_text())
        mlflow.log_artifacts(str(tmp))
        # ponytail: no Mmm proto with analyses; create_mmm_proto needs processor specs. model.binpb is the reloadable kernel.
        artifacts = Path(mlflow.get_artifact_uri().removeprefix("file://"))
        rel = os.path.relpath(artifacts, project.resolve())
        result = {
            "mlflow": {"run_id": run.info.run_id, "artifacts": rel, "report": f"{rel}/summary.html"},
            "fit": fit_block,
            "channels": rows,
            "currency": d.get("currency_code"),
            "dataset_fingerprint": fingerprint,
        }
    out = project / "models" / f"{name}.result.json"
    out.write_text(json.dumps(clean(result), indent=2, allow_nan=False) + "\n")
    # The model's history: one line per fit, what it was given and what it found; the tree lists them.
    entry = {"at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
    entry |= {"config": {k: m[k] for k in ("model_spec", "priors", "sampling", "window") if m.get(k)}} | result
    with open(project / "models" / f"{name}.runs.jsonl", "a") as f:
        f.write(json.dumps(clean(entry), allow_nan=False, default=str) + "\n")
    emit(event="phase", name="outputs", state="done")
    return fit_block | {"channels": len(rows), "fingerprint": result["mlflow"]["run_id"]}
