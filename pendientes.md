# Panel de Volo — rama `feature/volo-tasks-panel`

Pestaña en AI Maestro para ver los boards de Volo y asignar tareas a agentes.

**Solo para el fork de JAAK, por ahora.** Volo es un sistema interno; cablearlo
en el repo de 23blocks no se aceptaría upstream. Si más adelante interesa
proponerlo, el camino es una abstracción de "fuente de tareas" con Volo como
una implementación — igual que el repo hace ya con los proveedores de LLM.

## Por qué el OAuth lo sirve AI Maestro y no un script

El servidor de Volo no anuncia device flow, así que el único grant es
authorization_code, que necesita un redirect alcanzable por el navegador. Un
CLI redirige a `127.0.0.1`, que es el loopback DEL HOST: cuando el dashboard se
usa desde otra máquina —lo normal en una malla— el navegador no lo alcanza y
hay que copiar URLs a mano. Probado y sufrido antes de cambiarlo.

Sirviéndolo desde AI Maestro, el redirect cae en el mismo origen que el usuario
ya está navegando (`http://172.27.240.10:23000/api/volo/auth/callback`).

## Hecho

- [x] `lib/volo/oauth.ts` — DCR, PKCE S256, refresh silencioso, credenciales
      en `~/.aimaestro/volo/oauth.json` con modo 0600 desde su creación.
- [x] `lib/volo/client.ts` — llamadas a las herramientas MCP de Volo.
- [x] Rutas: status, auth/start, auth/callback, auth/disconnect, boards,
      boards/[identifier], assign.
- [x] `app/volo/page.tsx` + `components/volo/AssignTaskDialog.tsx`, sobre la
      vista unificada `get_cross_board_kanban` — la misma que hay detrás de
      volo.jaak.ai/my-work.
- [x] Enlace en la cabecera.

## Por qué la vista unificada y no un kanban por board

`get_cross_board_kanban` agrupa por TIPO de columna, no por nombre. En este
workspace conviven `ToDo`, `Todo`, `Por Hacer` y `Backlog` para el mismo
estado: agrupar por nombre habría dispersado el mismo estado en cuatro
columnas. Además trae las tareas de todos los boards a la vez, que es lo que
hace falta para decidir qué delegar.

## Verificado contra el Volo real

- 19 boards leídos.
- Vista unificada: 275 tareas propias (162 por hacer, 38 en curso) en 9
  boards. Con `mine=false`, 567 de todo el equipo. El filtro `mine` funciona.
- Volo trunca el resultado (`truncated: 75` con limit 200); la interfaz lo
  dice en vez de enseñar un tablero incompleto que parezca completo.
- Agrupación por columnas correcta: Tech Ops reparte 850 tareas en 7 columnas
  (159 ToDo, 37 In Progress, 71 Blocked, 493 Done).
- `get_task` devuelve `{task, board}` con `board.id`.

Un error que solo apareció con datos reales: las tareas NO cuelgan de las
columnas. Volo devuelve `board.tasks` en la raíz y cada tarea apunta a su
columna con `columnId`. Leer `column.tasks` habría pintado todas las columnas
vacías, que parece un problema de permisos y no un fallo de agrupación.

## Pendiente

- [ ] Exponer en el diálogo el mover de columna al asignar. La API ya lo
      soporta (`moveToColumnId`), la interfaz no lo ofrece.
- [ ] Tests (vitest) del cliente y de la agrupación.
- [ ] Verificación visual: la parte de interfaz no está probada por nadie
      todavía, solo compilada y servida con HTTP 200.
- [x] Refrescar tras asignar (`onAssigned`).
- [ ] Si cambia la IP del host cambia el redirect_uri y Volo lo rechaza: hay
      que volver a conectar. `/api/volo/status` devuelve el redirect actual
      para poder diagnosticarlo.
