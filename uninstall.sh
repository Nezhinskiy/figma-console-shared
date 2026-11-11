#!/bin/bash
# Stops and removes the shared figma-console launchd agent.
# Files in this folder (including the token file) and the log are kept.
set -u
LABEL="local.figma-console-shared"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "service removed"
