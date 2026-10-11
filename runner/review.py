"""Meridian's review of a fit: its model health checks, run once the posterior is sampled (`Meridian.review()`).

Convergence first; when the chains converged, the baseline, the Bayesian p-value, the goodness of fit, the shift from
prior to posterior, ROI consistency with the priors, and, with a revenue per KPI, implausible ROI, high-variance ROI and
potential bias. Each check passes, asks for a review, or fails; together they make a health score out of 100.

What it found goes three ways: result.json's `review` block (every check, for the results panel), the checks that did
not pass as Problems (on the lines naming their channels), and MLflow (the score, a tag per check, the health card)."""
import re
import traceback

STATUS = {"PASS": "pass", "REVIEW": "review", "FAIL": "fail"}


def code_of(result) -> str:
    """A check's code, from its result's class: ConvergenceCheckResult → CONVERGENCE, BayesianPPPCheckResult → BAYESIAN_PPP."""
    name = type(result).__name__.removesuffix("CheckResult")
    return re.sub(r"(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", "_", name).upper()


def review(mmm):
    """Meridian's ReviewSummary of a fitted model, and its `review` block: overall status, Meridian's summary, the
    health score, and each check with its status, what Meridian says, and the channels that did not pass."""
    summary = mmm.review()
    from meridian.analysis.review import constants

    checks = []
    for r in summary.results:
        channels = [c.channel_name for c in getattr(r, "channel_results", None) or [] if c.case.status.name != "PASS"]
        checks.append({
            "code": code_of(r),
            "title": constants.CHECK_RESULT_NAME_MAP.get(type(r).__name__, code_of(r).replace("_", " ").capitalize()),
            "status": STATUS[r.case.status.name],
            "text": r.recommendation,
            "channels": channels,
        })
    block = {
        "status": STATUS[summary.overall_status.name],
        "summary": summary.summary_message,
        "health_score": round(float(summary.health_score), 1),
        "checks": checks,
    }
    return summary, block


def safely(mmm):
    """The review, or why it is missing: a review that breaks costs nothing of the fit, which stands without it."""
    try:
        return review(mmm)
    except Exception as e:  # Meridian's, on a model it did not foresee: the trace to the output, the fit goes on
        traceback.print_exc()
        return None, {"error": f"{type(e).__name__}: {e}"}


def items(block: dict) -> list[dict]:
    """The checks that did not pass, as the extension places them in Problems: on the lines naming their channels,
    on the model's first line when a check is about the whole model."""
    return [
        {"status": c["status"], "code": c["code"], "title": c["title"], "text": c["text"], "vars": c["channels"]}
        for c in block.get("checks", []) if c["status"] != "pass"
    ]


def tags(block: dict) -> dict:
    """MLflow tags: the overall status, and each check's (`review.convergence: pass`), to search runs by them."""
    if "status" not in block:
        return {}
    return {"review.status": block["status"]} | {f"review.{c['code'].lower()}": c["status"] for c in block["checks"]}
