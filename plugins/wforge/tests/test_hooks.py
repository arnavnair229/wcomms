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

    def test_statusline_compact_hint(self):
        r = run(os.path.join(BIN, "wforge-statusline"), {"model": {"display_name": "Opus"}, "context_window": {"used_percentage": 80}}, self.env)
        self.assertIn("compact?", r.stdout)
        r = run(os.path.join(BIN, "wforge-statusline"), {"model": {"display_name": "Opus"}, "context_window": {"used_percentage": 20}}, self.env)
        self.assertNotIn("compact?", r.stdout)

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
        # The command points at the stable copy under the config dir, not the plugin cache.
        self.assertIn(os.path.join(self.tmp, "wforge", "bridge"), s["statusLine"]["command"])
        bridge = os.path.join(self.tmp, "wforge", "bridge", "wforge-statusline")
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "wforge", "bridge", "wforge_common.py")))
        # The copied bridge runs on its own, with the same stdin contract.
        r = run(bridge, {"model": {"display_name": "Opus"}}, self.env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("[Opus]", r.stdout)
        # Re-running keeps the chained command and does not nest the bridge inside itself.
        r = run(os.path.join(BIN, "wforge-setup"), {}, self.env)
        s = load(os.path.join(self.tmp, "settings.json"))
        self.assertEqual(s["statusLine"]["command"].count("wforge-statusline"), 1)
        self.assertIn("echo old", s["statusLine"]["command"])
        r = run(os.path.join(BIN, "wforge-setup"), {}, self.env, args=("--remove",))
        s = load(os.path.join(self.tmp, "settings.json"))
        self.assertEqual(s["statusLine"]["command"], "echo old")


class MarkTests(Base):
    def test_mark_start_end_reports_cost(self):
        self.usage(30)
        r = run(os.path.join(BIN, "wforge-usage"), {}, self.env, args=("--mark", "start", "demo task"))
        self.assertIn("30", r.stdout)
        self.usage(36.5)
        r = run(os.path.join(BIN, "wforge-usage"), {}, self.env, args=("--mark", "end", "demo task"))
        self.assertIn("+6.5 pts", r.stdout, r.stdout + r.stderr)
        r = run(os.path.join(BIN, "wforge-usage"), {}, self.env, args=("--marks", "--json"))
        d = json.loads(r.stdout)
        self.assertEqual(d[-1]["cost_pts"], 6.5)

    def test_mark_cost_unknown_across_reset(self):
        self.usage(80)
        run(os.path.join(BIN, "wforge-usage"), {}, self.env, args=("--mark", "start", "late"))
        # window reset: lower percentage, different resets_at
        now = int(time.time())
        with open(os.path.join(self.tmp, "wforge", "usage.json"), "w") as f:
            json.dump({"updated_at": now, "five_hour": {"used_percentage": 5, "resets_at": now + 18000}}, f)
        r = run(os.path.join(BIN, "wforge-usage"), {}, self.env, args=("--mark", "end", "late"))
        self.assertIn("cost unknown", r.stdout)


class CrewTests(Base):
    def setUp(self):
        super().setUp()
        self.crew = os.path.join(self.tmp, "crew.json")
        self.env["WFORGE_CREW_FILE"] = self.crew

    def crew_cmd(self, *args):
        r = run(os.path.join(BIN, "wforge-crew"), {}, self.env, args=args)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def test_add_list_show(self):
        out = self.crew_cmd("add", "Add dark mode", "--size", "M", "--note", "toggle in settings")
        self.assertIn("added T1 ship M", out)
        self.crew_cmd("add", "Why flaky", "--shape", "scout", "--size", "S")
        out = self.crew_cmd("list")
        self.assertIn("T1", out)
        self.assertIn("T2", out)
        d = json.loads(self.crew_cmd("show", "T1", "--json"))
        self.assertEqual(d["note"], "toggle in settings")
        self.assertEqual(d["state"], "ready")
        self.assertTrue(os.path.exists(self.crew))

    def test_next_respects_lane(self):
        self.crew_cmd("add", "Big rewrite", "--size", "L")
        self.crew_cmd("add", "Small fix", "--size", "S")
        self.crew_cmd("add", "Look into logs", "--shape", "scout", "--size", "M")
        self.usage(90)
        d = json.loads(self.crew_cmd("next", "--json"))
        self.assertEqual(d["level"], "hard")
        self.assertEqual(sorted(t["id"] for t in d["allowed"]), ["T2", "T3"])
        self.assertEqual(d["blocked"], ["T1"])
        self.usage(70)
        d = json.loads(self.crew_cmd("next", "--json"))
        self.assertEqual(sorted(t["id"] for t in d["allowed"]), ["T2", "T3"])
        self.usage(10)
        d = json.loads(self.crew_cmd("next", "--json"))
        self.assertEqual(len(d["allowed"]), 3)

    def test_dispatch_skips_small_ship_and_caps(self):
        self.usage(10)
        for i in range(5):
            self.crew_cmd("add", "task %d" % i, "--size", "M")
        self.crew_cmd("add", "tiny", "--size", "S")
        d = json.loads(self.crew_cmd("dispatch", "--max", "3"))
        self.assertEqual(len(d["tasks"]), 3)
        self.assertEqual(d["maxParallel"], 2)
        self.assertNotIn("T6", [t["id"] for t in d["tasks"]])
        self.usage(70)
        d = json.loads(self.crew_cmd("dispatch"))
        self.assertEqual(d["maxParallel"], 1)

    def test_start_done_measures_cost(self):
        self.crew_cmd("add", "measured", "--size", "M")
        self.usage(40)
        out = self.crew_cmd("start", "T1", "--branch", "wforge/t1-measured")
        self.assertIn("5h 40", out)
        self.usage(47)
        out = self.crew_cmd("done", "T1", "--result", "shipped")
        self.assertIn("+7.0 pts", out)
        d = json.loads(self.crew_cmd("show", "T1", "--json"))
        self.assertEqual(d["state"], "done")
        self.assertEqual(d["branch"], "wforge/t1-measured")
        self.assertEqual(d["cost_pts"], 7.0)
        rep = json.loads(self.crew_cmd("report", "--json"))
        self.assertEqual(rep["measured_24h"]["tasks"], 1)
        self.assertEqual(rep["measured_24h"]["total_pts"], 7.0)

    def test_hold_release_drop(self):
        self.crew_cmd("add", "needs call", "--size", "M")
        out = self.crew_cmd("hold", "T1", "schema decision")
        self.assertIn("held T1: schema decision", out)
        d = json.loads(self.crew_cmd("next", "--json"))
        self.assertEqual(d["allowed"], [])
        self.crew_cmd("release", "T1")
        self.assertEqual(json.loads(self.crew_cmd("show", "T1", "--json"))["state"], "ready")
        self.crew_cmd("drop", "T1")
        self.assertNotIn("T1", self.crew_cmd("list"))
        self.assertIn("T1", self.crew_cmd("list", "--all"))

    def test_session_context_mentions_backlog(self):
        self.usage(10)
        root = os.path.join(self.tmp, "proj")
        os.makedirs(os.path.join(root, ".wforge"))
        del self.env["WFORGE_CREW_FILE"]
        subprocess.run(["git", "init", "-q", root], check=True)
        r = subprocess.run([sys.executable, os.path.join(BIN, "wforge-crew"), "add", "queued", "--size", "S"],
                           cwd=root, env=dict(os.environ, **self.env), capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        r = subprocess.run([sys.executable, os.path.join(HOOKS, "session.py")], input=json.dumps({"session_id": "s1"}),
                           cwd=root, env=dict(os.environ, **self.env), capture_output=True, text=True)
        ctx = json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("1 ready", ctx)


class AgentLedgerTests(Base):
    def transcript(self, model, n_turns):
        path = os.path.join(self.tmp, "agent-x.jsonl")
        with open(path, "w") as f:
            for i in range(n_turns):
                f.write(json.dumps({"type": "user", "message": {"role": "user", "content": "go"}}) + "\n")
                f.write(json.dumps({"type": "assistant", "effort": "low", "message": {
                    "model": model, "role": "assistant",
                    "usage": {"input_tokens": 10, "output_tokens": 100, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 50}}}) + "\n")
        return path

    def test_start_then_stop_writes_ledger(self):
        self.usage(20)
        r = run(os.path.join(HOOKS, "agents.py"), {"hook_event_name": "SubagentStart", "agent_id": "a1", "agent_type": "wforge:scout",
                                                   "session_id": "s1", "cwd": self.tmp}, self.env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "")
        open_agents = load(os.path.join(self.tmp, "wforge", "agents_open.json"))
        self.assertIn("a1", open_agents)
        self.assertEqual(open_agents["a1"]["agent_type"], "wforge:scout")
        path = self.transcript("claude-haiku-5-5", 3)
        r = run(os.path.join(HOOKS, "agents.py"), {"hook_event_name": "SubagentStop", "agent_id": "a1", "agent_type": "wforge:scout",
                                                   "session_id": "s1", "cwd": self.tmp, "agent_transcript_path": path}, self.env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(load(os.path.join(self.tmp, "wforge", "agents_open.json")), {})
        with open(os.path.join(self.tmp, "wforge", "agents.jsonl")) as f:
            rec = json.loads(f.read().strip().splitlines()[-1])
        self.assertEqual(rec["tier"], "haiku")
        self.assertEqual(rec["model"], "claude-haiku-5-5")
        self.assertEqual(rec["turns"], 3)
        self.assertEqual(rec["output_tokens"], 300)
        self.assertEqual(rec["cache_read_tokens"], 3000)
        self.assertEqual(rec["effort"], "low")
        self.assertIsNotNone(rec["duration_s"])

    def test_stop_without_start_or_transcript_still_records(self):
        r = run(os.path.join(HOOKS, "agents.py"), {"hook_event_name": "SubagentStop", "agent_id": "ghost", "agent_type": "", "session_id": "s1"}, self.env)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(os.path.join(self.tmp, "wforge", "agents.jsonl")) as f:
            rec = json.loads(f.read().strip().splitlines()[-1])
        self.assertEqual(rec["tier"], "?")
        self.assertIsNone(rec["duration_s"])

    def test_other_events_ignored(self):
        r = run(os.path.join(HOOKS, "agents.py"), {"hook_event_name": "PreToolUse", "agent_id": "a1"}, self.env)
        self.assertEqual(r.returncode, 0)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "wforge", "agents.jsonl")))

    def test_watch_renders_once_and_json(self):
        self.usage(42)
        run(os.path.join(HOOKS, "agents.py"), {"hook_event_name": "SubagentStart", "agent_id": "a2", "agent_type": "wforge:builder", "session_id": "s1", "cwd": self.tmp}, self.env)
        path = self.transcript("claude-sonnet-5-5", 2)
        run(os.path.join(HOOKS, "agents.py"), {"hook_event_name": "SubagentStop", "agent_id": "a2", "agent_type": "wforge:builder", "session_id": "s1", "agent_transcript_path": path}, self.env)
        run(os.path.join(HOOKS, "agents.py"), {"hook_event_name": "SubagentStart", "agent_id": "a3", "agent_type": "wforge:scout", "session_id": "s1", "cwd": self.tmp}, self.env)
        env = dict(self.env, WFORGE_CREW_FILE=os.path.join(self.tmp, "crew.json"))
        run(os.path.join(BIN, "wforge-crew"), {}, env, args=("add", "watch me", "--size", "M"))
        r = run(os.path.join(BIN, "wforge-watch"), {}, env, args=("--once", "--root", self.tmp))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("42%", r.stdout)
        self.assertIn("running agents (1)", r.stdout)
        self.assertIn("wf:scout", r.stdout)
        self.assertIn("wf:builder", r.stdout)
        self.assertIn("sonnet", r.stdout)
        self.assertIn("watch me", r.stdout)
        r = run(os.path.join(BIN, "wforge-watch"), {}, env, args=("--json", "--root", self.tmp))
        d = json.loads(r.stdout)
        self.assertEqual(len(d["running"]), 1)
        self.assertEqual(d["recent"][-1]["tier"], "sonnet")
        self.assertEqual(d["by_tier_24h"]["sonnet"]["n"], 1)
        self.assertEqual(d["version"], load(os.path.join(PLUGIN, ".claude-plugin", "plugin.json"))["version"])

    def test_session_context_has_version(self):
        self.usage(10)
        r = run(os.path.join(HOOKS, "session.py"), {"session_id": "s1"}, self.env)
        ctx = decision(r.stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("wforge 0.3.1", ctx)


class VoiceTests(Base):
    def test_status_json_and_install_hint(self):
        r = run(os.path.join(BIN, "wforge-voice"), {}, self.env, args=("status", "--json"))
        self.assertEqual(r.returncode, 0, r.stderr)
        d = json.loads(r.stdout)
        self.assertIn("installed", d)
        self.assertTrue(d["install_command"])
        r = run(os.path.join(BIN, "wforge-voice"), {}, self.env, args=("card",))
        self.assertIn("/wforge:forge", r.stdout)


class NightshiftTests(Base):
    def test_refuses_without_api_key(self):
        env = dict(os.environ, **self.env)
        env.pop("ANTHROPIC_API_KEY", None)
        r = subprocess.run(["sh", os.path.join(BIN, "wforge-nightshift"), "tidy"], env=env, capture_output=True, text=True, cwd=self.tmp)
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn("API lane", r.stderr)

    def test_refuses_dirty_tree_even_with_key(self):
        root = os.path.join(self.tmp, "repo")
        os.makedirs(root)
        subprocess.run(["git", "init", "-q", "-b", "main", root], check=True)
        with open(os.path.join(root, "a.txt"), "w") as f:
            f.write("x")
        env = dict(os.environ, **self.env, ANTHROPIC_API_KEY="sk-test-not-real")
        r = subprocess.run(["sh", os.path.join(BIN, "wforge-nightshift"), "tidy"], env=env, capture_output=True, text=True, cwd=root)
        self.assertEqual(r.returncode, 2)
        self.assertIn("not clean", r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=1)
