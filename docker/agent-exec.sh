#!/bin/sh
# Join the container's desktop session, then run the remote agent.
#
# `docker exec` starts with a fresh environment: it does not inherit the
# DISPLAY export or the dbus-run-session address the entrypoint created, and
# without the same session bus an exec'd agent cannot see the accessibility
# tree of apps already on the display. The entrypoint writes both to
# /tmp/cu-session.env; source it, then hand off.
set -eu

ENV_FILE=/tmp/cu-session.env
# Until the entrypoint has written the session env, an agent would run off
# the session bus and never see the accessibility tree: refuse, so spawn's
# readiness probe keeps waiting instead of reporting a half-started desktop.
if [ ! -s "$ENV_FILE" ]; then
  echo "agent-exec: session not ready ($ENV_FILE missing)" >&2
  exit 75
fi
# Sourced assignments are not exported by default; allexport marks them so
# the agent process (and the backend tools it runs) inherit display and bus.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

exec node /app/agent.mjs "$@"
