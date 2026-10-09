"""Writes the `priors` part of schemas/model.schema.json from the installed Meridian's PriorDistribution:
its fields, what each is, its default. Run after a Meridian upgrade:
    uv run --project runner scripts/gen_priors_schema.py"""
import dataclasses
import inspect
import json
import re
from pathlib import Path

from meridian.model import prior_distribution as pd

SCHEMA = Path(__file__).parent.parent / "schemas" / "model.schema.json"
# The families most priors use, and their arguments: completion for these, any other TFP name is accepted too.
FAMILIES = {
    "LogNormal": "loc, scale (of the log), or mean, sd (in the distribution's units)",
    "Normal": "loc, scale",
    "HalfNormal": "scale",
    "TruncatedNormal": "loc, scale, low, high",
    "Uniform": "low, high",
    "Beta": "concentration1, concentration0",
    "Gamma": "concentration, rate",
    "StudentT": "df, loc, scale",
    "HalfCauchy": "loc, scale",
    "Exponential": "rate",
    "Deterministic": "loc",
}
ARGS = {
    "loc": "location (Normal, TruncatedNormal, StudentT, HalfCauchy, Deterministic; LogNormal: of the log)",
    "scale": "scale (Normal, HalfNormal, TruncatedNormal, StudentT, HalfCauchy; LogNormal: of the log)",
    "mean": "LogNormal only: the mean, in the distribution's units (an ROI of 1.2)",
    "sd": "LogNormal only: the standard deviation, in the distribution's units",
    "low": "lower bound (Uniform, TruncatedNormal)",
    "high": "upper bound (Uniform, TruncatedNormal)",
    "concentration1": "Beta's alpha",
    "concentration0": "Beta's beta",
    "concentration": "Gamma's shape",
    "rate": "rate (Gamma, Exponential)",
    "df": "StudentT's degrees of freedom",
}
AXIS = {"_orf": "organic reach & frequency channel", "_om": "organic media channel", "_rf": "reach & frequency channel", "_m": "media channel"}


def axis(field):
    if field in ("gamma_c", "xi_c"):
        return "control"
    if field in ("gamma_n", "xi_n", "contribution_n"):
        return "non-media treatment"
    return next((v for k, v in AXIS.items() if field.endswith(k)), None)


doc = inspect.getdoc(pd.PriorDistribution)
args = {"type": "object", "additionalProperties": {"type": "number"},
        "properties": {k: {"type": "number", "description": v} for k, v in ARGS.items()}}
props = {}
for f in dataclasses.fields(pd.PriorDistribution):
    m = re.search(r"\n  %s: (.*?)(?=\n  \w+: |\Z)" % f.name, doc, re.S)
    text = re.sub(r"\s+", " ", m.group(1)).strip() if m else ""
    per = axis(f.name)
    how = f"Arguments once for every {per}, or per {per} by name with a `default`." if per else "One set of arguments."
    props[f.name] = {
        "type": "object",
        "required": ["dist"],
        "markdownDescription": f"{text}\n\n{how}",
        "properties": {
            "dist": {"anyOf": [{"enum": list(FAMILIES)}, {"type": "string"}],
                     "markdownDescription": "A TensorFlow Probability distribution. "
                     + "; ".join(f"`{k}`: {v}" for k, v in FAMILIES.items())},
            "shift": {"type": "number", "description": "Moves the distribution by this much (Meridian's ec_rf: LogNormal shifted by 0.1)."},
            **({"default": {"$ref": "#/definitions/priorArgs", "description": f"For every {per} not listed."}} if per else {}),
            **{k: v for k, v in args["properties"].items()},
        },
        # a channel (control…) name → its arguments, or another argument of an exotic distribution
        "additionalProperties": {"anyOf": [{"$ref": "#/definitions/priorArgs"}, {"type": "number"}]} if per else {"type": "number"},
    }
schema = json.loads(SCHEMA.read_text())
schema["properties"]["priors"] = {
    "type": "object",
    "additionalProperties": False,
    "markdownDescription": "Meridian's PriorDistribution: one TensorFlow Probability distribution per field. "
    "Fields not set keep Meridian's default. Which of roi_m, mroi_m, contribution_m, beta_m is used depends on "
    "model_spec.media_prior_type (roi by default).",
    "properties": props,
}
schema.setdefault("definitions", {})["priorArgs"] = args
SCHEMA.write_text(json.dumps(schema, indent=2, ensure_ascii=False) + "\n")
print(f"{len(props)} priors written to {SCHEMA.name}")
