"""Data checks on a dataset's CSV, by the role each column plays: a linter's rules, each with a code.

A dataset's `checks:` turns rules off (`ignore`) or tunes them (`thresholds`), for the whole dataset or per column
(`columns: { <column>: { ignore: [...] } }`); `# noqa` or `# noqa: CODE` on a YAML line naming a column turns them
off there. pandas reads the CSV as a fit does, so a check sees what Meridian will see. An error is what Meridian
refuses; a warning, what it takes but estimates badly. Each finding names its column: the editor puts it on the
line naming it."""
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator

import numpy as np
import pandas as pd
import yaml

from loader import Fail, frame


@dataclass
class Finding:
    code: str
    text: str
    column: str
    error: bool = True


RULES: dict[str, tuple[str, Callable]] = {}  # code → (what it checks, the rule)
THRESHOLDS = {
    "min_active_share": 0.1,  # M002: a channel active in fewer weeks than this share of them
    "trailing_weeks": 4,  # M003: zero over this many last weeks, after activity
    "min_spend_share": 0.01,  # S001: a channel spending less than this share of all spend
}
PAID_SPEND = ("media_spend", "rf_spend")
CHANNELS = PAID_SPEND + ("organic_media", "organic_reach")  # one column per channel: where a channel's activity is read


def rule(code: str, what: str):
    def register(f):
        RULES[code] = (what, f)
        return f

    return register


class Data:
    """The CSV by role: a column's numbers per date (summed over geos), or per geo."""

    def __init__(self, d: dict, df: pd.DataFrame, thresholds: dict):
        cols = d["coord_to_columns"]
        self.roles = {k: [v] if isinstance(v, str) else list(v or []) for k, v in cols.items()}
        self.time, self.geo = cols.get("time", "time"), cols.get("geo")
        self.df, self.t = df, thresholds
        self.dates = pd.to_datetime(df[self.time], format="%Y-%m-%d", errors="coerce") if self.time in df else None
        # dates Meridian can read: every one written yyyy-mm-dd (else the editor says so, and time rules wait)
        self.dated = self.dates is not None and not self.dates[df[self.time].notna()].isna().any()

    def columns(self, *roles: str) -> list[str]:
        """The numeric columns of these roles, as the CSV has them (a missing or text column is the editor's to flag)."""
        return [c for r in roles for c in self.roles.get(r, []) if c in self.df and pd.api.types.is_numeric_dtype(self.df[c])]

    def weekly(self, c: str) -> pd.Series:
        """The column per date, summed over geos; a date where every geo is empty stays empty."""
        if not self.dated:
            return self.df[c].reset_index(drop=True)
        return self.df.groupby(self.dates)[c].sum(min_count=1).sort_index()

    def by_geo(self) -> Iterator[tuple[str | None, pd.DataFrame]]:
        """Each geo's rows in date order; a national dataset is one geo."""
        df = self.df.assign(_date=self.dates).sort_values("_date") if self.dated else self.df
        if self.geo and self.geo in df:
            yield from df.groupby(self.geo, sort=True)
        else:
            yield None, df


def listed(dates, n: int = 4) -> str:
    out = [str(pd.Timestamp(x).date()) for x in list(dates)[:n]]
    return ", ".join(out) + (", …" if len(dates) > n else "")


def weeks(n: int) -> str:
    return f"{n} week{'s' if n != 1 else ''}"


@rule("T001", "Periods missing between the dates (Meridian wants them regularly spaced)")
def missing_periods(x: Data):
    if not x.dated:
        return
    dates = np.sort(x.dates.dropna().unique())
    days = np.diff(dates).astype("timedelta64[D]").astype(int)
    if len(days) < 2 or set(days) <= set(range(28, 32)):  # monthly: Meridian takes 28 to 31 days
        return
    step = int(pd.Series(days).mode().iloc[0])
    missing = [d + np.timedelta64(k * step, "D") for d, n in zip(dates[:-1], days) if n != step and n % step == 0 for k in range(1, n // step)]
    if missing:
        unit = weeks(len(missing)) if step == 7 else f"{len(missing)} periods of {step} days"
        yield Finding("T001", f"{unit} missing from {x.time}: {listed(missing)}. Meridian wants the dates regularly spaced", x.time)


@rule("T002", "Dates not regularly spaced (a step that is not a multiple of the usual one)")
def irregular_dates(x: Data):
    if not x.dated:
        return
    dates = np.sort(x.dates.dropna().unique())
    days = np.diff(dates).astype("timedelta64[D]").astype(int)
    if len(days) < 2 or set(days) <= set(range(28, 32)):
        return
    step = int(pd.Series(days).mode().iloc[0])
    odd = [(a, n) for a, n in zip(dates[:-1], days) if n % step]
    if odd:
        jumps = ", ".join(f"{pd.Timestamp(a).date()} + {n} days" for a, n in odd[:3]) + (", …" if len(odd) > 3 else "")
        yield Finding("T002", f"{x.time} steps by {step} days but not everywhere: {jumps}. Meridian wants the dates regularly spaced", x.time)


@rule("T003", "Geos with different dates (Meridian wants the same dates in each geo)")
def geo_dates(x: Data):
    if not (x.geo and x.geo in x.df and x.dated):
        return
    per = {g: frozenset(rows["_date"].dropna()) for g, rows in x.by_geo()}
    common = pd.Series(list(per.values())).mode().iloc[0]
    odd = [g for g, s in per.items() if s != common]
    if odd:
        g = odd[0]
        lacks, extra = sorted(common - per[g]), sorted(per[g] - common)
        how = f"{g} lacks {listed(lacks, 2)}" if lacks else f"{g} adds {listed(extra, 2)}"
        yield Finding("T003", f"{len(odd)} geo{'s' if len(odd) > 1 else ''} with dates the others lack or miss ({how}). Meridian wants the same dates in each geo", x.time)


@rule("K001", "KPI cells empty after its first value (Meridian takes empty ones only before the KPI starts)")
def kpi_gaps(x: Data):
    for c in x.columns("kpi"):
        holes = []
        for _, rows in x.by_geo():
            v = rows[c].to_numpy(dtype=float)
            seen = np.flatnonzero(~np.isnan(v))
            if len(seen):
                after = np.isnan(v[seen[0]:])
                when = rows["_date"].to_numpy()[seen[0]:] if x.dated else np.arange(seen[0], len(v))
                holes += list(when[after])
        if holes:
            yield Finding("K001", f"{c} is empty on {len(holes)} row{'s' if len(holes) > 1 else ''} after its first value ({listed(sorted(holes)) if x.dated else 'rows ' + ', '.join(map(str, holes[:4]))}). Meridian takes empty KPI cells only in the first weeks, before the KPI starts", c)


@rule("K002", "Negative KPI or revenue per KPI (Meridian refuses them)")
def negative_kpi(x: Data):
    for c in x.columns("kpi", "revenue_per_kpi"):
        n = int((x.df[c] < 0).sum())
        if n:
            yield Finding("K002", f"{c} is negative in {n} row{'s' if n > 1 else ''} (lowest {x.df[c].min():g}): Meridian refuses negative values here", c)


# Meridian refuses these negative; impressions and organic media it takes as given, though they cannot be negative.
REFUSED_NEGATIVE = {"media_spend", "rf_spend", "reach", "frequency", "organic_reach", "organic_frequency"}


@rule("M001", "Negative impressions, spend, reach or frequency")
def negative_media(x: Data):
    for r in ("media", "media_spend", "reach", "frequency", "rf_spend", "organic_media", "organic_reach", "organic_frequency"):
        for c in x.columns(r):
            n = int((x.df[c] < 0).sum())
            if n:
                why = "Meridian refuses negative values here" if r in REFUSED_NEGATIVE else "it cannot be negative"
                yield Finding("M001", f"{c} is negative in {n} row{'s' if n > 1 else ''} (lowest {x.df[c].min():g}): {why}", c, error=r in REFUSED_NEGATIVE)


@rule("M002", "A channel active in too few weeks to estimate (a paid one never active: Meridian refuses it)")
def rarely_active(x: Data):
    share = float(x.t["min_active_share"])
    for r in CHANNELS:
        for c in x.columns(r):
            w = x.weekly(c).dropna()
            active = int((w > 0).sum())
            if not len(w):
                continue
            if not active:
                paid = r in PAID_SPEND
                yield Finding("M002", f"{c} is never above zero" + (": Meridian refuses a paid channel with no spend (model it as organic media?)" if paid else ""), c, error=paid)
            elif active < share * len(w):
                yield Finding("M002", f"{c} is active {weeks(active)} out of {len(w)} ({active / len(w):.0%}): too few to tell its effect apart", c, error=False)


@rule("M003", "A channel at zero over the last weeks, after activity (data not loaded yet?)")
def stopped(x: Data):
    n = int(x.t["trailing_weeks"])
    for r in CHANNELS:
        for c in x.columns(r):
            w = x.weekly(c).dropna()
            # active before as a channel is (one rarely active is M002's), then nothing
            if len(w) > n and (w.iloc[-n:] == 0).all() and (w.iloc[:-n] > 0).sum() >= x.t["min_active_share"] * len(w):
                since = f" (since {w.index[-n].date()})" if x.dated else ""
                yield Finding("M003", f"{c} is zero over the last {weeks(n)}{since} but active before: data not loaded yet, or a channel that stopped?", c, error=False)


@rule("S001", "A channel with a tiny share of all spend (its ROI will be very uncertain)")
def small_channel(x: Data):
    spend = {c: float(x.df[c].clip(lower=0).sum()) for c in x.columns(*PAID_SPEND)}
    total = sum(spend.values())
    floor = float(x.t["min_spend_share"])
    for c, s in spend.items():
        if total and 0 < s < floor * total:
            yield Finding("S001", f"{c} is {100 * s / total:.2g}% of all spend: its ROI will be very uncertain. Merge it with a similar channel?", c, error=False)


@rule("C001", "A control or treatment that never varies over time (Meridian refuses it)")
def no_variation(x: Data):
    for c in x.columns("controls", "non_media_treatments", "organic_media", "organic_reach"):
        if all(rows[c].dropna().nunique() <= 1 for _, rows in x.by_geo()):
            values = x.df[c].dropna().unique()
            what = f"always {values[0]:g}" if len(values) == 1 else "the same in each geo"
            yield Finding("C001", f"{c} never varies over time ({what}): Meridian refuses it. Drop it, or give it what moves", c)


# --- What the dataset turns off: `checks:`, and `# noqa` on a line naming a column ---------------------------------

CODE = re.compile(r"^[A-Z]\d{3}$")
NOQA = re.compile(r"\bnoqa\b(?::\s*([A-Za-z]\d{3}(?:\s*,\s*[A-Za-z]\d{3})*))?", re.I)


def config(d: dict) -> tuple[set[str], dict[str, set[str]], dict]:
    """What a dataset's `checks:` says: the codes off, the codes off per column, the thresholds."""
    c = d.get("checks") or {}
    if not isinstance(c, dict):
        raise Fail("checks: ignore, thresholds or columns")
    unknown = set(c) - {"ignore", "thresholds", "columns"}
    if unknown:
        raise Fail(f"checks: unknown {', '.join(sorted(unknown))}; accepted: ignore, thresholds, columns")

    def codes(v, where: str) -> set[str]:
        got = {str(x).upper() for x in (v or [])}
        bad = sorted(x for x in got if x not in RULES)
        if bad:
            raise Fail(f"{where}: no check {', '.join(bad)}; the checks are {', '.join(RULES)}")
        return got

    t = dict(c.get("thresholds") or {})
    if set(t) - set(THRESHOLDS):
        raise Fail(f"checks.thresholds: unknown {', '.join(sorted(set(t) - set(THRESHOLDS)))}; accepted: {', '.join(THRESHOLDS)}")
    if any(not isinstance(v, (int, float)) or isinstance(v, bool) or v < 0 for v in t.values()):
        raise Fail("checks.thresholds: positive numbers")
    per = {str(col): codes((v or {}).get("ignore"), f"checks.columns.{col}.ignore") for col, v in (c.get("columns") or {}).items()}
    return codes(c.get("ignore"), "checks.ignore"), per, THRESHOLDS | t


def noqa(text: str, column: str, code: str) -> bool:
    """Whether a line naming the column (outside its comment) says `# noqa` or `# noqa: <code>`."""
    name = re.compile(rf"(?<![\w.-]){re.escape(column)}(?![\w.-])")
    for line in text.splitlines():
        body, hash_, comment = line.partition("#")
        m = NOQA.search(comment) if hash_ and name.search(body) else None
        if m and (not m.group(1) or code in {x.strip().upper() for x in m.group(1).split(",")}):
            return True
    return False


def check(project: Path, path: str, emit) -> dict:
    d, df, _ = frame(project, path)
    off, per_column, thresholds = config(d)
    data = Data(d, df, thresholds)
    text = d["_file"].read_text()
    found = [f for code, (_, run) in RULES.items() if code not in off for f in run(data)]
    kept = [f for f in found if f.code not in per_column.get(f.column, set()) and not noqa(text, f.column, f.code)]
    emit(event="checks", items=[
        {"status": "fail" if f.error else "review", "code": f.code, "title": f.code, "text": f.text, "vars": [f.column]} for f in kept
    ])
    errors = sum(f.error for f in kept)
    return {"errors": errors, "warnings": len(kept) - errors, "silenced": len(found) - len(kept), "rows": len(df)}


def position(text: str, column: str | None) -> tuple[int, int]:
    """Line and column (from 1) where the YAML first names a column, in a role or as a *_to_channel key; else its csv.
    Where the editor puts a finding too."""
    try:
        root = yaml.compose(text)
    except yaml.YAMLError:
        root = None
    marks, csv = [], None
    if isinstance(root, yaml.MappingNode):
        for k, v in root.value:
            if k.value == "coord_to_columns" and isinstance(v, yaml.MappingNode):
                for _, rv in v.value:
                    nodes = rv.value if isinstance(rv, yaml.SequenceNode) else [rv]
                    marks += [n.start_mark for n in nodes if isinstance(n, yaml.ScalarNode) and n.value == column]
            elif str(k.value).endswith("_to_channel") and isinstance(v, yaml.MappingNode):
                marks += [kk.start_mark for kk, _ in v.value if kk.value == column]
            elif k.value == "csv":
                csv = v.start_mark
    m = min(marks, key=lambda x: x.index, default=csv)
    return (m.line + 1, m.column + 1) if m else (1, 1)


def word(text: str, name: str) -> tuple[int, int] | None:
    """Line and column (from 1) of a name in a YAML, outside comments: where a check of Meridian's about it goes."""
    pattern = re.compile(rf"(?<![\w.-]){re.escape(name)}(?![\w.-])")
    for n, line in enumerate(text.splitlines(), 1):
        m = pattern.search(line.split("#", 1)[0])
        if m:
            return n, m.start() + 1
    return None
