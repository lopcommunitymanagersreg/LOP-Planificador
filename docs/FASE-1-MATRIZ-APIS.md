# Fase 1 — Matriz técnica de APIs

**Fecha de verificación documental:** 23 de octubre de 2026  
**Alcance:** Facebook, Instagram, Threads, TikTok, YouTube, LinkedIn y X.  
**Estado:** investigación documental; no se crearon cuentas de desarrollador, aplicaciones, credenciales ni publicaciones de prueba.

## Cómo leer esta matriz

- **Confirmado:** aparece en la documentación oficial enlazada y se verificó en la fecha indicada. No significa que LOP tenga acceso o aprobación.
- **Depende de aprobación externa:** la plataforma debe aprobar permisos, producto, auditoría o revisión antes de permitir uso fuera de cuentas/roles de prueba.
- **Pendiente:** la documentación pública revisada no permite asegurar el comportamiento, el costo o la disponibilidad concreta; debe confirmarse en el portal de desarrolladores antes de implementarlo.
- “Carga local” significa que el archivo puede transferirse desde el equipo a la API sin que LOP guarde una copia permanente. La API social puede conservar el medio como parte de la publicación.
- “Programación nativa” significa que la API permite solicitar a la plataforma que publique en una fecha futura, sin que un servidor de LOP tenga que ejecutarse a esa hora.

Las APIs, interfaces de desarrollador, límites y precios pueden cambiar. Esta matriz no sustituye la revisión de permisos y condiciones del portal de desarrolladores. No se presume acceso gratuito ilimitado.

## Resumen comparativo

| Red | Texto | Imagen | Vídeo | Archivo local sin copia permanente de LOP | ¿La API deja el medio programado en los servidores sociales? | Restricción principal |
|---|---|---|---|---|---|---|
| Facebook Pages | Sí | Sí | Sí | Vídeo: sí, carga reanudable a Meta. Foto: URL documentada; confirmar carga binaria local para el endpoint elegido. | **Sí para Page posts:** `scheduled_publish_time`, de 10 min a 30 días. Confirmar por formato la programación de medios. | Pages, no perfiles personales; permisos/revisión para usuarios externos. |
| Instagram | No como post independiente de texto; el texto acompaña al medio | Sí | Sí | Vídeo/Reels: carga local reanudable en flujo compatible. El flujo estándar requiere URL pública. | **No localizada** en la API oficial consultada. No cumple todavía programación nativa. | Cuenta profesional; flujos de medios dependen del login. |
| Threads | Sí | Sí | Sí | **No para imagen/vídeo bajo la arquitectura acordada:** `image_url`/`video_url` deben ser públicos; no se encontró carga binaria local. | **No localizada** en la API oficial consultada. | Requiere URL pública para medios; App Review para usuarios externos. |
| TikTok | No como post de texto independiente en el flujo revisado | Sí | Sí | Vídeo: sí, `FILE_UPLOAD`. Fotos: URL verificada en la guía revisada; confirmar carga local. | **No localizada** en Content Posting API revisada. | Antes de auditoría las publicaciones quedan privadas; aprobación de `video.publish`. |
| YouTube | Metadatos de vídeo; no es API general de posts de texto | No como post fotográfico independiente | Sí | Sí, carga reanudable local a YouTube. | **Sí para vídeo:** `status.publishAt`, con condiciones; YouTube mantiene el vídeo programado. | Cuota predeterminada de 100 `videos.insert`/día; aumentos sujetos a proceso. |
| LinkedIn | Sí | Sí | Sí | Sí, carga de assets a LinkedIn y luego Posts API. | **No localizada** en el Posts API oficial consultado. | Productos/permisos; acceso organizacional sujeto a rol y elegibilidad. |
| X | Sí | Sí | Sí | Sí, carga local a X y creación con `media_id`. | **No localizada** en la API oficial consultada. | De pago por uso; “Post: Create” listado a USD 0,015 por solicitud. X desactivada. |

**Interpretación:** la programación en servidores sociales está confirmada documentalmente para Facebook Pages y YouTube, con el alcance indicado. En las otras cinco APIs públicas revisadas no se localizó un mecanismo oficial que acepte una fecha futura y haga que la red publique después. Esto no descarta productos privados/partners, pero no podemos asumir que estén disponibles para LOP. La programación de esas redes queda bloqueada hasta hallar y verificar una API oficial autorizada. No se usará una cola de LOP como sustituto.

## 1. Facebook

### Cuenta, API y permisos

- **Confirmado:** la Pages API publica como una **Página**, no como perfil personal.
- Para publicar se necesita una persona con tarea `CREATE_CONTENT` y un Page access token obtenido mediante Facebook Login.
- Permisos documentados: `pages_show_list`, `pages_read_engagement` y `pages_manage_posts`; para vídeo se usa la Video API.
- En pruebas se usan personas/Pages con rol de la app. Para que usuarios fuera de roles de prueba concedan permisos se necesita Advanced Access y App Review.

### Contenido, medios, programación y límites

- Texto: `POST /{page-id}/feed`.
- Fotos: el ejemplo de Posts API usa `url` para que Meta obtenga la imagen.
- Vídeos: la Video API documenta carga reanudable del archivo local a Meta y publicación con el handle devuelto.
- **Pendiente:** confirmar para la versión de Graph API elegida si el endpoint fotográfico admite carga multipart/handle local. No se asume que el flujo de vídeo aplique a fotos.
- **Confirmado:** Page posts admiten `published=false` y `scheduled_publish_time`, entre 10 minutos y 30 días desde la solicitud; Facebook ejecuta la publicación futura en sus servidores.
- Las fuentes consultadas no publican un precio por llamada; eso no equivale a uso ilimitado ni elimina límites y políticas.
- **Pendiente:** confirmar si cada formato de foto/vídeo admite el mismo flujo de programación. La referencia confirma Page posts, pero no basta para prometer todos los subendpoints multimedia.

### Validación posterior (fuera del cierre de Fase 1)

En una fase de integración posterior y con autorización: configurar una Page de prueba, permisos mínimos y Page token seguro; enviar texto y formatos multimedia con carga confirmada; programar con `scheduled_publish_time`; verificar la publicación después de la hora indicada. Confirmar Advanced Access/App Review antes de admitir Pages externas. Esta prueba no es requisito para aprobar Fase 1.

**Fuentes oficiales consultadas**

- [Pages API: Posts](https://developers.facebook.com/documentation/pages-api/posts)
- [Video API: publicar en una Page y carga reanudable](https://developers.facebook.com/documentation/video-api/guides/publishing)
- [Permisos de Meta](https://developers.facebook.com/docs/permissions/)
- [App Review de Meta](https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review)

## 2. Instagram

### Cuenta, API y permisos

- **Confirmado:** la publicación por API es para cuentas profesionales Business o Creator, no personales.
- Para Instagram Login se documentan `instagram_business_basic` y `instagram_business_content_publish`.
- Meta documenta además un flujo con Facebook Login y permisos diferentes (`instagram_basic`, `instagram_content_publish`, `pages_read_engagement`, entre otros, y una Page vinculada). No se elige ni configura un flujo en esta tarea.
- Para usuarios fuera de roles de la app, permisos y app requieren revisión/acceso avanzado según el flujo.

### Contenido, medios, programación y límites

- La API permite fotos, vídeos/Reels y carruseles. El texto acompaña al contenido multimedia; no es un post de texto independiente.
- El flujo estándar de contenedor requiere una URL públicamente accesible desde la que Meta pueda obtener el medio.
- **Confirmado con condición:** la guía documenta carga local reanudable de vídeo/Reels a `rupload.facebook.com` en un flujo compatible; la variante descrita requiere condiciones específicas, incluido Facebook Login for Business para el tipo de carga reanudable.
- **Restricción/pending:** no generalizar esa carga local a imágenes ni a todas las variantes de login. Confirmar el flujo que la app autorizada permitirá.
- **Programación nativa no localizada:** las referencias describen creación de contenedor y `media_publish`, no un campo futuro que haga que Meta publique después. La programación por servidor LOP queda excluida por el requisito actual.
- La guía indica 100 publicaciones API por cuenta en un periodo móvil de 24 horas; expone endpoint para consultar uso. Hay además restricciones por formato.
- No se identificó tarifa por llamada en las fuentes consultadas; esto no promete uso ilimitado.

### Validación posterior (fuera del cierre de Fase 1)

Una integración solo debe programar en Instagram cuando se confirme oficialmente un mecanismo nativo que acepte fecha futura. Una publicación inmediata no valida esa condición. Carga local y formatos se verificarán en una fase posterior con app/cuenta autorizadas. Mientras no se documente programación nativa, la programación de Instagram queda bloqueada.

**Fuentes oficiales consultadas**

- [Instagram Platform: Content Publishing](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/content-publishing)
- [Content Publishing con Instagram Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/content-publishing)
- [Permisos de Instagram](https://developers.facebook.com/docs/permissions/)
- [App Review de Meta](https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review)

## 3. Threads

### Cuenta, API y permisos

- **Confirmado:** requiere una app Meta creada con Threads Use Case.
- Permisos: `threads_basic` y `threads_content_publish`.
- Threads testers pueden probar en desarrollo. Usuarios sin rol de la app requieren que la app esté publicada y los permisos aprobados por App Review.
- La autorización usa OAuth 2.0 y un Threads user access token. La documentación indica tokens cortos de una hora y largos de 60 días, sujetos a renovación y reglas de cuenta.

### Contenido, medios, programación y límites

- La API publica texto, imagen, vídeo y carrusel.
- **Restricción confirmada:** para imagen y vídeo, Threads obtiene el archivo de la URL indicada, que debe estar en un servidor públicamente accesible. No se documenta carga binaria local en el flujo revisado.
- Por ello, publicar fotos/vídeos solo desde un archivo local y sin ubicación pública temporal es incompatible con el flujo de Threads consultado.
- **Programación nativa no localizada:** la referencia revisada no documenta parámetro o endpoint de fecha futura. Crear y después publicar un contenedor no equivale a programarlo. Hay rate limits; el aplicable debe consultarse por endpoint/cuenta.
- No se encontró tarifa por llamada publicada en la fuente consultada; no implica uso ilimitado.

### Carga de imágenes y vídeos respetando la arquitectura

La publicación multimedia usa un flujo de dos pasos: crear un contenedor con `POST /{threads-user-id}/threads`, indicando `media_type=IMAGE` y `image_url` o `media_type=VIDEO` y `video_url`, y después publicar su id con `POST /{threads-user-id}/threads_publish`. Threads obtiene cada medio desde la URL pública; no se encontró endpoint oficial para cargar bytes desde un archivo local. La documentación recomienda esperar a que el contenedor termine de procesarse antes de publicar. En carruseles, cada elemento multimedia se prepara como contenedor por separado y después se publica el contenedor del carrusel.

- No se puede enviar foto/vídeo local respetando simultáneamente la regla de no almacenar medios en LOP y no exponer URL pública temporal.
- No se usará R2, otro bucket, relay público ni almacenamiento temporal como atajo.
- Bajo la arquitectura acordada, Threads solo podría usarse para texto en publicación inmediata; imagen/vídeo y programación futura quedan bloqueados hasta que exista un mecanismo oficial compatible o la propietaria apruebe otra política.
- No se encontró fecha futura para que Threads publique un contenedor más adelante.

### Validación posterior (fuera del cierre de Fase 1)

Si se autoriza la integración posteriormente, el texto puede probarse con un tester y scopes aprobados. Las fotos/vídeos están bloqueados por el requisito arquitectónico, no por falta de implementación. Una prueba de publicación inmediata no demostraría programación nativa.

**Fuentes oficiales consultadas**

- [Threads API: Get Started](https://developers.facebook.com/documentation/threads/get-started)
- [Threads API: Posts](https://developers.facebook.com/documentation/threads/posts)
- [Threads API: rate limiting](https://developers.facebook.com/documentation/threads/overview#rate-limiting)

## 4. TikTok

### Cuenta, API y permisos

- **Confirmado:** se requiere cuenta de desarrollador, app con Content Posting API y autorización de la persona que publica.
- La publicación directa requiere scope `video.publish`; se debe autorizar el scope.
- La aplicación debe consultar información del creador y mostrar opciones de privacidad/consentimiento; el creador da consentimiento explícito para enviar el contenido.
- Clientes no auditados publican en modo privado. Se requiere auditoría del cliente para quitar esa restricción.

### Contenido, medios, programación y límites

- Content Posting API cubre publicación de vídeos y fotos.
- Vídeo: `FILE_UPLOAD` inicia la transferencia del archivo local a TikTok; también existe `PULL_FROM_URL` para dominios verificados.
- Fotos: la guía de transferencia consultada documenta URL/dominio verificado. La carga binaria local de fotos queda pendiente de verificación.
- **Programación nativa no localizada:** el flujo revisado describe `FILE_UPLOAD`/`PULL_FROM_URL` y la publicación, pero no fecha futura para que TikTok publique después. El scheduler de LOP no será sustituto; la programación queda bloqueada.
- TikTok documenta límites por usuario, cliente y tasa, incluidos topes de publicaciones. Se deben verificar en el portal y durante la prueba.
- No se encontró precio por publicación en las referencias consultadas.

### Validación posterior (fuera del cierre de Fase 1)

Con autorización posterior: configurar app/cuenta de prueba, aprobar `video.publish`, completar OAuth, enviar vídeo local con consentimiento y consultar `publish_id`. El cliente no auditado limita la visibilidad a privada; auditar antes de prometer publicación pública. Una prueba inmediata no satisface programación nativa, que no se localizó en la API revisada.

**Fuentes oficiales consultadas**

- [Content Posting API: Get Started](https://developers.tiktok.com/doc/content-posting-api-get-started)
- [Direct Post API](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post)
- [Transferencia de medios](https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide)
- [Scopes de TikTok](https://developers.tiktok.com/doc/scopes-overview)
- [Auditoría de Content Posting API](https://developers.tiktok.com/application/content-posting-api)

## 5. YouTube

### Cuenta, API y permisos

- **Confirmado:** requiere proyecto Google Cloud, YouTube Data API v3 habilitada, OAuth 2.0 y autorización del propietario del canal.
- Scope de carga: `https://www.googleapis.com/auth/youtube.upload`.
- La cuota por defecto documentada incluye 100 llamadas `videos.insert` al día (cada inserción consume una unidad de ese bucket) y una cuota separada para otros endpoints.
- Cuotas ampliadas están sujetas al proceso de YouTube/API compliance; la cuota predeterminada no es ilimitada.

### Contenido, medios, programación y límites

- `videos.insert` sube vídeo y permite metadatos como título, descripción, privacidad y fecha de publicación.
- Se documenta carga reanudable desde archivo local.
- YouTube Data API revisada no es API general de posts de texto/fotografías para Community. La función documentada aquí es vídeo y sus metadatos; miniaturas tienen endpoint separado.
- `status.publishAt` permite que YouTube publique el vídeo en el futuro bajo condiciones documentadas, entre ellas que sea privado y nunca haya sido publicado. La red mantiene la programación en sus servidores.
- La referencia del método indica máximo de 256 GB para el archivo; las restricciones de cuenta, navegador y transferencia siguen aplicando.

### Validación posterior (fuera del cierre de Fase 1)

En una fase de integración posterior se podrá configurar proyecto/API, autorizar canal propio, subir un vídeo privado mediante carga reanudable y comprobar `status.publishAt`. La prueba debe respetar cuota y requisitos de YouTube. No es requisito ni se ejecutó para cerrar la documentación de Fase 1.

**Fuentes oficiales consultadas**

- [YouTube Data API: videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert)
- [Subir un vídeo](https://developers.google.com/youtube/v3/guides/uploading_a_video)
- [Cuota YouTube Data API](https://developers.google.com/youtube/v3/determine_quota_cost)
- [OAuth para YouTube Data API](https://developers.google.com/youtube/registering_an_application)
- [Formulario oficial de auditoría/cuota](https://support.google.com/youtube/contact/yt_api_form)

## 6. LinkedIn

### Cuenta, API y permisos

- **Confirmado:** publicación personal documentada usa OAuth 2.0 y `w_member_social`; LinkedIn indica habilitar el producto Share on LinkedIn para obtener el scope.
- Para publicar como organización se requiere el Posts API, identidad/URN de organización y rol adecuado. El acceso a Community Management y permisos organizacionales debe confirmarse en Developer Portal.
- La aprobación del flujo personal no implica que una app tenga acceso de organización.

### Contenido, medios, programación y límites

- Posts API admite contenido orgánico de texto y posts con imagen/vídeo.
- Imagen/vídeo se cargan con las APIs de assets de LinkedIn; el post usa el URN del asset. Se transfiere el archivo a LinkedIn, sin copia permanente necesaria en LOP.
- Posts API no hace scraping de URL para construir artículo; artículo y miniatura deben proporcionarse.
- **Programación nativa no localizada:** el Posts API consultado no documenta fecha futura. Verificar si otro producto/API oficial autorizado la ofrece; hasta entonces no programar publicaciones de LinkedIn con un scheduler de LOP.
- No se identificó tarifa por publicación en las fuentes consultadas; elegibilidad y rate limits deben confirmarse con el acceso otorgado.

### Validación posterior (fuera del cierre de Fase 1)

Cuando se autorice la integración se podrán probar OAuth, texto y assets con cuenta propia y permisos habilitados. Para organizaciones también se requiere producto, rol y elegibilidad. Una publicación inmediata no satisface programación remota: esta queda bloqueada hasta confirmar una API oficial que acepte fecha futura.

**Fuentes oficiales consultadas**

- [Share on LinkedIn](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin)
- [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-10)
- [Autenticación OAuth 2.0](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authentication)
- [Control de acceso a organizaciones](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role?view=li-lms-2026-10)

## 7. X

### Cuenta, API y permisos

- **Confirmado:** requiere cuenta de desarrollador, app/proyecto X API y autorización de usuario para escribir.
- `POST /2/tweets` usa contexto de usuario; OAuth 2.0 requiere scopes de escritura como `tweet.write` y lectura de usuario como `users.read`. La carga de medios tiene su propio flujo/scopes.
- No se crea app ni se compran créditos durante esta tarea.

### Contenido, medios, programación y límites

- Texto: `POST /2/tweets`.
- Imágenes, GIFs y vídeos: cargar archivo a la API de medios, recibir `media_id` y adjuntarlo al Post. Los vídeos usan carga por partes. Los límites dependen de formato y cuenta autenticada.
- El flujo transfiere medios locales a X, sin copia permanente de LOP.
- **Programación nativa no localizada:** el endpoint oficial de creación revisado no documenta fecha futura. No se usará programación del servidor LOP como sustituto.
- **Costo confirmado:** “Post: Create” figura a USD 0,015 por solicitud en la tabla oficial consultada; media y otros endpoints se cobran según su tarifa. Los precios cambian y deben revisarse antes de cualquier activación.
- X no satisface un costo inicial garantizado de USD 0. Queda desactivado hasta aprobación explícita, límite de gasto y desactivación de auto-recarga.

### Validación posterior (fuera del cierre de Fase 1)

X permanece desactivada mientras implique costos sin autorización. Solo con aprobación expresa podrán configurarse créditos/topes, OAuth y una prueba en cuenta propia. Las pruebas de publicación pertenecen a fases posteriores; una publicación inmediata no comprobaría programación nativa, que no se localizó en la API consultada.

**Fuentes oficiales consultadas**

- [Crear Posts](https://docs.x.com/x-api/posts/create-post)
- [Carga de medios X API v2](https://docs.x.com/x-api/media/introduction)
- [OAuth 2.0](https://docs.x.com/fundamentals/authentication/oauth-2-0/overview)
- [Precios X API](https://docs.x.com/x-api/getting-started/pricing)

## Hallazgos transversales

1. No hay una única forma de transferir medios. Facebook vídeo, ciertos flujos de Instagram, TikTok vídeo, LinkedIn y YouTube documentan cargas a la API; Threads exige URL pública y algunas rutas de Instagram/TikTok también dependen de URL.
2. No se puede publicar vídeo/foto de Threads desde archivo local sin una ubicación pública temporal. Si no se autoriza alojamiento temporal, el contenido multimedia de Threads queda bloqueado; la alternativa compatible es limitarlo a texto.
3. La programación no es uniforme. La documentación oficial revisada confirma programación remota para Facebook Pages y YouTube bajo condiciones específicas. En Instagram, Threads, TikTok, LinkedIn y X no se localizó fecha futura en las APIs públicas consultadas. Se necesita nueva evidencia oficial para esas redes o aceptar que el requisito universal todavía no está cubierto.
4. “Gratis” tiene límites distintos. X cobra por uso; YouTube tiene cuota limitada; Cloudflare tiene cuotas de plan; el acceso a Meta, TikTok y LinkedIn está sujeto a permisos/revisión.
5. YouTube Data API no ofrece en estas referencias un equivalente a post general de texto/foto.
6. Las pruebas de publicación corresponden a fases posteriores. No son requisito para aprobar la investigación documental de Fase 1 y no se ejecutaron.
