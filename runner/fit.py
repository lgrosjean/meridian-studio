"""Model YAML → Meridian fit → result.json and one MLflow run."""
import dataclasses
import datetime as dt
import inspect
import json
import os
import re
import shutil
import tempfile
import time
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

import review
from loader import Fail, clean, channels_of, frame, input_data
from tracking import cached, experiment, flat, local_path


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


def names_in(data) -> set[str]:
    """The channels, controls and treatments Meridian knows this data by: what a check can name."""
    names = set()
    for coord in ("media_channel", "rf_channel", "organic_media_channel", "organic_rf_channel", "control_variable", "non_media_channel"):
        values = getattr(data, coord, None)
        if values is not None:
            names |= {str(v) for v in np.asarray(values)}
    return names


def variables_of(finding, known: set[str]) -> list[str]:
    """The variables a data check is about, from its artifact (VIF outliers, correlated pairs…) or its text."""
    found = []
    a = finding.associated_artifact
    for v in vars(a).values() if a is not None else []:
        if isinstance(v, str):
            found.append(v)
        elif isinstance(v, pd.DataFrame) and len(v):
            flat = v.reset_index()
            for col in flat.columns:
                if flat[col].dtype == object:
                    found += [str(x) for x in flat[col]]
    found += re.findall(r"[A-Za-z_][\w.-]*", finding.explanation)
    return sorted({x for x in found if x in known})


def window(df: pd.DataFrame, t: str, w: dict | None) -> pd.DataFrame:
    if not w:
        return df
    times = pd.to_datetime(df[t])
    keep = (times >= pd.Timestamp(w.get("start", times.min()))) & (times <= pd.Timestamp(w.get("end", times.max())))
    return df[keep].reset_index(drop=True)


MLFLOW = ("run_name", "description", "tags", "autolog")


def run_options(m: dict) -> dict:
    """The model's `mlflow:` block, all optional: its fits' run name, description and tags, and Meridian's autolog."""
    x = m.get("mlflow") or {}
    if not isinstance(x, dict):
        raise Fail(f"mlflow: takes {', '.join(MLFLOW)}")
    unknown = set(x) - set(MLFLOW)
    if unknown:
        raise Fail(f"mlflow: unknown {', '.join(sorted(unknown))}; accepted: {', '.join(MLFLOW)}")
    tags = x.get("tags") or {}
    if not isinstance(tags, dict):
        raise Fail("mlflow.tags: name: value pairs")
    try:
        run_name = str(x.get("run_name") or "{model}").format(model=m["_file"].stem, dataset=m["dataset"])
    except (KeyError, IndexError, ValueError, AttributeError) as e:
        raise Fail(f"mlflow.run_name: it can name {{model}} and {{dataset}} ({type(e).__name__}: {e})") from e
    description = x.get("description")
    return {
        "run_name": run_name,
        "description": None if description is None else str(description),
        "tags": {str(k): str(v) for k, v in tags.items()},
        "autolog": bool(x.get("autolog", True)),
    }


def inputs(project: Path, m: dict, emit):
    """A model's data and spec, as Meridian takes them: what is wrong in its YAML, its dataset or its CSV fails here."""
    ds_path = f"datasets/{m['dataset']}.yaml"
    d, df, fingerprint = frame(project, ds_path)
    df = window(df, d["coord_to_columns"].get("time", "time"), m.get("window"))

    emit(event="phase", name="data", state="run")
    data = input_data(df, d)
    return ds_path, d, df, fingerprint, data, model_spec(m, data)


def build(data, ms, emit):
    """Meridian on the data, and its data checks (its EDA), before any sampling.
    Meridian is None when it refuses the data outright; the checks then say why."""
    from meridian.model import model

    known = names_in(data)
    try:
        mmm = model.Meridian(data, ms)
    except ValueError as e:  # Meridian refuses some data outright, e.g. a control that never varies
        named = [v for v in re.findall(r"'([^']+)'", str(e)) if v in known]
        if not named:
            raise
        return None, [{"status": "fail", "code": "DATA", "title": "Data", "text": str(e), "vars": named}]
    emit(event="phase", name="data", state="done")

    eda = mmm.eda_outcomes
    items = [
        {
            "status": f.severity.name.lower(),
            "code": o.check_type.name,
            "title": o.check_type.name.replace("_", " ").capitalize(),
            "text": f.explanation,
            "vars": variables_of(f, known),
        }
        for o in (getattr(eda, x.name) for x in dataclasses.fields(eda))
        for f in o.findings
    ]
    return mmm, items


def eda(project: Path, path: str, emit) -> dict:
    """Meridian's data checks for a model, what a fit would find before sampling: in seconds, without fitting."""
    *_, data, ms = inputs(project, read_model(project, path), emit)
    _, items = build(data, ms, emit)
    emit(event="checks", items=items)
    count = lambda status: sum(i["status"] == status for i in items)  # noqa: E731
    return {"errors": count("fail"), "warnings": count("review"), "infos": count("info")}


def fit(project: Path, path: str, emit) -> dict:
    from meridian.model import model  # noqa: F401  imported before the clock starts, as before: fit time is Meridian's own
    import mlflow

    m = read_model(project, path)
    name = m["_file"].stem
    options = run_options(m)
    experiment(project)
    if options.pop("autolog"):
        from meridian.mlflow import autolog

        autolog.autolog()  # Meridian's own: its version, the ModelSpec and priors as it resolved them, sampling's arguments

    t0 = time.time()
    ds_path, d, df, fingerprint, data, ms = inputs(project, m, emit)
    # The run opens once the YAML and the CSV hold, before Meridian: Meridian logs into it as it builds and samples,
    # and a fit that fails from there shows in MLflow as FAILED.
    with mlflow.start_run(**options) as run:
        with warnings.catch_warnings():  # MLflow's hints on reading a path as a source, and on integer columns
            warnings.simplefilter("ignore")
            source = mlflow.data.from_pandas(df, source=d["_csv"].resolve().as_uri(), name=m["dataset"], targets=d["coord_to_columns"].get("kpi"))
        mlflow.log_input(source, context="training")  # the rows fitted: the window's, as read from the CSV
        mmm, items = build(data, ms, emit)
        emit(event="checks", items=items)
        if mmm is None:
            raise Fail(f"Meridian refuses the data: {', '.join(items[0]['vars'])} (see Problems)")
        if any(i["status"] == "fail" for i in items):
            raise Fail("Meridian's data checks failed (see Problems)")
        channels = channels_of(d)

        from meridian.analysis import analyzer, summarizer
        from meridian.schema.serde import meridian_serde

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

        emit(event="phase", name="review", state="run")
        health, reviewed = review.safely(mmm)  # Meridian's health checks on the fit; its checks that did not pass to Problems
        if review.items(reviewed):
            emit(event="checks", items=review.items(reviewed))
        if "health_score" in reviewed:
            fit_block["health_score"] = reviewed["health_score"]
        emit(event="phase", name="review", state="done")

        emit(event="phase", name="outputs", state="run")
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            mlflow.set_tags({
                "studio.kind": "fit", "studio.project": str(project.resolve()), "studio.model": path, "studio.dataset": ds_path,
                "studio.dataset_fingerprint": fingerprint,
            } | review.tags(reviewed))
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
            if health is not None:
                health.output_model_health_card("health.html", str(tmp))  # the review as Meridian lays it out
            df.to_parquet(tmp / "dataset.parquet")
            (tmp / "model.yaml").write_text(m["_file"].read_text())
            (tmp / "dataset.yaml").write_text(d["_file"].read_text())
            mlflow.log_artifacts(str(tmp))
            # ponytail: no Mmm proto with analyses; create_mmm_proto needs processor specs. model.binpb is the reloadable kernel.
            uri = mlflow.get_artifact_uri()
            artifacts = local_path(uri)
            if artifacts is None:  # in another store: a copy here of what the optimizer and the report read
                artifacts = cached(project, run.info.run_id)
                artifacts.mkdir(parents=True, exist_ok=True)
                for f in ("model.binpb", "summary.html", "health.html"):
                    if (tmp / f).exists():
                        shutil.copy2(tmp / f, artifacts / f)
            rel = os.path.relpath(artifacts, project.resolve())
            result = {
                "mlflow": {
                    "run_id": run.info.run_id, "experiment_id": run.info.experiment_id, "artifact_uri": uri,
                    "artifacts": rel, "report": f"{rel}/summary.html",
                    **({"health": f"{rel}/health.html"} if health is not None else {}),
                },
                "fit": fit_block,
                "review": reviewed,
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
