"""Where fits and scenarios are logged: the MLflow store, the project's experiment in it, and where its files go.

MLflow keeps the two apart: the tracking URI is the store of runs (params, metrics, tags), the artifact location the
store of their files, set per experiment when MLflow creates it."""
import os
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import url2pathname

TRACKING = "MLFLOW_TRACKING_URI"  # the extension's meridian.mlflowTrackingUri, or the environment's
ARTIFACTS = "MERIDIAN_MLFLOW_ARTIFACT_LOCATION"  # its meridian.mlflowArtifactLocation


def gitignore(project: Path):
    file = project / ".gitignore"
    lines = file.read_text().splitlines() if file.exists() else []
    missing = [l for l in ("mlruns/", "mlflow.db") if l not in lines]
    if missing:
        file.write_text("\n".join(lines + missing) + "\n")


def experiment(project: Path):
    """The project's experiment, named after its folder, in the store MLFLOW_TRACKING_URI names, else mlflow.db in the
    project. A new experiment keeps its files where MERIDIAN_MLFLOW_ARTIFACT_LOCATION says; else, in the project's
    store, in mlruns/; else wherever the store keeps them (a tracking server, its own artifact store)."""
    import mlflow

    gitignore(project)
    local = not os.environ.get(TRACKING)
    if local:
        mlflow.set_tracking_uri(f"sqlite:///{project / 'mlflow.db'}")
    name = project.resolve().name
    if mlflow.get_experiment_by_name(name) is None:
        where = os.environ.get(ARTIFACTS) or ((project / "mlruns").resolve().as_uri() if local else None)
        mlflow.create_experiment(name, artifact_location=where)
    return mlflow.set_experiment(name)


def flat(d: dict, prefix: str = "") -> dict:
    """Params and metrics as MLflow takes them: nested keys joined by dots."""
    out = {}
    for k, v in d.items():
        if isinstance(v, dict):
            out |= flat(v, f"{prefix}{k}.")
        else:
            out[f"{prefix}{k}"] = v
    return out


def local_path(uri: str) -> Path | None:
    """The folder of a run's files when they are on this machine; None in another store (a server's, a bucket)."""
    u = urlparse(uri)
    if u.scheme == "file":
        return Path(url2pathname(u.path))
    return Path(uri) if len(u.scheme) <= 1 else None  # a path, C:\… included


def cached(project: Path, run_id: str) -> Path:
    """Where the project keeps its own copy of a run's model and report when MLflow keeps them elsewhere."""
    return project / "mlruns" / run_id / "artifacts"
