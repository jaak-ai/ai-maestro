#!/bin/bash
# =============================================================================
# A2A smoke test
# =============================================================================
#
# Exercises the A2A endpoint against a running AI Maestro.
#
# Usage:
#   ./scripts/test-a2a.sh [agent-id]
#
# Environment:
#   BASE   Base URL (default http://localhost:23000)
#   TOKEN  Bearer token to present. Without it, only the closed-by-default
#          behaviour is checked.
#
# The first block runs with A2A disabled on purpose: the most important
# property of this feature is that it serves nothing until switched on, and a
# test suite that only covers the happy path would never notice it falling open.
# =============================================================================

BASE="${BASE:-http://localhost:23000}"
AGENT="${1:-}"
PASS=0
FAIL=0

check() {
    local label="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        printf '  \033[32m✓\033[0m %-52s %s\n' "$label" "$actual"
        PASS=$((PASS + 1))
    else
        printf '  \033[31m✗\033[0m %-52s esperado=%s obtenido=%s\n' "$label" "$expected" "$actual"
        FAIL=$((FAIL + 1))
    fi
}

code() {
    curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@"
}

if [ -z "$AGENT" ]; then
    AGENT=$(curl -s --max-time 10 "$BASE/api/agents" | jq -r '.agents[0].id // empty')
    [ -n "$AGENT" ] || { echo "No agents registered and none given"; exit 1; }
fi

echo "Base:  $BASE"
echo "Agent: $AGENT"
echo ""

CARD="$BASE/api/a2a/agents/$AGENT/.well-known/agent-card.json"
RPC="$BASE/api/a2a/agents/$AGENT"

echo "Cerrado por defecto"
# 404, not 401: a 401 would confirm this host runs AI Maestro and has agents.
if [ -z "$TOKEN" ]; then
    check "card sin token" 404 "$(code "$CARD")"
    check "rpc sin token" 404 "$(code -X POST "$RPC" -H 'Content-Type: application/json' -d '{}')"
    check "agente inexistente" 404 "$(code "$BASE/api/a2a/agents/no-existe/.well-known/agent-card.json")"
    echo ""
    echo "  (sin TOKEN solo se comprueba el cierre; exporta TOKEN para el resto)"
else
    check "card con token incorrecto" 401 "$(code "$CARD" -H 'Authorization: Bearer incorrecto')"
    check "card sin cabecera" 401 "$(code "$CARD")"
    check "esquema no bearer" 401 "$(code "$CARD" -H 'Authorization: Basic abc')"
    echo ""

    echo "Autenticado"
    check "card con token válido" 200 "$(code "$CARD" -H "Authorization: Bearer $TOKEN")"

    body=$(curl -s --max-time 15 "$CARD" -H "Authorization: Bearer $TOKEN")
    check "la card declara streaming=false" false \
        "$(jq -r '.capabilities.streaming' <<< "$body")"
    check "la card anuncia bearer" httpAuthSecurityScheme \
        "$(jq -r '.securitySchemes.bearer.scheme["$case"] // "none"' <<< "$body")"
    check "la interfaz apunta a este agente" 0 \
        "$(jq -r --arg a "$AGENT" 'if (.supportedInterfaces[0].url | test($a)) then 0 else 1 end' <<< "$body")"
    echo ""

    echo "JSON-RPC"
    check "json mal formado" 400 \
        "$(code -X POST "$RPC" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d 'no-json')"
    check "subruta POST no existe" 404 \
        "$(code -X POST "$RPC/otra" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}')"

    rpc() {
        curl -s --max-time 45 -X POST "$RPC" \
            -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$1"
    }

    # Method names are PascalCase in A2A v1.0 (SendMessage/GetTask), not the
    # message/send and tasks/get of v0.3.
    check "metodo inexistente -> -32601" -32601 \
        "$(rpc '{"jsonrpc":"2.0","id":1,"method":"no/existe","params":{}}' | jq -r '.error.code')"

    check "SendMessage sin texto -> tarea FAILED legible" TASK_STATE_FAILED \
        "$(rpc '{"jsonrpc":"2.0","id":2,"method":"SendMessage","params":{"message":{"messageId":"t1","role":1,"parts":[]}}}' \
           | jq -r '.result.task.status.state')"

    echo ""
    echo "Ciclo completo"
    # The one that matters: SendMessage must answer immediately. Awaiting the
    # agent inside execute() held the request open for the whole reply timeout.
    START=$(date +%s)
    SENT=$(rpc '{"jsonrpc":"2.0","id":3,"method":"SendMessage","params":{"message":{"messageId":"t2","role":1,"parts":[{"text":"smoke test"}]}}}')
    ELAPSED=$(( $(date +%s) - START ))

    check "SendMessage devuelve WORKING" TASK_STATE_WORKING \
        "$(jq -r '.result.task.status.state' <<< "$SENT")"
    check "SendMessage no bloquea (<5s)" ok \
        "$([ "$ELAPSED" -lt 5 ] && echo ok || echo "tardo ${ELAPSED}s")"

    TASK=$(jq -r '.result.task.id' <<< "$SENT")
    # GetTask takes `id`, not the `name: tasks/<id>` of v0.3.
    check "GetTask encuentra la tarea" "$TASK" \
        "$(rpc "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"GetTask\",\"params\":{\"id\":\"$TASK\"}}" | jq -r '.result.id')"
    check "la tarea persiste en disco" ok \
        "$([ -f "$HOME/.aimaestro/a2a/tasks/$TASK.json" ] && echo ok || echo falta)"
    check "ListTasks la incluye" ok \
        "$(rpc '{"jsonrpc":"2.0","id":5,"method":"ListTasks","params":{}}' \
           | jq -r --arg t "$TASK" 'if ([.result.tasks[].id] | index($t)) != null then "ok" else "no" end')"
fi

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
