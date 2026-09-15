#!/bin/bash
# =============================================================================
# Smoke test de la imagen headless
# =============================================================================
#
# Verifica que el contenedor sirve el proveedor AMP, no solo que construye.
# Una imagen que compila y arranca sin servir es exactamente el fallo que este
# test existe para atrapar.
#
# Uso:
#   ./scripts/test-amp-headless-image.sh [imagen]
#
# =============================================================================

set -u

IMAGE="${1:-ai-maestro-headless:test}"
NAME="amp-headless-smoke-$$"
PORT=23099
PASS=0
FAIL=0

check() {
    local label="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        printf '  \033[32m✓\033[0m %-46s %s\n' "$label" "$actual"
        PASS=$((PASS + 1))
    else
        printf '  \033[31m✗\033[0m %-46s esperado=%s obtenido=%s\n' "$label" "$expected" "$actual"
        FAIL=$((FAIL + 1))
    fi
}

cleanup() {
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker rm -f "$NAME-sinred" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Imagen: $IMAGE"
echo ""

docker run -d --name "$NAME" -p "$PORT:23000" "$IMAGE" >/dev/null 2>&1 || {
    echo "No se pudo arrancar el contenedor"
    exit 1
}

# El arranque headless ronda 1 s, pero el primer acceso a disco en un
# contenedor frío puede tardar más. 30 s da margen sin enmascarar un cuelgue.
for _ in $(seq 1 30); do
    curl -fs --max-time 2 "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1 && break
    sleep 1
done

echo "Proveedor AMP"
check "health responde" 200 \
    "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:$PORT/api/v1/health")"
check "se anuncia como proveedor" true \
    "$(curl -s --max-time 8 "http://127.0.0.1:$PORT/api/v1/info" | jq -r '(.capabilities | index("relay-queue")) != null')"
check "registro rechaza peticion vacia" 400 \
    "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -X POST "http://127.0.0.1:$PORT/api/v1/register" -H 'Content-Type: application/json' -d '{}')"

echo ""
echo "Modo headless"
# El dashboard NO debe existir: si responde, la imagen arrancó en modo completo
# y lleva Next.js dentro, con el arranque y la memoria que eso implica.
check "no sirve dashboard" 404 \
    "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:$PORT/")"

echo ""
echo "Seguridad"
check "corre como no-root" node "$(docker exec "$NAME" whoami 2>/dev/null)"
check "sin compilador en la final" ausente \
    "$(docker exec "$NAME" sh -c 'command -v gcc >/dev/null && echo presente || echo ausente' 2>/dev/null)"
check "tini es PID 1" tini \
    "$(docker exec "$NAME" sh -c 'cat /proc/1/comm' 2>/dev/null)"

echo ""
echo "Red"
# El namespace agent-executor deniega TODO el egreso por defecto
# (agent-executor-egress-deny, podSelector: {}), y la politica que lo abre
# selecciona por ligo.jaak.ai/managed-by, etiqueta que el proveedor no lleva.
# Es decir: en el cluster este Pod corre SIN salida, ni siquiera DNS.
#
# Funciona, pero por un detalle que no es evidente: getPublicUrl() recorre las
# interfaces y solo cae a resolver su propio hostname cuando no encuentra
# ninguna. Un Pod siempre tiene eth0, asi que nunca llega ahi.
#
# Este check fija esa condicion. Si alguien introduce una resolucion DNS en el
# arranque, aqui se ve; en el cluster se veria como un Pod que no pasa a Ready
# y un error que no apunta a la politica de red.
NETNAME="$NAME-sinred"
docker rm -f "$NETNAME" >/dev/null 2>&1 || true
# --network none quita tambien eth0, que un Pod si tiene; se le da el hostname
# en /etc/hosts como hace kubelet para no probar una condicion que no existe.
docker run -d --name "$NETNAME" --network none \
    --hostname amp-provider-0 --add-host amp-provider-0:127.0.0.1 \
    "$IMAGE" >/dev/null 2>&1
for _ in $(seq 1 30); do
    docker exec "$NETNAME" node -e \
        "fetch('http://127.0.0.1:23000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
        >/dev/null 2>&1 && break
    sleep 1
done
check "arranca sin egreso de red" 200 \
    "$(docker exec "$NETNAME" node -e \
        "fetch('http://127.0.0.1:23000/api/v1/health').then(r=>console.log(r.status)).catch(()=>console.log('sin-respuesta'))" \
        2>/dev/null | tr -d '\r')"
docker rm -f "$NETNAME" >/dev/null 2>&1 || true

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
