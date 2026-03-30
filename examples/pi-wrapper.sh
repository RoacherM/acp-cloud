#!/bin/bash
# Wrapper to pass provider/model to pi via pi-acp's PI_ACP_PI_COMMAND
exec pi \
  --provider "${PI_PROVIDER:-openrouter}" \
  --model "${PI_MODEL:-moonshotai/kimi-k2.5}" \
  "$@"
