# A2A Protocol Server — rama `feat/a2a-protocol-server`

Expone los agentes de AI Maestro por el protocolo Agent2Agent (A2A) v1.0, para
que sistemas y agentes externos (LangChain, CrewAI, código propio) puedan
descubrirlos e invocarlos sin acoplarse a la API de AI Maestro.

**No sustituye a AMP.** AMP sigue siendo el bus interno entre agentes de la
malla; A2A es la puerta de entrada desde fuera. La ejecución de una tarea A2A
se traduce a un mensaje AMP, de modo que un agente apagado la recibe igual
(store-and-forward) en vez de fallar.

Spec: https://a2a-protocol.org/v1.0.0/specification/
SDK:  `@a2a-js/sdk` v1.1.0 (oficial, servidor + cliente)

## Decisiones tomadas

- **Una Agent Card por agente**, no una agregada del host. Cada agente se
  anuncia y se invoca por separado.
- **Ejecución vía puente AMP**: la tarea A2A se convierte en mensaje AMP al
  buzón del agente; la respuesta del agente resuelve la tarea. Diferido, no
  streaming en vivo.
- **Se propone a upstream** (23blocks-OS) además de vivir en jaak-ai.

## Subtareas

- [x] Identidad del remitente. RESUELTO sin agente sintético: `sendFromUI`
      NO exige que el `from` resuelva a un agente registrado — lo marca como
      no verificado (`fromVerified: false`, caso ya previsto para "external
      agents") y entrega igual. El llamante A2A se propaga tal cual, así que
      no se pierde quién llamó.
- [x] Agent Card por agente — `lib/a2a/agent-card.ts` (12 tests).
- [ ] Endpoint de descubrimiento en la ruta well-known que exige la spec.
- [x] `AgentExecutor` — `lib/a2a/executor.ts` (8 tests). Publica task →
      working → artifact → completed. Distingue agente offline (mensaje
      encolado) de fallo, y dice que cancelar NO retira el mensaje ya
      entregado al buzón.
- [x] Correlación por `inReplyTo`, acotada por timestamp y límite de 50.
      DECIDIDO polling sobre hook de entrega: el hook obligaría a tocar el
      pipeline de mensajes existente y eso reduce mucho las opciones de que
      upstream acepte el PR. Sustituir `awaitReply` si el coste importa.
- [x] Almacén de tareas persistente — `lib/a2a/task-store.ts` (13 tests). El `InMemoryTaskStore` del SDK no
      sobrevive a un reinicio; AI Maestro corre bajo PM2 con reinicios).
- [ ] Montaje del transporte: rutas Next bajo `app/api/a2a/` o intercepción
      en `server.mjs`. Debe funcionar en modo full y headless.
- [ ] Autenticación: qué exige el servidor a un cliente A2A externo.
      Sin esto NO se despliega fuera de la VPN.
- [ ] Firma de Agent Cards con JWS reutilizando las claves Ed25519 que AMP ya
      genera por agente, en vez de introducir un modelo de identidad nuevo.
- [ ] Tests unitarios (vitest, como el resto del repo).
- [ ] Documentación en `docs/` y entrada en CLAUDE.md.

## Riesgos conocidos

- La respuesta diferida encaja mal con clientes A2A que esperan streaming.
  Hay que declarar honestamente las capabilities en la card.
- Exponer agentes por HTTP amplía la superficie de ataque: hasta que la
  autenticación esté cerrada, esto solo escucha dentro de la VPN.
