#!/usr/bin/env bash
set -euo pipefail

real_codex_bin="${SIM_DESK_CODEX_REAL_BIN:-/usr/local/bin/codex-real}"

if [[ ! -x "$real_codex_bin" ]]; then
  echo "Sim Desk cannot execute the Codex binary at $real_codex_bin." >&2
  exit 127
fi

toml_string() {
  local value="$1"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/\\r}
  value=${value//$'\t'/\\t}
  printf '"%s"' "$value"
}

config_args=()

if [[ -n "${CODEX_MODEL:-}" ]]; then
  config_args+=(--config "model=$(toml_string "$CODEX_MODEL")")
fi

if [[ -n "${CODEX_SANDBOX:-}" ]]; then
  config_args+=(--config "sandbox_mode=$(toml_string "$CODEX_SANDBOX")")
fi

if [[ -n "${CODEX_APPROVAL_POLICY:-}" ]]; then
  config_args+=(--config "approval_policy=$(toml_string "$CODEX_APPROVAL_POLICY")")
fi

if [[ -n "${OPENAI_BASE_URL:-}" ]]; then
  case "$OPENAI_BASE_URL" in
    http://*|https://*) ;;
    *)
      echo "OPENAI_BASE_URL must start with http:// or https://." >&2
      exit 2
      ;;
  esac

  # Use an explicit provider so the API key is attached to custom endpoints.
  # Runtime overrides take precedence without modifying the persisted config.toml.
  config_args+=(--config 'model_provider="sim_desk_openai"')
  config_args+=(--config 'model_providers.sim_desk_openai.name="Sim Desk OpenAI-compatible"')
  config_args+=(--config "model_providers.sim_desk_openai.base_url=$(toml_string "$OPENAI_BASE_URL")")
  config_args+=(--config 'model_providers.sim_desk_openai.env_key="OPENAI_API_KEY"')
  config_args+=(--config 'model_providers.sim_desk_openai.wire_api="responses"')
fi

exec "$real_codex_bin" "${config_args[@]}" "$@"
