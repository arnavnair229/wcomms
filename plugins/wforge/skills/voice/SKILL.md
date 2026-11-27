---
name: voice
description: Set up or check voice input for this session through Handy, the free offline speech-to-text app. Use when the user wants to talk instead of type, asks about Handy, dictation, push-to-talk or a voice shortcut, or says "voice".
---

# voice

Handy (handy.computer) is a desktop app: hold a shortcut, speak, release, and the words paste into the focused text field, including the Claude Code prompt. Audio never leaves the machine. wforge does not bundle it; this skill checks it and tells the user what to do.

1. Run `python3 "${CLAUDE_PLUGIN_ROOT}/bin/wforge-voice" status` and show the output.

2. If it is **not installed**: show the install command from the output (on macOS `brew install --cask handy`, or the signed .dmg from https://handy.computer). Installing downloads software, so the user runs it, not you. Say that after the first launch macOS will ask for Microphone and Accessibility permissions and both are required for paste to work.

3. If it **is installed** but not running: offer `wforge-voice open`.

4. Shortcut. Handy's default on macOS is `option+space` (`ctrl+space` on Windows, `ctrl+alt+space` on Linux), hold to talk, release to paste. Tell the user the current binding from the status output and how to change it: Handy's Settings window, Shortcuts. If they use Option+Space for something else, suggest `option+shift+z` or any chord their terminal does not consume. Toggle mode (tap to start, tap to stop) suits long dictations.

5. Model. For a CPU-only or older Mac recommend Parakeet V3 in Handy's Models tab; for Apple Silicon with headroom, Whisper Turbo. Both are offline.

6. Show `wforge-voice card` once: the spoken prefixes that map to wforge skills ("forge", "crew add", "bearings", "budget", "stow", "scout:", "ship:"). Nothing listens in the background; Handy pastes plain text and the user presses Enter.

Do not install anything, do not edit Handy's settings file, do not run `open` without saying so. If Handy is not an option (Linux without a package, or a locked-down machine), say so and stop; dictation through the OS (macOS Dictation, Windows Voice Typing) works with the same spoken card.
