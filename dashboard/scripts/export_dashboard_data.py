#!/usr/bin/env python3
"""Export the experiment's cleaned, aggregate dashboard payload.

No user IDs or row-level records are written to the web application.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path


WINDOW_START = datetime.fromisoformat("2026-06-09")
# Mirrors the notebook's exact pandas Timestamp boundary.
WINDOW_END = datetime.fromisoformat("2026-06-15")
Z_95 = 1.959963984540054


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", type=Path, default=Path("../data/edtech_quiz_experiment.csv"))
    parser.add_argument("--out", type=Path, default=Path("src/data/experiment-summary.json"))
    return parser.parse_args()


def normal_cdf(value: float) -> float:
    return 0.5 * (1 + math.erf(value / math.sqrt(2)))


def compare(success_a: int, total_a: int, success_b: int, total_b: int) -> dict:
    rate_a = success_a / total_a
    rate_b = success_b / total_b
    diff = rate_b - rate_a
    pooled = (success_a + success_b) / (total_a + total_b)
    z_se = math.sqrt(pooled * (1 - pooled) * (1 / total_a + 1 / total_b))
    z = diff / z_se
    p = 2 * (1 - normal_cdf(abs(z)))
    ci_se = math.sqrt(rate_a * (1 - rate_a) / total_a + rate_b * (1 - rate_b) / total_b)
    return {
        "control": {"success": success_a, "total": total_a, "rate": rate_a},
        "treatment": {"success": success_b, "total": total_b, "rate": rate_b},
        "difference": diff,
        "z": z,
        "pValue": p,
        "ci95": [diff - Z_95 * ci_se, diff + Z_95 * ci_se],
        "significant": p < 0.05,
    }


def allocate_particles(bins: list[dict], target: int) -> None:
    exact = [item["users"] / 10 for item in bins]
    base = [math.floor(value) for value in exact]
    order = sorted(range(len(bins)), key=lambda idx: exact[idx] - base[idx], reverse=True)
    for idx in order[: target - sum(base)]:
        base[idx] += 1
    for item, particles in zip(bins, base):
        item["particles"] = particles


def main() -> None:
    args = parse_args()
    raw_rows: list[dict[str, str]] = []
    with args.csv.open(newline="", encoding="utf-8") as handle:
        raw_rows.extend(csv.DictReader(handle))

    possible = [row for row in raw_rows if int(row["quizzes_completed"]) <= int(row["quizzes_started"])]
    seen: set[tuple[str, ...]] = set()
    rows: list[dict[str, str]] = []
    for row in possible:
        key = tuple(row.values())
        if key not in seen:
            seen.add(key)
            rows.append(row)

    arms: dict[str, list[dict]] = defaultdict(list)
    joint_bins: Counter[tuple[str, str, bool, bool, bool]] = Counter()
    baseline_fields = ["questions_attempted_total", "bookmarks_count", "lectures_repeated", "sessions_last_28d"]
    baseline_values: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))

    for row in rows:
        variant = row["variant"]
        attempted = int(row["quizzes_started"]) > 0
        completed = int(row["quizzes_completed"]) > 0
        active = row["last_active_at"]
        retained = False
        if active:
            last_active = datetime.fromisoformat(active)
            retained = WINDOW_START <= last_active <= WINDOW_END
        low_history = int(row["questions_attempted_total"]) < 15 and int(row["bookmarks_count"]) < 3
        history = "low" if low_history else "higher"
        derived = {"attempted": attempted, "completed": completed, "retained": retained, "history": history}
        arms[variant].append(derived)
        joint_bins[(variant, history, attempted, completed, retained)] += 1
        for field in baseline_fields:
            value = row[field]
            if value:
                baseline_values[variant][field].append(float(value))

    control = arms["control"]
    treatment = arms["personalized_quiz"]

    def count(items: list[dict], key: str) -> int:
        return sum(bool(item[key]) for item in items)

    attempt = compare(count(control, "attempted"), len(control), count(treatment, "attempted"), len(treatment))
    completion = compare(count(control, "completed"), count(control, "attempted"), count(treatment, "completed"), count(treatment, "attempted"))
    overall_completion = compare(count(control, "completed"), len(control), count(treatment, "completed"), len(treatment))
    retention = compare(count(control, "retained"), len(control), count(treatment, "retained"), len(treatment))

    segments = {}
    for history in ("low", "higher"):
        c = [item for item in control if item["history"] == history]
        t = [item for item in treatment if item["history"] == history]
        segments[history] = {
            "users": len(c) + len(t),
            "attempt": compare(count(c, "attempted"), len(c), count(t, "attempted"), len(t)),
            "completion": compare(count(c, "completed"), count(c, "attempted"), count(t, "completed"), count(t, "attempted")),
        }

    particle_bins: list[dict] = []
    for key, users in sorted(joint_bins.items()):
        variant, history, attempted, completed, retained = key
        particle_bins.append({
            "variant": variant,
            "history": history,
            "attempted": attempted,
            "completed": completed,
            "retained": retained,
            "users": users,
        })
    for variant, target in (("control", round(len(control) / 10)), ("personalized_quiz", round(len(treatment) / 10))):
        allocate_particles([item for item in particle_bins if item["variant"] == variant], target)

    baseline = []
    for field in baseline_fields:
        c_vals = baseline_values["control"][field]
        t_vals = baseline_values["personalized_quiz"][field]
        c_mean = sum(c_vals) / len(c_vals)
        t_mean = sum(t_vals) / len(t_vals)
        c_var = sum((value - c_mean) ** 2 for value in c_vals) / (len(c_vals) - 1)
        t_var = sum((value - t_mean) ** 2 for value in t_vals) / (len(t_vals) - 1)
        pooled_sd = math.sqrt((c_var + t_var) / 2)
        baseline.append({"metric": field, "control": c_mean, "treatment": t_mean, "standardizedDifference": (t_mean - c_mean) / pooled_sd})

    split_diff = len(treatment) - len(control)
    chi_square = (split_diff * split_diff) / len(rows)
    srm_p = math.erfc(math.sqrt(chi_square / 2))

    payload = {
        "experiment": {
            "title": "Personalized AI Quizzes",
            "window": "June 9 to 15, 2026",
            "rawRows": len(raw_rows),
            "cleanUsers": len(rows),
            "removedImpossible": len(raw_rows) - len(possible),
            "removedDuplicates": len(possible) - len(rows),
            "particleScale": 10,
        },
        "arms": {
            "control": {"label": "Standard quiz", "users": len(control)},
            "personalized_quiz": {"label": "Personalized AI quiz", "users": len(treatment)},
        },
        "metrics": {
            "attempt": attempt,
            "completion": completion,
            "overallCompletion": overall_completion,
            "retention": retention,
        },
        "segments": segments,
        "validity": {
            "sampleRatio": {"chiSquare": chi_square, "pValue": srm_p, "alertThreshold": 0.001, "passed": srm_p >= 0.001},
            "baselineBalance": baseline,
            "power": {"targetLift": 0.02, "requiredPerArm": 9351, "actualMde": 0.0108, "power": 0.8, "alpha": 0.05},
        },
        "particleBins": particle_bins,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Exported {len(rows):,} cleaned users into {sum(item['particles'] for item in particle_bins):,} aggregate particles")


if __name__ == "__main__":
    main()
