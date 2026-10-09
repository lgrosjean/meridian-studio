"""priors: in a model YAML → Meridian's PriorDistribution.

Each key is a PriorDistribution field (roi_m, alpha_m, ec_m, sigma, …) and takes one TensorFlow Probability
distribution, named by `dist`. Its arguments are given either once, for every channel:

    ec_m: { dist: TruncatedNormal, loc: 0.8, scale: 0.8, low: 0.1, high: 10 }

or per channel (control, non-media treatment…), with `default` for the ones not listed:

    roi_m:
      dist: LogNormal
      default: { mean: 0.2, sd: 0.9 }
      channel_0: { mean: 1.2, sd: 0.6 }

A LogNormal also takes `mean` and `sd` in the distribution's own units (an ROI of 1.2 ± 0.6) instead of
loc/scale. `shift: x` moves the distribution by x (Meridian's ec_rf is a LogNormal shifted by 0.1).
"""
import dataclasses
import inspect
import math

import numpy as np

from loader import Fail

# Which names a field's per-item form takes: the InputData coordinate its batch runs along.
def _axis(field: str) -> str | None:
    if field in ("gamma_c", "xi_c"):
        return "control_variable"
    if field in ("gamma_n", "xi_n", "contribution_n"):
        return "non_media_channel"
    for suffix, axis in (("_orf", "organic_rf_channel"), ("_om", "organic_media_channel"), ("_rf", "rf_channel"), ("_m", "media_channel")):
        if field.endswith(suffix):
            return axis
    return None  # knot_values, tau_g_excl_baseline, sigma: one distribution for all


def _lognormal(spec: dict, where: str) -> dict:
    """mean/sd in the distribution's units → the underlying Normal's loc/scale."""
    if "mean" not in spec and "sd" not in spec:
        return spec
    if set(spec) & {"loc", "scale"} or not {"mean", "sd"} <= set(spec):
        raise Fail(f"{where}: give mean and sd, or loc and scale, not a mix")
    mean, sd = float(spec["mean"]), float(spec["sd"])
    if mean <= 0 or sd <= 0:
        raise Fail(f"{where}: mean and sd must be above 0")
    s2 = math.log(1 + (sd / mean) ** 2)
    return {"loc": math.log(mean) - s2 / 2, "scale": math.sqrt(s2)} | {k: v for k, v in spec.items() if k not in ("mean", "sd")}


def _one(field: str, spec, data):
    from meridian import backend

    where = f"priors.{field}"
    if not isinstance(spec, dict) or not spec.get("dist"):
        raise Fail(f"{where}: a map with dist (a TensorFlow Probability distribution, e.g. LogNormal) and its arguments")
    spec = dict(spec)
    name, shift = spec.pop("dist"), spec.pop("shift", None)
    cls = getattr(backend.tfd, str(name), None)
    if not (isinstance(cls, type) and issubclass(cls, backend.tfd.Distribution)):
        raise Fail(f"{where}: {name} is not a TensorFlow Probability distribution (Normal, LogNormal, HalfNormal, TruncatedNormal, Uniform, Beta, Gamma, …)")
    args = set(inspect.signature(cls).parameters) - {"name", "validate_args", "allow_nan_stats", "force_probs_to_zero_outside_support"}
    if name == "LogNormal":
        args |= {"mean", "sd"}

    if spec and set(spec) <= args:  # one set of arguments for all
        params = _lognormal(spec, where) if name == "LogNormal" else spec
    else:
        axis = _axis(field)
        coord = getattr(data, axis) if axis else None
        items = [str(x) for x in np.asarray(coord)] if coord is not None else []
        if not items:
            unknown = sorted(set(spec) - args)
            raise Fail(f"{where}: {', '.join(unknown)} not arguments of {name} ({', '.join(sorted(args))})"
                       + ("" if axis else "; this prior takes one set of arguments, not one per item"))
        unknown = sorted(set(spec) - set(items) - {"default"})
        if unknown:
            raise Fail(f"{where}: {', '.join(unknown)} not in {items} (nor default)")
        rows = []
        for item in items:
            row = spec.get(item, spec.get("default"))
            if row is None:
                raise Fail(f"{where}: no prior for {item}; add it, or a default")
            if not isinstance(row, dict) or not set(row) <= args:
                raise Fail(f"{where}.{item if item in spec else 'default'}: arguments of {name} ({', '.join(sorted(args))})")
            rows.append(_lognormal(row, f"{where}.{item}") if name == "LogNormal" else row)
        keys = set(rows[0])
        odd = next((i for i, r in zip(items, rows) if set(r) != keys), None)
        if odd:
            raise Fail(f"{where}: {items[0]} has {', '.join(sorted(keys))} but {odd} has {', '.join(sorted(rows[items.index(odd)]))}; "
                       "one distribution takes the same arguments for every item")
        params = {k: [r[k] for r in rows] for k in keys}

    try:
        dist = cls(**{k: np.asarray(v, dtype=np.float64) for k, v in params.items()}, name=field)  # Meridian wants float64
        if shift is not None:
            dist = backend.tfd.TransformedDistribution(dist, backend.bijectors.Shift(np.float64(shift)), name=field)
    except (TypeError, ValueError) as e:
        raise Fail(f"{where}: {name}: {e}")
    return dist


def prior_distribution(priors: dict | None, data):
    """The PriorDistribution for these priors; None when there are none (Meridian's defaults)."""
    from meridian.model import prior_distribution as pd

    if not priors:
        return None
    if not isinstance(priors, dict):
        raise Fail("priors: a map of PriorDistribution fields (roi_m, alpha_m, ec_m, sigma, …)")
    old = {"roi": "roi_m: { dist: LogNormal, <channel>: { mean, sd } }", "adstock": "alpha_m: { dist: TruncatedNormal, <channel>: { loc, scale, low, high } }"}
    for k in set(priors) & set(old):
        raise Fail(f"priors.{k} is now written {old[k]}")
    fields = {f.name for f in dataclasses.fields(pd.PriorDistribution)}
    unknown = sorted(set(priors) - fields)
    if unknown:
        raise Fail(f"priors: {', '.join(unknown)} not a PriorDistribution field; accepted: {', '.join(sorted(fields))}")
    return pd.PriorDistribution(**{k: _one(k, v, data) for k, v in priors.items()})
