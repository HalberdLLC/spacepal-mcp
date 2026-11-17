#!/bin/sh
# Tells the Spacepal app that this Claude Code session is waiting, done or working, so the
# desktop it runs on is marked. Does nothing off macOS, without Spacepal, or when Spacepal's own
# hooks are already in ~/.claude/settings.json (Settings > General > Claude Code), so events never count twice.
[ "$(uname)" = Darwin ] || exit 0
grep -q -- "--agent-event" "$HOME/.claude/settings.json" 2>/dev/null && exit 0
for app in "/Applications/Spacepal.app" "$HOME/Applications/Spacepal.app" \
           "$(mdfind 'kMDItemCFBundleIdentifier == "com.halberd.spacepal.direct"' 2>/dev/null | head -n 1)"; do
  if [ -n "$app" ] && [ -x "$app/Contents/MacOS/Spacepal" ]; then exec "$app/Contents/MacOS/Spacepal" --agent-event "$1"; fi
done
exit 0
