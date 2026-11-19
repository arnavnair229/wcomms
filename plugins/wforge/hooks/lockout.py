#!/usr/bin/env python3
"""StopFailure(rate_limit): record the lockout so the guard refuses fan-out until the window resets.

The API error text usually names the reset time; when it does not, assume the
next 5-hour reset from the last snapshot, or one hour from now as a floor.
"""
import os
import re
import sys
import time
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wforge_common as W  # noqa: E402


def parse_reset(text):
    """Find 'resets 2:20pm' / 'resets at 14:20' in the error text; return epoch or None."""
    if not text:
        return None
    m = re.search(r"resets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)?", text, re.I)
    if not m:
        return None
    hour = int(m.group(1))
    minute = int(m.group(2) or 0)
    ampm = (m.group(3) or "").lower()
    if ampm == "pm" and hour < 12:
        hour += 12
    if ampm == "am" and hour == 12:
        hour = 0
    now = datetime.now()
    t = now.replace(hour=hour % 24, minute=minute, second=0, microsecond=0)
    if t <= now:
        t += timedelta(days=1)
    return int(t.timestamp())


def main():
    inp = W.read_stdin_json()
    text = " ".join(str(inp.get(k) or "") for k in ("error_details", "last_assistant_message"))
    until = parse_reset(text)
    if not until:
        snap = W.snapshot()
        until = snap.get("five_resets") or 0
    if not until or until < time.time():
        until = int(time.time()) + 3600
    W.write_json(W.lockout_path(), {"until": until, "recorded_at": int(time.time())})
    W.emit({"systemMessage": "wforge: rate limit hit. Fan-out is blocked until %s." % W.fmt_reset(until)})


if __name__ == "__main__":
    main()
