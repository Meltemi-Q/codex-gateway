#!/bin/bash
export PORT=8319
export WORK_DIR=/root
export CODEX_HOME=/root/.codex
exec /usr/bin/node /root/codex-gateway/index.mjs
