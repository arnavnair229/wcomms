#!/usr/bin/env python3
"""Hook and bridge tests. Runs against a throwaway CLAUDE_CONFIG_DIR so nothing touches ~/.claude."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOKS = os.path.join(PLUGIN, "hooks")
BIN = os.path.join(PLUGIN, "bin")


def run(script, stdin_obj, env_extra=None, args=()):
    env = dict(os.environ)
    env.update(env_extra or {})
    r = subprocess.run([sys.executable, script, *args], input=json.dumps(stdin_obj), capture_output=True, text=True, env=env, timeout=20)
    return r


def load(path):
    with open(path) as f:
        return json.load(f)


def decision(out):
    try:
        return json.loads(out)
    except ValueError:
        return {}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.env = {"CLAUDE_CONFIG_DIR": self.tmp}
        os.makedirs(os.path.join(self.tmp, "wforge", "sessions"))

    def usage(self, five, seven=10.0, age=0):
        now = int(time.time()) - age
        with open(os.path.join(self.tmp, "wforge", "usage.json"), "w") as f:
            json.dump({"updated_at": now, "model": "Opus",
                       "five_hour": {"used_percentage": five, "resets_at": now + 3600},
                       "seven_day": {"used_percentage": seven, "resets_at": now + 86400}}, f)

    def agent_call(self, **tin):
        return {"tool_name": "Agent", "tool_input": tin, "session_id": "s1", "cwd": self.tmp, "hook_event_name": "PreToolUse"}

    def workflow_call(self):
        return {"tool_name": "Workflow", "tool_input": {"script": "x"}, "session_id": "s1", "cwd": self.tmp, "hook_event_name": "PreToolUse"}


class GuardTests(Base):
    def test_ok_passes_through(self):
        self.usage(20)
        r = run(os.path.join(HOOKS, "guard.py"), self.agent_call(model="opus", prompt="p"), self.env)
        self.assertEqual(r.returncode, 0, r.stderr)
        d = decision(r.stdout)
        self.assertEqual(d["hookSpecificOutput"]["permissionDecision"], "allow")
        self.assertNotIn("updatedInput", d["hookSpecificOutput"])

    def test_soft_downshifts_opus_to_sonnet_low(self):
        self.usage(70)
        r = run(os.path.join(HOOKS, "guard.py"), self.agent_call(model="opus", effort="high", prompt="p"), self.env)
        d = decision(r.stdout)
        self.assertEqual(d["hookSpecificOutput"]["permissionDecision"], "allow")
        up = d["hookSpecificOutput"]["updatedInput"]
        self.assertEqual(up["model"], "sonnet")
        self.assertEqual(up["effort"], "low")
        self.assertEqual(up["prompt"], "p")

    def test_soft_leaves_haiku_alone(self):
        self.usage(70)
        r = run(os.path.join(HOOKS, "guard.py"), self.agent_call(model="haiku", effort="low", prompt="p"), self.env)
        d = decision(r.stdout)
        self.assertNotIn("updatedInput", d["hookSpecificOutput"])

    def test_hard_denies_sonnet_allows_haiku(self):
        self.usage(90)
        r = run(os.path.join(HOOKS, "guard.py"), self.agent_call(model="sonnet", prompt="p"), self.env)
        self.assertEqual(decision(r.stdout)["hookSpecificOutput"]["permissionDecision"], "deny")
        r = run(os.path.join(HOOKS, "guard.py"), self.agent_call(model="haiku", prompt="p"), self.env)
        self.assertEqual(decision(r.stdout)["hookSpecificOutput"]["permissionDecision"], "allow")

    def test_hard_denies_workflow(self):
        self.usage(90)
        r = run(os.path.join(HOOKS, "guard.py"), self.workflow_call(), self.env)
        self.assertEqual(decision(r.stdout)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_weekly_hard_denies(self):
        self.usage(10, seven=95)
        r = run(os.path.join(HOOKS, "guard.py"), self.workflow_call(), self.env)
        self.assertEqual(decision(r.stdout)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_stale_snapshot_is_unknown_and_allows(self):
        self.usage(95, age=7 * 3600)
        r = run(os.path.join(HOOKS, "guard.py"), self.workflow_call(), self.env)
        d = decision(r.stdout)
        self.assertEqual(d["hookSpecificOutput"]["permissionDecision"], "allow")
        self.assertIn("setup", d.get("systemMessage", ""))

    def test_thresholds_from_plugin_options(self):
        self.usage(50)
        env = dict(self.env, CLAUDE_PLUGIN_OPTION_HARD_THRESHOLD="40")
        r = run(os.path.join(HOOKS, "guard.py"), self.workflow_call(), env)
        self.assertEqual(decision(r.stdout)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_burst_cap(self):
        self.usage(10)
        env = dict(self.env, CLAUDE_PLUGIN_OPTION_MAX_AGENTS="3")
        for _ in range(3):
            r = run(os.path.join(HOOKS, "guard.py"), self.agent_call(model="haiku", prompt="p"), env)
            self.assertEqual(decision(r.stdout)["hookSpecificOutput"]["permissionDecision"], "allow")
        r = run(os.path.join(HOOKS, "guard.py"), self.agent_call(model="haiku", prompt="p"), env)
        self.assertEqual(decision(r.stdout)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_lockout_blocks_until_reset(self):
        self.usage(10)
        r = run(os.path.join(HOOKS, "lockout.py"), {"error": "rate_limit", "last_assistant_message": "You've hit your 5-hour limit · resets 11:59pm"}, self.env)
        self.assertEqual(r.returncode, 0, r.stderr)
        lock = load(os.path.join(self.tmp, "wforge", "lockout.json"))
        self.assertGreater(lock["until"], time.time())
        r = run(os.path.join(HOOKS, "guard.py"), self.workflow_call(), self.env)
        self.assertEqual(decision(r.stdout)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_other_tools_are_ignored(self):
        self.usage(95)
        r = run(os.path.join(HOOKS, "guard.py"), {"tool_name": "Bash", "tool_input": {"command": "ls"}, "session_id": "s1"}, self.env)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "")


class SessionTests(Base):
    def test_session_context(self):
        self.usage(70)
        r = run(os.path.join(HOOKS, "session.py"), {"session_id": "s1", "hook_event_name": "SessionStart"}, self.env)
        d = decision(r.stdout)
        ctx = d["hookSpecificOutput"]["additionalContext"]
        self.assertIn("5h 70%", ctx)
        self.assertIn("lean", ctx)


class BridgeTests(Base):
    def test_statusline_writes_snapshot_and_prints(self):
        payload = {"session_id": "s1", "model": {"display_name": "Opus"},
                   "context_window": {"used_percentage": 23.4},
                   "rate_limits": {"five_hour": {"used_percentage": 41.2, "resets_at": int(time.time()) + 3600},
                                   "seven_day": {"used_percentage": 12.0, "resets_at": int(time.time()) + 86400}}}
        r = run(os.path.join(BIN, "wforge-statusline"), payload, self.env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("5h", r.stdout)
        self.assertIn("41%", r.stdout)
        snap = load(os.path.join(self.tmp, "wforge", "usage.json"))
        self.assertEqual(snap["five_hour"]["used_percentage"], 41.2)
        # A later update without rate_limits keeps the last known window.
        r = run(os.path.join(BIN, "wforge-statusline"), {"session_id": "s1", "model": {"display_name": "Opus"}}, self.env)
        snap = load(os.path.join(self.tmp, "wforge", "usage.json"))
        self.assertEqual(snap["five_hour"]["used_percentage"], 41.2)

    def test_statusline_chain(self):
        r = run(os.path.join(BIN, "wforge-statusline"), {"model": {"display_name": "Opus"}}, self.env, args=("--chain", "echo OLDLINE"))
        self.assertTrue(r.stdout.startswith("OLDLINE"), r.stdout)

    def test_usage_json(self):
        self.usage(70)
        r = run(os.path.join(BIN, "wforge-usage"), {}, self.env, args=("--json",))
        d = json.loads(r.stdout)
        self.assertEqual(d["level"], "soft")
        self.assertEqual(d["lane"], "lean")

    def test_setup_installs_and_chains(self):
        with open(os.path.join(self.tmp, "settings.json"), "w") as f:
            json.dump({"statusLine": {"type": "command", "command": "echo old"}}, f)
        r = run(os.path.join(BIN, "wforge-setup"), {}, self.env)
        self.assertEqual(r.returncode, 0, r.stderr)
        s = load(os.path.join(self.tmp, "settings.json"))
        self.assertIn("wforge-statusline", s["statusLine"]["command"])
        self.assertIn("--chain", s["statusLine"]["command"])
        r = run(os.path.join(BIN, "wforge-setup"), {}, self.env, args=("--remove",))
        s = load(os.path.join(self.tmp, "settings.json"))
        self.assertEqual(s["statusLine"]["command"], "echo old")


if __name__ == "__main__":
    unittest.main(verbosity=1)
