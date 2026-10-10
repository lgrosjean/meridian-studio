"""Dataset YAML → Meridian InputData. The YAML holds CsvDataLoader's arguments, with `csv` for csv_path."""
import hashlib
import math
from pathlib import Path

import pandas as pd
import yaml


class Fail(Exception):
    """A failure the person can read and fix; the runner exits 1 with it."""


# CsvDataLoader's arguments besides csv_path: the YAML may hold these and nothing else (plus name).
ARGS = {
    "coord_to_columns", "kpi_type", "media_to_channel", "media_spend_to_channel", "reach_to_channel",
    "frequency_to_channel", "rf_spend_to_channel", "organic_reach_to_channel", "organic_frequency_to_channel",
    "currency_code",
}


def clean(v):
    """NaN and infinities are not JSON (a 1-chain fit has no r-hat): they go out as null."""
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, dict):
        return {k: clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [clean(x) for x in v]
    return v


def sha(text: str | bytes) -> str:
    return hashlib.sha256(text.encode() if isinstance(text, str) else text).hexdigest()


def read_dataset(project: Path, path: str) -> dict:
    file = project / path
    if not file.exists():
        raise Fail(f"{path} does not exist")
    try:
        d = yaml.safe_load(file.read_text()) or {}
    except yaml.YAMLError as e:
        raise Fail(f"{path} is not valid YAML: {e}")
    unknown = set(d) - ARGS - {"name", "csv", "checks"}  # checks: the data checks' settings (checks.py)
    if unknown:
        raise Fail(f"{path}: unknown {', '.join(sorted(unknown))}; accepted: csv, checks, {', '.join(sorted(ARGS))}")
    for k in ("csv", "coord_to_columns", "kpi_type"):
        if not d.get(k):
            raise Fail(f"{path}: {k} is required")
    if d["kpi_type"] not in ("revenue", "non_revenue"):
        raise Fail(f"{path}: kpi_type is revenue or non_revenue")
    d["_file"], d["_csv"] = file, project / d["csv"]  # an absolute csv path stays absolute
    if not d["_csv"].exists():
        raise Fail(f"{path}: {d['csv']} does not exist")
    return d


def channels_of(d: dict) -> list[str]:
    """The paid channels, in the order Meridian sees them: impression channels, then reach & frequency."""
    names = list((d.get("media_to_channel") or {}).values()) + list((d.get("reach_to_channel") or {}).values())
    return list(dict.fromkeys(names))


def frame(project: Path, path: str) -> tuple[dict, pd.DataFrame, str]:
    """The dataset, its CSV as read, and what a fit on it depends on (the YAML and the CSV's bytes)."""
    d = read_dataset(project, path)
    raw = d["_csv"].read_bytes()
    return d, pd.read_csv(d["_csv"]), "sha256:" + sha(d["_file"].read_bytes() + raw)


def input_data(df: pd.DataFrame, d: dict):
    from meridian.data import load

    cols = d["coord_to_columns"]
    unknown = set(cols) - set(load.CoordToColumns.__dataclass_fields__)
    if unknown:
        raise Fail(f"coord_to_columns: unknown {', '.join(sorted(unknown))}")
    missing = [c for v in cols.values() for c in ([v] if isinstance(v, str) else v or []) if c not in df.columns]
    if missing:
        raise Fail(f"Not in {d['csv']}: {', '.join(missing)}")
    try:
        return load.DataFrameDataLoader(
            df=df, coord_to_columns=load.CoordToColumns(**cols), **{k: d[k] for k in ARGS - {"coord_to_columns"} if k in d}
        ).load()
    except (ValueError, KeyError) as e:
        raise Fail(f"Meridian refuses {d['_file'].name}: {e}")
