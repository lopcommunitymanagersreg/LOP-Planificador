# Fase 1 — Arquitectura propuesta

**Fecha:** 23 de octubre de 2026  
**Estado:** propuesta para revisión; no implementada ni desplegada.  
**Tecnologías acordadas:** React.js y JavaScript, sin TypeScript.  
**Redes iniciales:** Facebook, Instagram, Threads, TikTok, YouTube, LinkedIn y X.

## 1. Principios

1. El navegador nunca recibe secretos de aplicación ni tokens de larga duración.
2. OAuth, renovación de tokens y solicitudes de publicación/programación se controlan desde un backend.
3. LOP no conserva permanentemente copias de imágenes o vídeos. Guarda metadatos, estados, ids remotos y errores sanitizados.
4. Las integraciones son adaptadores independientes: cada red tiene permisos, medios, límites y programación propios.
5. No se propone Cloudflare R2 ni otro almacenamiento multimedia. No se activa un servicio facturable, método de pago o auto-recarga.
6. Los servicios gratuitos tienen cuotas y pueden cambiar. No son capacidad ilimitada ni un SLA.
7. La arquitectura es una propuesta documental; no implica registro de cuentas, credenciales o conexión.

## 2. Componentes

```text
React + JavaScript (navegador)
  ├─ Espacio/marcas, calendario, editor, estados
  ├─ Selección local de archivo (File/Blob temporal en memoria)
  └─ HTTPS + sesión segura
       ↓
Cloudflare Workers (backend JavaScript)
  ├─ Autenticación de LOP y autorización por espacio
  ├─ OAuth callbacks, state/PKCE cuando el proveedor lo admita
  ├─ Intercambio, cifrado, renovación y revocación de tokens
  ├─ Adaptadores/validadores para las siete APIs
  ├─ Envío inmediato de solicitudes de programación nativa
  ├─ Idempotencia, conciliación de estado e historial
  ├─ Cloudflare D1: metadatos (SQLite)
  └─ APIs oficiales de redes sociales
```

La aplicación web existente seguiría en React/JavaScript. El backend complementario también puede escribirse en JavaScript. No se cambia la tecnología acordada a TypeScript.

### Frontend

- Presenta cuentas, calendario, borradores, fechas, resultados y errores.
- El archivo seleccionado queda en memoria temporal del navegador; no se persiste por defecto en `localStorage`, IndexedDB ni backend.
- El navegador transfiere el archivo al endpoint oficial o a un flujo de carga delegado que la red permita.
- No se guardan tokens en el bundle, almacenamiento del navegador ni logs.

### OAuth y credenciales

- `client_secret`, clave de cifrado y secretos de sesión viven como secretos de entorno del Worker, nunca en código versionado.
- El backend crea y valida `state` de un solo uso y PKCE cuando el flujo del proveedor lo soporte, valida la URI de retorno e intercambia el código OAuth.
- Tokens por cuenta se cifran en la aplicación antes de persistirlos en D1; la clave solo es accesible al Worker. Se guardan scopes, vencimiento, proveedor e id remoto.
- Implementar renovación, revocación y eliminación de credenciales siguiendo la duración y política particular de cada red.
- No incluir token, encabezados de autorización, URL de carga temporal, archivo, ni payload sensible en registros.
- No se solicitaron ni crearon credenciales en esta fase.

### Adaptadores

Cada adaptador de red encapsula autorización, validación, transferencia y estado. Como contrato de diseño contempla:

- obtener URL de autorización e intercambiar código;
- validar/renovar token;
- validar tipo de cuenta, permisos, formato y límites;
- iniciar/subir medio cuando se admita;
- solicitar programación nativa a la red solo si la API lo documenta y autoriza;
- consultar estado e identificador remoto;
- revocar acceso.

Una tabla de capacidades por red debe indicar expresamente formatos, método de carga, programación nativa, límites y scopes. Al programar, LOP transfiere el medio y envía fecha y hora a la red; solo tras la aceptación remota se informa que quedó programado. El sistema bloquea una función no admitida en lugar de simular compatibilidad.

## 3. Transferencia de medios sin almacenamiento permanente

### Flujo preferido

1. El usuario selecciona archivo en React.
2. El backend valida cuenta, autorización, tamaño y formato sin persistirlo.
3. El adaptador inicia una sesión de carga con la API oficial.
4. Si la API lo admite y CORS lo permite, el navegador transmite directamente a la URL temporal de carga del proveedor. Si no, el Worker puede hacer relay en streaming sujeto a sus límites.
5. Se descarta el `File` al terminar y se guarda únicamente id de asset/post devuelto y estado.
6. Las URL/handles temporales se tratan como credenciales: no se guardan en D1 ni en logs.

Una vez que la red confirma recepción del medio y acepta la fecha futura, conserva el contenido y publica en sus servidores. El computador puede apagarse después de esa confirmación. LOP no conserva una copia permanente.

### Incompatibilidad de URL pública

Threads requiere que la red social descargue imagen/vídeo desde `image_url`/`video_url` pública; no se encontró endpoint oficial de carga binaria local. Algunos flujos de Instagram/TikTok también usan URL, aunque hay flujos locales específicos para algunos vídeos. Un archivo en el disco del usuario (`file://` o `localhost`) no es accesible desde la red social.

Sin almacenamiento propio ni exposición de URL pública temporal, no puede cumplirse el flujo multimedia de Threads documentado. **No se propone habilitar R2, Cloudflare Images, un relay público ni otro bucket.** Bajo la regla actual, Threads puede conectarse para publicaciones inmediatas de texto; programación futura y fotos/vídeos quedan bloqueados hasta que exista una API oficial compatible o se apruebe expresamente otra política de medios.

### Límites del relay

- Cloudflare documenta máximo de cuerpo de petición de 100 MB en el plan Free. Vídeos superiores pueden fallar aunque el servicio social los acepte.
- Workers Free documenta 10 ms de CPU por invocación y cuota diaria de solicitudes. La espera de red no consume CPU, pero estos topes siguen aplicando.
- La carga directa del navegador es preferible si el endpoint y CORS lo permiten; debe comprobarse por plataforma con permisos reales.
- Si un archivo supera el límite del flujo gratuito, el sistema debe rechazarlo con motivo visible, no moverlo silenciosamente a R2.

## 4. Calendario y programación remota obligatoria

El requisito acordado es que la fecha futura quede registrada en los servidores de la red social y que estos publiquen aunque el computador de la usuaria esté apagado. LOP no usará una cola local o un Worker como sustituto.

1. Al crear una programación, LOP sube el medio desde el computador a la red por su API oficial. No conserva el archivo.
2. LOP envía también la fecha/hora mediante la operación oficial de programación.
3. Solo después de una respuesta de aceptación que identifique la publicación se marca como `scheduled_remote`; se guarda id remoto, fecha y estado.
4. La red conserva el medio y publica en la fecha aceptada. La confirmación de carga por sí sola no es confirmación de programación.
5. Si no existe programación nativa confirmada, LOP indica “programación no disponible por API”; no simula éxito ni guarda un trabajo para publicarlo desde sus propios servidores.

La documentación oficial consultada confirma este mecanismo para:

- **Facebook Pages:** `scheduled_publish_time`, documentado para publicaciones de Page entre 10 minutos y 30 días. Debe confirmarse el flujo para cada endpoint/formato multimedia.
- **YouTube:** `status.publishAt`, bajo condiciones del estado del vídeo; YouTube conserva y publica el vídeo programado.

En las referencias oficiales públicas revisadas no se localizó programación nativa para Instagram, Threads, TikTok, LinkedIn y X. La programación de esos cinco canales queda bloqueada; no se sustituye por Cron Trigger, Worker, proceso en el computador o servicio de terceros. La documentación debe actualizarse si aparece evidencia oficial y acceso autorizable. X también permanece desactivada mientras implique costos no autorizados.

**Efecto en el computador:** el archivo debe estar disponible durante la transferencia inicial. Una vez que la red confirma recepción del medio y acepta la fecha futura, el computador puede apagarse; la publicación posterior depende de los servidores de la red.

## 5. Datos que se conservan en D1

Esquema lógico, por diseñar en Fase 2:

- `users`, `workspaces`, `brands`: titular y espacios.
- `social_accounts`: plataforma, id/nombre mostrado, scopes, expiración, token cifrado y estado de autorización.
- `posts`: texto/caption si se aprueba conservarlo, fecha, zona horaria, redes y estado general.
- `publication_jobs`: una fila por red/cuenta, clave de idempotencia interna, estado, hora solicitada, estado de programación remota, id remoto y error sanitizado.
- `publication_events`: historial de cambios de estado y diagnóstico.

No se guardan bytes, miniaturas, previews, backups multimedia ni archivos locales. Tampoco se necesitan persistir rutas o nombres locales. URLs públicas y direcciones temporales de carga no se guardan en logs. Antes de usuarios externos deben definirse retención, borrado y exportación.

## 6. Confirmación, errores y duplicados

- Estados sugeridos por red: `draft`, `uploading`, `schedule_requested`, `scheduled_remote`, `published`, `failed`, `unknown`, `cancelled`.
- Crear un trabajo en base de datos antes de llamar a una API; usar clave única interna para impedir que dos solicitudes/crons procesen el mismo trabajo.
- Guardar id remoto al recibirlo y consultar estado oficial cuando la red lo permita. Distinguir “aceptada por API” de “publicada”; los vídeos pueden procesarse asíncronamente.
- Aplicar reintentos limitados con espera creciente solo a errores transitorios inequívocos.
- Si se agota el tiempo de espera y la red pudo haber creado la publicación, marcar `unknown`, reconciliar por id/consulta cuando sea posible y no reintentar ciegamente.
- La clave idempotente interna no evita duplicados remotos si el proveedor no ofrece idempotencia para crear posts.
- Registrar código y descripción sanitizados; excluir tokens, headers, URLs con credenciales y archivos.

## 7. Cloudflare gratuito: cuotas y costo

Propuesta inicial a evaluar, no servicios activados:

- **Workers/Pages Functions:** backend y OAuth. Documentación consultada: Workers Free incluye 100.000 requests al día y 10 ms CPU por invocación.
- **D1:** solo metadatos. Workers Free documenta 5 millones de filas leídas al día, 100.000 escritas al día y 5 GB totales. Al superar límites gratuitos, consultas pueden dejar de ejecutarse hasta el reinicio/limpieza.
- **Cron Triggers:** no se usarán para publicar a la hora elegida. La red social debe ejecutar la programación; una tarea de conciliación de estados podría evaluarse aparte.
- **R2:** no está seleccionado ni se activa; la arquitectura no requiere almacenar medios.
- **Queues:** no se propone en esta etapa; la retención gratuita publicada es de 24 horas y no sería la única persistencia para publicaciones programadas a varios días.

Son límites documentales consultados el 23-10-2026; pueden cambiar y no son garantía permanente. No se activa Workers Paid, método de pago ni auto-recarga.

## 8. Migración futura a servidor propio

- Mantener APIs sociales detrás de adaptadores JavaScript y persistencia detrás de un repositorio.
- D1 usa SQLite; pasar a PostgreSQL implica migrar esquema, dialecto, tipos y consultas específicas; no es reemplazo automático.
- Exportar e importar usuarios, cuentas, calendario, estados e historial. Los tokens cifrados deben recifrarse con una clave nueva antes de moverlos; nunca exportar secretos en texto plano o a Git.
- Sustituir Workers/D1 con backend Node.js y PostgreSQL, conservando frontend React y adaptadores. La futura infraestructura puede conciliar estados, pero no reemplazará la programación remota de las redes.
- Ensayar migración de solo lectura, cotejar datos, probar OAuth y realizar una publicación controlada antes de mover tráfico.
- Los medios ya publicados permanecen en los servidores sociales; medios locales no son parte del respaldo de LOP.

## Fuentes oficiales consultadas

- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Meta Pages API](https://developers.facebook.com/documentation/pages-api/posts)
- [Meta Video API](https://developers.facebook.com/documentation/video-api/guides/publishing)
- [Instagram Content Publishing](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/content-publishing)
- [Threads Get Started](https://developers.facebook.com/documentation/threads/get-started)
- [TikTok Content Posting API](https://developers.tiktok.com/doc/content-posting-api-get-started)
- [YouTube videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert)
- [LinkedIn Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-10)
- [X API pricing](https://docs.x.com/x-api/getting-started/pricing)
