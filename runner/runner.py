"""Studio runner: fit | optimize | check. One JSON object per line on stdout; the extension reads them."""
import argparse
import json
import os
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


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="runner.py")
    p.add_argument("command", choices=["fit", "optimize", "check"])
    p.add_argument("project", type=Path)
    p.add_argument("path", help="models/<n>.yaml, scenarios/<n>.yaml or (check) datasets/<n>.yaml, relative to the project")
    a = p.parse_args(argv)
    try:
        if a.command == "fit":
            import fit

            emit(event="done", summary=fit.fit(a.project, a.path, emit))
        elif a.command == "optimize":
            import optimize

            emit(event="done", summary=optimize.optimize(a.project, a.path, emit))
        elif a.command == "check":
            import checks

            emit(event="done", summary=checks.check(a.project, a.path, emit))
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
