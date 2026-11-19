"""Shared helpers for the wforge hooks and bin scripts. Standard library only.

State lives under <config dir>/wforge/ (default ~/.claude/wforge/):
  usage.json      latest rate-limit snapshot, written by bin/wforge-statusline
  lockout.json    set by hooks/lockout.py when the API answered rate_limit
  sessions/<id>   rolling count of subagent launches, written by hooks/guard.py
"""
import json
import os
import sys
import time
from datetime import datetime

STALE_AFTER = 6 * 3600          # a snapshot older than this is treated as unknown
WINDOW_10M = 600                # rolling window for the subagent launch counter

MODEL_TIER = {
    # alias or id prefix -> tier rank (higher = more expensive)
    "haiku": 1,
    "sonnet": 2,
    "opus": 3,
    "fable": 4,
    "mythos": 4,
}


def config_dir():
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")


def state_dir():
    d = os.path.join(config_dir(), "wforge")
    os.makedirs(os.path.join(d, "sessions"), exist_ok=True)
    return d


def usage_path():
    return os.path.join(state_dir(), "usage.json")


def lockout_path():
    return os.path.join(state_dir(), "lockout.json")


def read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def option(name, default):
    """A plugin userConfig value, exported to hooks as CLAUDE_PLUGIN_OPTION_<NAME>."""
    raw = os.environ.get("CLAUDE_PLUGIN_OPTION_" + name.upper())
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def thresholds():
    return {
        "soft": option("soft_threshold", 60),
        "hard": option("hard_threshold", 85),
        "weekly": option("weekly_hard", 90),
        "max_agents": int(option("max_agents", 8)),
    }


def fmt_reset(epoch):
    if not epoch:
        return "?"
    try:
        return datetime.fromtimestamp(int(epoch)).strftime("%-I:%M%p").lower()
    except (ValueError, OverflowError, OSError):
        return "?"


def snapshot():
    """Current usage picture: window percentages, staleness, lockout.

    Returns a dict with keys: known (bool), five, seven (percent or None),
    five_resets, seven_resets (epoch or None), age (seconds), lockout_until (epoch or 0).
    """
    now = time.time()
    u = read_json(usage_path(), {}) or {}
    lock = read_json(lockout_path(), {}) or {}
    lockout_until = lock.get("until") or 0
    if lockout_until and lockout_until < now:
        lockout_until = 0
    age = now - (u.get("updated_at") or 0)
    five = (u.get("five_hour") or {}).get("used_percentage")
    seven = (u.get("seven_day") or {}).get("used_percentage")
    known = five is not None and age < STALE_AFTER
    return {
        "known": known,
        "five": five,
        "seven": seven,
        "five_resets": (u.get("five_hour") or {}).get("resets_at"),
        "seven_resets": (u.get("seven_day") or {}).get("resets_at"),
        "age": age,
        "lockout_until": lockout_until,
        "model": u.get("model"),
    }


def level(snap, th):
    """'hard', 'soft', 'ok' or 'unknown'."""
    if snap["lockout_until"]:
        return "hard"
    if not snap["known"]:
        return "unknown"
    if snap["five"] >= th["hard"]:
        return "hard"
    if snap["seven"] is not None and snap["seven"] >= th["weekly"]:
        return "hard"
    if snap["five"] >= th["soft"]:
        return "soft"
    return "ok"


def summary_line(snap):
    if snap["lockout_until"]:
        return "locked out until %s (API answered rate_limit)" % fmt_reset(snap["lockout_until"])
    if not snap["known"]:
        return "usage window unknown (status line bridge not installed or no API response yet)"
    parts = ["5h %d%% (resets %s)" % (snap["five"], fmt_reset(snap["five_resets"]))]
    if snap["seven"] is not None:
        parts.append("7d %d%% (resets %s)" % (snap["seven"], fmt_reset(snap["seven_resets"])))
    return " · ".join(parts)


def model_rank(model):
    m = (model or "").lower()
    for key, rank in MODEL_TIER.items():
        if key in m:
            return rank
    return 0  # unknown or inherit


def read_stdin_json():
    try:
        return json.load(sys.stdin)
    except ValueError:
        return {}


def emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()
