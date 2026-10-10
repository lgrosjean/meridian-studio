"""Studio runner: fit | optimize | check. One JSON object per line on stdout; the extension reads them.

`check` also speaks to people and to CI: `--format text` (path:line:col: CODE [severity] what), `json`, or `github`
(annotations on a pull request); it exits 1 when a check finds an error, or a file cannot be checked. Its data
checks need only pandas and pyyaml; a model's (Meridian's own) need Meridian."""
import argparse
import json
import os
import re
import sys
import threading
import traceback
from pathlib import Path

# The protocol owns stdout. Anything a library prints goes to stderr, shown as is in the Output panel.
_out = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)
os.environ.setdefault("MLFLOW_DISABLE_AGENT_HINT", "1")
_lock = threading.Lock()

sys.path.insert(0, str(Path(__file__).parent))
from loader import Fail, clean  # noqa: E402


def emit(**event):
    with _lock:
        _out.write(json.dumps(clean(event), default=str, allow_nan=False) + "\n")


SEVERITY = {"fail": "error", "review": "warning", "info": "info"}


def check_one(project: Path, path: str, quiet: bool) -> tuple[list[dict], dict | None, str | None]:
    """A file's checks: a dataset's data checks, or a model's (Meridian's, without sampling). Its findings, its summary,
    or why it could not be checked."""
    items: list[dict] = []

    def collect(**e):
        if e.get("event") == "checks":
            items.extend(e["items"])
        elif not quiet:
            emit(**e)  # phases, for the extension

    try:
        if path.startswith("models/"):
            import fit

            try:
                return items, fit.eda(project, path, collect), None
            except ImportError as e:  # the data checks run on pandas alone; Meridian's need it installed
                raise Fail(f"Meridian's checks need Meridian ({e.name} is missing): run them with uv run --project <this runner>")
        import checks

        return items, checks.check(project, path, collect), None
    except Fail as e:
        return items, None, str(e)


def where(project: Path, path: str, item: dict) -> tuple[str, int, int]:
    """Where a finding goes: the line naming its column or variable, in the file checked or else in its dataset."""
    import checks

    text = (project / path).read_text()
    names = item.get("vars") or []
    if path.startswith("datasets/"):
        return path, *checks.position(text, names[0] if names else None)
    dataset = re.search(r"^dataset:\s*['\"]?([^#'\"\s]+)", text, re.M)
    ds_path = f"datasets/{dataset.group(1)}.yaml" if dataset else None
    for file in (path, ds_path):
        if file and (project / file).exists():
            for name in names:
                at = checks.word((project / file).read_text(), name)
                if at:
                    return file, *at
    return path, 1, 1


def report(project: Path, results: list[tuple[str, list[dict], dict | None, str | None]], fmt: str):
    """The findings for people (text), for tools (json) or for GitHub (annotations); notes (info) only in json."""
    rel = lambda path: os.path.relpath(project / path)  # noqa: E731
    rows = []
    for path, items, _, failed in results:
        if failed:
            rows.append({"file": rel(path), "line": 1, "column": 1, "code": "ERROR", "severity": "error", "message": failed})
        for i in items:
            file, line, col = where(project, path, i)
            rows.append({"file": rel(file), "line": line, "column": col, "code": i.get("code") or i["title"], "severity": SEVERITY.get(i["status"], "info"), "message": i["text"]})
    if fmt == "json":
        _out.write(json.dumps(rows, indent=2) + "\n")
        return
    shown = [r for r in rows if r["severity"] != "info"]
    # GitHub's workflow commands: %, CR and LF escaped everywhere, and , and : too in a property
    message = lambda v: str(v).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")  # noqa: E731
    prop = lambda v: message(v).replace(",", "%2C").replace(":", "%3A")  # noqa: E731
    for r in shown:
        if fmt == "github":
            _out.write(f"::{r['severity']} file={prop(r['file'])},line={r['line']},col={r['column']},title={prop(r['code'])}::{message(r['message'])}\n")
        else:
            _out.write(f"{r['file']}:{r['line']}:{r['column']}: {r['code']} [{r['severity']}] {r['message']}\n")
    errors, warnings = (sum(r["severity"] == s for r in shown) for s in ("error", "warning"))
    files = f"{len(results)} file{'s' if len(results) != 1 else ''}"
    plural = lambda n, w: f"{n} {w}{'s' if n != 1 else ''}"  # noqa: E731
    _out.write(f"Found {plural(errors, 'error')} and {plural(warnings, 'warning')} in {files}.\n" if shown else f"All checks passed ({files}).\n")


def check(project: Path, paths: list[str], fmt: str) -> int:
    """Each file's checks (every dataset's when none is named), reported as asked; 1 when one finds an error."""
    paths = paths or sorted(f"datasets/{f.name}" for f in (project / "datasets").glob("*.yaml"))
    results = [(path, *check_one(project, path, quiet=fmt != "events")) for path in paths]
    if fmt == "events":
        for path, items, summary, failed in results:
            if failed:
                emit(event="error", message=failed, file=path)
            else:
                emit(event="checks", items=items, file=path)
        if len(results) == 1 and results[0][2] is not None:
            emit(event="done", summary=results[0][2])
        elif len(results) > 1:
            emit(event="done", summary={"files": len(results), "errors": sum(i["status"] == "fail" for r in results for i in r[1]), "failed": sum(r[3] is not None for r in results)})
    else:
        report(project, results, fmt)
    return 1 if any(failed or any(i["status"] == "fail" for i in items) for _, items, _, failed in results) else 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="runner.py", description="Meridian Studio's runner: fit a model, optimize a scenario, check datasets and models.")
    p.add_argument("command", choices=["fit", "optimize", "check"])
    p.add_argument("project", type=Path, help="the folder holding datasets/, models/ and scenarios/")
    p.add_argument("paths", nargs="*", metavar="path", help="models/<n>.yaml or scenarios/<n>.yaml; for check, datasets/<n>.yaml (data checks) or models/<n>.yaml (Meridian's), every dataset when none")
    p.add_argument("--format", choices=["events", "text", "json", "github"], default="events", help="check's output: events (the extension's), text, json, or github annotations")
    a = p.parse_args(argv)
    try:
        if a.command == "check":
            return check(a.project, a.paths, a.format)
        if len(a.paths) != 1:
            p.error(f"{a.command} takes one path")
        if a.command == "fit":
            import fit

            emit(event="done", summary=fit.fit(a.project, a.paths[0], emit))
        elif a.command == "optimize":
            import optimize

            emit(event="done", summary=optimize.optimize(a.project, a.paths[0], emit))
        return 0
    except Fail as e:
        emit(event="error", message=str(e))
        return 1
    except Exception as e:  # a bug: the trace goes to stderr, a line to the protocol
        traceback.print_exc()
        emit(event="error", message=f"{type(e).__name__}: {e}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
