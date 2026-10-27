# Fase 1 — Criterios de aprobación y cierre

**Fecha de revisión documental:** 23 de octubre de 2026  
**Estado:** documentación preparada para revisión; Fase 1 todavía no está aprobada.

## Estados

- **Hecho:** hay evidencia en el proyecto o en documentación oficial consultada.
- **Pendiente de aprobación:** requiere decisión explícita de la propietaria.
- **Pendiente externo:** depende de aprobación, producto, cuota o permiso de una plataforma.
- **Fase posterior:** requiere implementación y cuenta de prueba; no es un criterio de cierre documental de Fase 1.

## Lista verificable

| # | Criterio | Estado | Evidencia / trabajo pendiente |
|---|---|---|---|
| 1 | Alcance conserva Facebook, Instagram, Threads, TikTok, YouTube, LinkedIn y X; no se agregan redes. | Hecho | Siete redes enumeradas en [FASE-1-MATRIZ-APIS.md](./FASE-1-MATRIZ-APIS.md). |
| 2 | Se mantiene React.js y JavaScript, sin TypeScript, y esta tarea no altera la interfaz existente. | Hecho | Solo documentación y la descripción de fase 5 en README. `App.jsx` y `styles.css` no se modificaron. |
| 3 | Requisitos, APIs, permisos, medios, programación, límites, costos y auditorías se revisaron en fuentes oficiales para las siete redes. | Hecho con límites | Matriz enlaza las fuentes y separa lo confirmado de lo pendiente/aprobado externamente. |
| 4 | Se diferencia carga local, URL pública y programación nativa. | Hecho | Matriz y arquitectura explican los flujos por plataforma. |
| 5 | Existe propuesta de arquitectura con backend seguro para OAuth y credenciales. | Hecho como propuesta | [FASE-1-ARQUITECTURA.md](./FASE-1-ARQUITECTURA.md); no implementada ni desplegada. |
| 6 | Se propone no almacenar permanentemente medios en servidores LOP y se identifican metadatos almacenables. | Hecho como propuesta | D1 para metadatos, estados e historial; R2 no seleccionado. |
| 7 | Se documentan confirmación, errores, reintentos limitados y prevención de duplicados. | Hecho como propuesta | Incluye estado `unknown`; no asumir idempotencia externa. |
| 8 | Se revisan cuotas gratuitas de Cloudflare sin prometer gratuidad ilimitada. | Hecho con límites | Límites vigentes enlazados en arquitectura; revisar antes de implementar/desplegar. |
| 9 | Se explica migración futura a servidor propio sin cambiar ahora el stack. | Hecho como propuesta | Adaptadores/repo; migración D1/SQLite a PostgreSQL requiere conversión. |
| 10 | Fase 5 declara Android e iOS obligatorios en versión 1.0 y posteriores a la web. | Hecho | Descripción corregida en README. |
| 11 | No se registraron apps externas, no se solicitaron credenciales y no se publicó contenido. | Hecho | No se realizaron esas acciones. |
| 12 | Se respeta la regla de que la propia red almacene el medio y publique a la hora indicada, aunque el computador se apague después de la aceptación remota. | Hecho como requisito | La arquitectura excluye explícitamente una cola de publicación propia como sustituto. |
| 13 | Se identificó en API oficial programación nativa en las siete redes. | **No cumplido; bloqueo documentado** | Solo Facebook Pages y YouTube tienen programación remota confirmada en las fuentes consultadas. En Instagram, Threads, TikTok, LinkedIn y X no se localizó soporte oficial público. |
| 14 | La carga multimedia de Threads es compatible con el requisito de no guardar medios y no exponer una URL pública temporal. | **No cumplido; bloqueo documentado** | Threads requiere `image_url`/`video_url` pública; no se encontró carga binaria local. No se propone almacenamiento ni relay público. |
| 15 | Las pruebas de publicación se realizan en fases posteriores, no para aprobar Fase 1. | Hecho como alcance | No se registraron aplicaciones ni se publicaron contenidos en esta fase. |
| 16 | Se aprueban matriz, arquitectura y tratamiento explícito de las incompatibilidades. | Pendiente de aprobación | Requiere revisión de la propietaria. |
| 17 | Se autoriza cualquier costo de API/cloud y se fijan límites. | Pendiente de la propietaria | No hay autorización de gasto. X es de pago por uso y permanecerá desactivada. |

## Decisiones que requieren intervención de la propietaria

Para revisar y aprobar la documentación de Fase 1, tener en cuenta:

1. **Programación para las siete redes:** se confirma por documentación pública oficial para Facebook Pages y YouTube; no se localizó para Instagram, Threads, TikTok, LinkedIn y X. No se implementará publicación programada en LOP como reemplazo. Para cumplir el requisito universal, será necesaria evidencia/API oficial autorizada para esas cinco redes; hasta entonces se consideran bloqueadas para programación.
2. **Medios de Threads:** se confirma la incompatibilidad entre medios locales sin alojamiento temporal y el requisito de no guardar/exponer medios: Threads documenta URL pública y no se encontró carga binaria local. No se habilitará R2, bucket ni relay público. Threads multimedia queda bloqueado bajo la arquitectura vigente.
3. **X:** permanece desactivada mientras implique costos no autorizados. La tarifa consultada indica USD 0,015 por creación de Post, además de posibles cargos de otros endpoints.
4. **Arquitectura Cloudflare:** Workers + D1 son propuesta para backend/metadatos, sujetos a cuotas gratuitas; R2 no se selecciona ni se activa y no se crea método de pago.
5. **Cuentas y credenciales:** no se requieren para aprobar la documentación ni se deben enviar por chat/repositorio. Su configuración queda para fases de implementación posteriores con autorización de la propietaria.

## Condiciones para cerrar la fase documental

- [ ] Revisar y aprobar (o pedir correcciones a) la matriz de APIs.
- [ ] Revisar y aceptar que cinco redes no tienen aún programación nativa confirmada en las fuentes consultadas y que Threads multimedia no cumple la arquitectura vigente.
- [ ] Aprobar o corregir la arquitectura OAuth, almacenamiento de metadatos, logs y migración.
- [ ] Confirmar que ningún servicio facturable, crédito X ni auto-recarga se activa sin autorización expresa.
- [ ] Aceptar que permisos, auditorías, límites y cuotas dependen de cada plataforma y no están concedidos todavía.
- [ ] Aceptar que el cierre documental no equivale a una prueba de publicación ni garantiza que las APIs funcionen para LOP. Las pruebas no son requisito de Fase 1; se harán en fases posteriores.

La documentación puede aprobarse sin pruebas de publicación. Sin embargo, la aprobación documental no elimina los bloqueos de viabilidad: con la evidencia actual, el requisito de programación remota para las siete redes solo está confirmado para Facebook Pages y YouTube, y Threads no admite medios locales bajo la arquitectura acordada. Estos canales no se presentarán como compatibles hasta obtener evidencia oficial de una alternativa conforme.

## Siguiente paso después de la revisión

Revisar la matriz y confirmar que se acepta registrar como bloqueadas las capacidades no demostradas (programación nativa en cinco redes y medios de Threads). Las pruebas de publicación quedan para las fases posteriores y requieren autorización aparte. Esta entrega no registra aplicaciones ni solicita credenciales.
