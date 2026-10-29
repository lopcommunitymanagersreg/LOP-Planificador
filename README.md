# LOP Planificador

Aplicación web local de LOP Planificador, construida con React y JavaScript, con una API Node.js/Express y persistencia SQLite por usuario. El acceso y los borradores se guardan en este equipo. Facebook Pages, canales de YouTube e Instagram profesional disponen de flujos OAuth oficiales opcionales; cada cuenta requiere autorización real del proveedor. Las demás conexiones sociales siguen siendo referencias locales.

## Ejecutar en local

Requisitos: Node.js 20 o superior y npm. Desde la carpeta del proyecto, instala las dependencias:

```sh
npm install
```

En Visual Studio Code, abre una terminal y ejecuta el comando único:

```sh
npm run dev:full
```

El comando inicia primero la API local en `127.0.0.1:3001` y, solo después de confirmar que obtuvo ese puerto, inicia Vite en `http://localhost:5173`. React siempre envía `/api` a la API del puerto 3001. Un segundo backend no puede enlazar ese mismo puerto: se detiene con un error claro y no se cambia silenciosamente a 3002. Si el puerto está ocupado, revisa qué proceso lo posee antes de cerrarlo; no detengas procesos Node ajenos a LOP. `Ctrl+C` en esa terminal cierra el frontend y el backend juntos. No expongas el servidor local a la red.

Los comandos `npm run server` y `npm run dev` quedan disponibles para diagnóstico por separado; para el uso normal, ejecuta únicamente `npm run dev:full`.

La base SQLite se crea automáticamente en `data/lop.sqlite`. Se puede cambiar su ubicación con la variable `LOP_DATABASE_PATH`. Los contadores de cuentas consultan SQLite en el servidor y se filtran por usuario, espacio y marca; la interfaz muestra esos totales al cargar y después de cambios en las cuentas. Las contraseñas se almacenan como hashes scrypt y la sesión usa una cookie `HttpOnly`. Los códigos se guardan como hashes, vencen a los 10 minutos y admiten hasta cinco intentos. No se guardan archivos multimedia.

### Google OAuth: configuración local

El acceso Google usa OAuth 2.0 oficial y solo se activa con credenciales reales. LOP permanecerá en localhost hasta que sus funciones estén terminadas, comprobadas y aprobadas. Se conserva el proyecto y cliente web existentes con audiencia **Usuarios externos / Prueba**. La publicación, el dominio, HTTPS, Cloudflare y la verificación OAuth pública corresponden exclusivamente a la fase final. La conexión local se describe en [YouTube en localhost](./docs/YOUTUBE-LOCALHOST.md); no requiere publicar la app OAuth.

1. Abre [Google Cloud Console](https://console.cloud.google.com/) e inicia sesión con la cuenta propietaria del proyecto local existente. Conserva ese proyecto; solo una instalación nueva necesita preparar su proyecto de desarrollo.
2. En **Google Auth Platform > Audiencia**, conserva **Usuarios externos / Prueba** y añade como usuario de prueba la cuenta Google que autorizará YouTube. El contador de usuarios OAuth no sustituye la comprobación de esta lista. No pulses **Publicar app**.
3. En **Clientes**, abre el cliente OAuth web local existente. Solo en una instalación nueva, crea un cliente de tipo **Aplicación web**.
4. Agrega `http://localhost:5173` en **Orígenes autorizados de JavaScript** y `http://localhost:5173/api/auth/google/callback` en **URI de redireccionamiento autorizados**. La dirección debe coincidir exactamente con el navegador y la URI que se configurará en LOP.
5. En una instalación nueva, usa `.env.example` para crear `.env` y configura `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` y `GOOGLE_REDIRECT_URI=http://localhost:5173/api/auth/google/callback`. En la instalación existente conserva `.env`; no lo sobrescribas ni compartas secretos en chats, capturas, Git o el navegador.
6. Cuando corresponda reiniciar, detén la ejecución actual con `Ctrl+C`, ejecuta `npm run dev:full` y abre `http://localhost:5173`. El botón de Google solo aparecerá si el servidor reconoce las credenciales. Inicia sesión con una cuenta permitida por la configuración de audiencia del proyecto.

Google permite los callbacks HTTP de localhost para este flujo. Los requisitos de [producción](./docs/YOUTUBE-PRODUCCION.md) quedan como referencia para la fase final y no bloquean esta conexión local. No se cambian dominios, clientes ni secretos para completar las pruebas actuales.

### Correo, verificación y recuperación

El registro con contraseña, la verificación y la recuperación requieren un servidor SMTP real. Para pruebas personales sin costo, una cuenta Gmail puede usar una contraseña de aplicación (requiere verificación en dos pasos); consulta los límites vigentes de Google. Completa `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` y `SMTP_FROM` en `.env`. OAuth de Google no habilita por sí solo el envío de correo. Si SMTP no está configurado o falla, el registro y la recuperación informan que el servicio no está disponible.

- La verificación y recuperación usan códigos de un solo uso, con caducidad de 10 minutos, límite de cinco intentos por código y un minuto entre reenvíos. Se limitan también los intentos por IP. Si un proveedor no está configurado o rechaza el envío, la aplicación informa que el método no está disponible.
- Google no se vincula automáticamente por coincidencia de correo. Para una cuenta de correo ya existente, inicia sesión primero con esa cuenta y elige **Vincular Google** en el menú del perfil. La vinculación exige la sesión vigente, correo confirmado por Google y que la identidad de Google no pertenezca a otra cuenta.
- Al iniciar o volver a iniciar sesión con Google, LOP actualiza en el perfil SQLite la URL HTTPS de fotografía incluida en el perfil oficial. La imagen no se descarga ni se almacena localmente; si Google no proporciona una foto, se muestra la inicial del nombre.
- Cerrar sesión solicita confirmación, intenta guardar los cambios pendientes, invalida todas las sesiones del usuario en SQLite y expira `lop_session` con los mismos atributos de cookie usados al crearla. Un fallo al guardar cambios pendientes ya no bloquea la revocación y se comunica al regresar al acceso; se espera la respuesta HTTP 204 antes de limpiar el estado React y reemplazar la navegación por `/`. Los demás navegadores comprueban la sesión cada cinco segundos y al volver a primer plano; al detectar la revocación regresan al acceso. Las respuestas API no se almacenan en caché y Atrás/recargar vuelve a validar la sesión.

### Espacios de trabajo, marcas y cuentas

- Cada usuario tiene espacios de trabajo propios y puede crear, seleccionar, renombrar y eliminar espacios. Se conserva al menos un espacio por usuario. Eliminar un espacio elimina en cascada sus marcas, referencias de cuentas y borradores asociados; perfiles y datos de otros espacios o usuarios no se alteran.
- Cada espacio inicia con una marca principal y permite agregar, editar y eliminar marcas. Las marcas guardan nombre, URL HTTPS del logotipo y configuración propia (descripción, sitio web y colores). El logotipo se muestra desde la URL y no se suben archivos multimedia a SQLite. Se conserva al menos una marca por espacio; al eliminar otra, sus cuentas y borradores se reasignan a una marca restante.
- Las cuentas se organizan por marca y espacio. Facebook Pages, canales de YouTube e Instagram profesional pueden conectarse con OAuth oficial; sus credenciales se cifran en SQLite. Las demás redes continúan como referencias locales no autorizadas.
- La migración crea un espacio y una marca inicial por usuario existente, asigna a ellos las cuentas y los borradores ya guardados, y conserva el contenido. El propietario se verifica en cada operación de API; no se aceptan identificadores de espacio o marca de otro usuario.

### Calendario y borradores

- El calendario ofrece vistas mensual, semanal y diaria con horarios, y filtros combinables por marca, red, estado interno y formato. El estado disponible es **Borrador local**; no se presentan elementos como programados o publicados en una red social.
- Los borradores pueden guardarse con fecha y hora o sin fecha. Al arrastrar uno a otro día u horario, la aplicación espera la respuesta del backend y solo confirma el cambio después de guardarlo en SQLite.
- El gestor de publicaciones organiza los borradores del espacio por marca, red social, estado local, formato y rango de fechas. Permite editar título, descripción, texto y hashtags, además de guardar variaciones y ajustes locales por cada red seleccionada. Una copia puede conservar su contenido y asignarse a otra marca del mismo espacio sin alterar el original.
- **Borrador sin fecha** y **Borrador planificado** son estados locales diferenciados. Los filtros muestran también los estados reservados de programada, publicada y fallida, pero no se asignan: requieren confirmación de las API oficiales, que aún no están conectadas.
- Las publicaciones y sus personalizaciones se guardan por usuario, espacio y marca en SQLite. La migración agrega los nuevos campos con valores predeterminados, conserva el texto, fechas, redes y formato existentes y mantiene todos los registros como borradores locales.
- Cada marca conserva su zona horaria. Al filtrar por una marca, las fechas y horas del calendario se muestran en esa zona; la exportación CSV usa la zona propia de cada marca.
- Las notas y los recordatorios se pueden crear, editar y eliminar, y quedan asociados en SQLite al usuario, espacio, marca y fecha. Se muestran en el calendario; no envían notificaciones fuera de la aplicación.
- La exportación genera un CSV con los borradores, formatos, redes, notas y recordatorios visibles. La base conserva los datos existentes al permitir borradores sin fecha.

La edición de contenido multimedia se limita a escoger un archivo en el navegador como referencia temporal; los archivos no se suben ni se guardan en SQLite. LOP no publica ni programa contenido. Las conexiones oficiales de Facebook, YouTube e Instagram solo identifican las páginas/canales/cuentas y sus permisos; no envían publicaciones.

Las cuentas sin autorización son referencias locales, no conexiones. Las conexiones OAuth muestran los datos y permisos registrados al autorizarse; el proveedor puede revocar después ese acceso. YouTube e Instagram permiten consultar de nuevo a su proveedor mediante **Verificar conexión**. Las cuentas se pueden reasignar entre espacios/marcas propios y eliminar localmente junto con sus credenciales cifradas. Esta fase acepta borradores; las estadísticas de publicaciones programadas o realizadas permanecen en cero. Los registros se guardan por elemento para evitar que una escritura atrasada de la lista borre cambios recientes.

### Conectar Facebook Pages (opcional)

Esta integración requiere una app de Meta propia; las credenciales no se solicitan ni se comparten por chat. Sin esas credenciales, la aplicación deja la conexión deshabilitada y no simula un resultado exitoso.

1. En [Meta for Developers](https://developers.facebook.com/), crea una app con el caso de uso de inicio de sesión de Facebook, añade el producto Facebook Login y registra `http://localhost:5173/api/connections/facebook/callback` como URI de redirección OAuth válida. El host, puerto y ruta deben coincidir exactamente con el navegador y `.env`.
2. Añade tu cuenta como persona con un rol en la app para las pruebas en modo Desarrollo. Las cuentas ajenas a los roles de prueba requieren publicar la app y obtener el acceso/revisión de permisos que Meta exija para el caso de uso. Una empresa puede tener que completar la verificación empresarial.
3. Copia `.env.example` como `.env` y configura `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `FACEBOOK_REDIRECT_URI=http://localhost:5173/api/connections/facebook/callback` y la versión Graph API vigente que muestre Meta en `META_GRAPH_API_VERSION`. Para la clave local de cifrado, genera 32 bytes aleatorios sin revelar el resultado:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

   Guarda el resultado en `SOCIAL_TOKEN_ENCRYPTION_KEY` dentro de `.env`, fuera de Git. Si pierdes esta clave, los tokens ya cifrados no podrán descifrarse. No cambies la clave sin migrar los tokens.
4. Reinicia `npm run dev:full`, inicia sesión, abre **Cuentas sociales** y usa **Conectar Facebook**. Autoriza `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` y `business_management`. LOP primero consulta `/me/businesses` y las páginas `owned_pages`/`client_pages` de cada portafolio; si el permiso no se concede, Business Manager no devuelve páginas/token, o la consulta falla, usa `/me/accounts` como alternativa oficial. Después del retorno OAuth, elige qué páginas conectar y asigna cada una a cualquier espacio y marca de tu cuenta.

La aplicación requiere `pages_show_list`, `pages_read_engagement` y `pages_manage_posts` para listar y administrar páginas; `business_management` se solicita para probar primero las consultas oficiales de Business Manager y es opcional para el fallback `/me/accounts`. El permiso `business_management` tiene dependencias `pages_read_engagement` y `pages_show_list`; Meta puede exigir App Review y Advanced Access para usuarios externos a los roles de prueba, y Business Verification para conceder Advanced Access. En la revisión describe que `pages_show_list` es el permiso principal y `business_management` solo se usa para encontrar páginas del portafolio; consulta la [referencia oficial de permisos](https://developers.facebook.com/documentation/development/permissions#business_management), la [referencia oficial de portafolios del usuario](https://developers.facebook.com/docs/graph-api/reference/user/businesses/), [páginas propias del portafolio](https://developers.facebook.com/docs/graph-api/reference/business/owned_pages/) y [páginas de clientes](https://developers.facebook.com/docs/graph-api/reference/business/client_pages/).

LOP pagina el listado de páginas devuelto por Meta, presenta una selección explícita y persiste solo las páginas confirmadas. Los tokens de la selección pendiente y los tokens de página se cifran con AES-256-GCM; la interfaz nunca recibe tokens. La selección temporal se vincula al usuario y su sesión, vence a los 30 minutos y se recupera automáticamente al volver a abrir la aplicación mientras siga vigente. Los errores OAuth conservan por 30 días únicamente su etapa, motivo y detalles de error de Meta, sin guardar códigos OAuth ni tokens. Los permisos e identificadores se guardan junto a cada conexión y el usuario puede reasignarla o eliminarla desde **Cuentas sociales**. Facebook puede invalidar tokens; no se promete renovación automática. Aunque se solicita el permiso necesario para gestionar publicaciones, esta fase no publica contenido: la publicación real corresponde a la Fase 3. La autorización real debe completarse en el navegador con una cuenta que tenga acceso a la app Meta.

### Conectar canales de YouTube (opcional)

El flujo reside en `server/youtube.js`, registrado desde `server/index.js`; sustituye el bloque anterior, sin mantener dos implementaciones OAuth. En desarrollo reutiliza el cliente Google existente y la clave `SOCIAL_TOKEN_ENCRYPTION_KEY`. Solicita únicamente `https://www.googleapis.com/auth/youtube.readonly`, con acceso `offline`, consentimiento e incorporación de permisos ya concedidos. No solicita `youtube.upload` ni publica vídeos.

La fase actual es exclusivamente local y mantiene **Usuarios externos / Prueba**. Deben comprobarse YouTube Data API v3 habilitada, el callback adicional en el cliente existente y la cuenta propietaria del canal en Usuarios de prueba. Los pasos exactos están en [YOUTUBE-LOCALHOST.md](./docs/YOUTUBE-LOCALHOST.md). Una conexión se considera real solo después del consentimiento, la comprobación del canal mediante la API y su persistencia; las pruebas con proveedores controlados no la certifican.

Para usar la conexión local cuando el proyecto permita la autorización, debe estar habilitada **YouTube Data API v3** y registrado el callback adicional `http://localhost:5173/api/connections/youtube/callback` en el cliente web local, conservando el callback de acceso Google. `YOUTUBE_REDIRECT_URI` puede definirlo expresamente; si se omite se deriva del origen de `GOOGLE_REDIRECT_URI`. No reemplaces credenciales ni la clave de cifrado existentes. En **Cuentas sociales > Conectar YouTube**, autoriza, revisa el ID/nombre del canal devuelto y confirma su asignación a un espacio y marca propios.

LOP valida el acceso con `getTokenInfo`: audiencia del cliente, scope concedido y caducidad. Antes de ofrecer canales comprueba que el refresh token pueda renovar el acceso. La selección se vincula al usuario/sesión, conserva el espacio y marca de origen y vence a los 30 minutos. Antes de guardar consulta de nuevo `channels.list(part=snippet,mine=true)`; no considera prueba de propiedad una URL o un nombre escrito manualmente.

**Verificar conexión**, disponible en el menú y detalle de YouTube, renueva el acceso con el refresh token propio de la conexión, comprueba el token y vuelve a confirmar el canal. Guarda las credenciales renovadas con AES-256-GCM y actualiza el identificador visible del canal y su última verificación. Un error temporal conserva el estado anterior; si Google rechaza la autorización o ya no confirma el canal, solicita reconectar. No se retira el acceso global de LOP a Google como reparación, porque podría afectar al inicio de sesión. La renovación ocurre al ejecutar estos flujos; no hay una tarea permanente en segundo plano ni garantía de tokens válidos para siempre.

En modo Prueba, la autorización de YouTube y su refresh token vencen a los siete días. En ese caso se usa **Conectar YouTube** de nuevo: al confirmar el mismo ID oficial se actualiza la conexión existente, sin duplicarla. La renovación de un access token no prolonga una autorización de prueba ya vencida.

El endpoint `POST /api/connections/:connectionId/verify` se comparte con Instagram y verifica solo una conexión propia del espacio activo. Se conservan las rutas `/api/connections/youtube/authorize`, `/callback`, `/selections/pending` y `/selections/:selectionId` (consulta, confirmación o cancelación). La migración añade `custom_url` y `verified_at` a las conexiones y `workspace_id`/`brand_id` a las selecciones, sin reemplazar los registros existentes.

`mine=true` no garantiza listar todas las cuentas de marca administradas desde un correo; debe comprobarse el canal autorizado. Ser invitado mediante permisos de YouTube Studio tampoco concede por sí solo acceso mediante YouTube APIs. Las condiciones oficiales y los pasos públicos están en [YOUTUBE-PRODUCCION.md](./docs/YOUTUBE-PRODUCCION.md). Las pruebas de `tests/youtube.test.js` usan proveedores controlados y SQLite temporal, además de las pruebas de regresión existentes; no certifican la configuración Cloud ni una conexión real.

### Conectar Instagram profesional (opcional)

El flujo implementado usa **Instagram API with Facebook Login**, con la misma app Meta de Facebook y una autorización separada. Reutiliza `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `META_GRAPH_API_VERSION` y `SOCIAL_TOKEN_ENCRYPTION_KEY`; no reemplaces esos valores ni sus tokens existentes. La disponibilidad del botón no confirma que una cuenta ya esté conectada: Meta debe autorizar los permisos y verificar la cuenta profesional vinculada.

La autorización real de Instagram permanece aplazada mientras se resuelve la validación SMS de Meta. Su implementación se conserva para retomarla; no se presenta como una conexión real completada.

1. Usa una cuenta **Instagram Business o Creator** vinculada a una página de Facebook que puedas administrar. Una cuenta personal no es compatible con este flujo. En la app Meta existente, comprueba que esté habilitado el acceso de Instagram con Facebook Login y que la cuenta tenga los roles necesarios para las pruebas en Desarrollo. Para usuarios externos, Meta puede exigir App Review, Advanced Access y verificación empresarial.
2. Registra `http://localhost:5173/api/connections/instagram/callback` como URI OAuth válida en esa app, conservando las URI de Facebook y las de Google/YouTube en sus respectivos clientes. `INSTAGRAM_REDIRECT_URI` es opcional: si se omite, LOP deriva ese callback del origen de `FACEBOOK_REDIRECT_URI`. El host, puerto y ruta deben coincidir exactamente. No hace falta volver a crear la app ni generar otra clave de cifrado.
3. Reinicia `npm run dev:full`, inicia sesión, selecciona una marca y abre **Cuentas sociales > Conectar Instagram**. Este botón solicita `instagram_basic`, `pages_show_list` y `pages_read_engagement`, además de `business_management` para consultar portafolios cuando se conceda. Este último es opcional para el listado por `/me/accounts`. No se solicita `instagram_content_publish`, no se publica contenido y el botón **Conectar Facebook** conserva su consentimiento propio.
4. Después del retorno, revisa el usuario de Instagram y la página vinculada. Selecciona primero una sola cuenta de prueba, asígnala a su espacio y marca, y confirma. LOP vuelve a consultar Meta antes de guardar; no basta con escribir un usuario manualmente ni con que la página figure en una conexión Facebook anterior. Comprueba esa cuenta antes de conectar la siguiente.
5. En el menú o detalle de la cuenta Instagram, usa **Verificar conexión**. La comprobación consulta `debug_token` para validar la app emisora, los permisos y las caducidades disponibles; también vuelve a consultar el vínculo `instagram_business_account` de la página y el perfil `id,username,name`. La interfaz muestra el usuario, la página y la última verificación. Si Meta deja de confirmar la autorización o el vínculo, pide reconectar; un fallo temporal conserva el estado anterior y permite reintentar.

LOP descubre páginas mediante Business Manager cuando se autoriza y mediante `/me/accounts`, y comprueba cada página con el consentimiento nuevo. Una conexión Facebook guardada y sus scopes son un registro de la autorización anterior: no prueban que `instagram_basic` siga concedido ni que el vínculo profesional sea accesible ahora. Un error OAuth o de permisos debe resolverse revisando la autorización y los activos permitidos en Meta y repitiendo **Conectar Instagram**; por sí solo no demuestra que un token haya vencido. No se marca una conexión como exitosa cuando Meta rechaza la comprobación.

Las tablas `instagram_oauth_states`, `instagram_account_selections` e `instagram_connections` se crean aparte de las conexiones Facebook. El estado OAuth es de un solo uso y tanto este como la selección temporal se vinculan al usuario/sesión y vencen a los 30 minutos. Los tokens y las selecciones se cifran con AES-256-GCM y no se devuelven al frontend. Solo se guardan las cuentas confirmadas y verificadas, aisladas por usuario, espacio y marca. No se garantiza acceso permanente ni renovación automática.

Rutas implementadas (requieren sesión, salvo el callback, que valida la sesión asociada al estado OAuth):

| Método | Ruta | Función |
|---|---|---|
| GET | `/api/connections/instagram/authorize` | Iniciar autorización para `brandId` del espacio activo. |
| GET | `/api/connections/instagram/callback` | Validar retorno y crear la selección de cuentas verificadas. |
| GET | `/api/connections/instagram/selections/pending` | Recuperar selecciones vigentes de la sesión. |
| GET | `/api/connections/instagram/selections/:selectionId` | Consultar una selección sin exponer tokens. |
| POST | `/api/connections/instagram/selections/:selectionId` | Verificar y guardar `accounts` con `providerAccountId`, `workspaceId` y `brandId`. |
| DELETE | `/api/connections/instagram/selections/:selectionId` | Cancelar una selección. |
| POST | `/api/connections/:connectionId/verify` | Verificar con Meta una conexión Instagram del espacio activo. |

Las rutas existentes `PATCH` y `DELETE /api/connections/:connectionId` también permiten reasignar o eliminar localmente una conexión Instagram. Las pruebas de `tests/instagram.test.js` usan respuestas controladas y una SQLite temporal para comprobar el flujo, sus límites de sesión/propiedad, el cifrado y los errores; no sustituyen la autorización y verificación reales en Meta.

Fuentes oficiales: [Instagram API con Facebook Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login), [inicio rápido](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/get-started), [permisos Meta](https://developers.facebook.com/documentation/development/permissions) y [colección oficial de Meta: páginas y tokens](https://www.postman.com/meta/instagram/request/0vuw3vk/get-access-tokens-of-pages-you-manage).

Para ejecutar las pruebas del backend:

```sh
npm test
```

Para comprobar la compilación de producción:

```sh
npm run build
```

## Ruta del proyecto

La versión 1.0 se considerará terminada después de completar las fases siguientes. Las fases móviles y comerciales se mantienen después de la web, según lo acordado.

### Fase 1 — Verificación técnica y diseño

1. Confirmar los siete canales iniciales: Facebook, Instagram, Threads, TikTok, YouTube, LinkedIn y X.
2. Verificar en documentación oficial, para cada canal, requisitos vigentes de cuenta, permisos, formatos, límites y revisión de aplicaciones.
3. Crear las aplicaciones de desarrollador y credenciales oficiales solo cuando el propietario de las cuentas esté listo; no compartir secretos en el código ni en el navegador.
4. Registrar las restricciones de costo, aprobación y publicación para cada API. X queda desactivado hasta aprobar cualquier posible costo.
5. Definir un flujo sin copias permanentes de medios en LOP. Al programar, el archivo se transfiere a la red y la fecha debe quedar aceptada en los servidores de esa red; después de esa confirmación el computador puede apagarse. Si la API oficial no ofrece programación nativa, esa red no se ofrecerá como programable: LOP no ejecutará la publicación futura como sustituto.
6. Acordar el modelo seguro de conexión: OAuth, permisos mínimos, protección de tokens y revocación.

**Resultado esperado:** matriz técnica confirmada y arquitectura autorizada antes de habilitar publicaciones reales.

### Fase 2 — Plataforma web funcional

1. Completar la experiencia web en español y el diseño blanco, celeste, azul y negro.
2. Implementar acceso de usuario y espacios/marcas.
3. Desarrollar calendario, borradores y metadatos de publicaciones; no conservar copias de archivos multimedia en servidores propios.
4. Implementar las conexiones oficiales OAuth y el panel de cuentas, después de tener credenciales y permisos de desarrollador.
5. Completar Facebook y YouTube con canales reales y la conexión de Instagram profesional mediante Meta, manteniendo separados los estados de borrador, programada, enviada, publicada y fallida.

**Resultado esperado:** aplicación web que permite gestionar el espacio, las conexiones y el calendario, inicialmente con una red de prueba.

### Fase 3 — Publicación automática

1. Integrar las APIs oficiales una por una, comenzando por la red cuyo acceso de prueba esté disponible.
2. Verificar requisitos de contenido y permisos antes de enviar cada publicación.
3. Implementar carga directa/reanudable cuando la plataforma lo permita, evitando almacenamiento permanente de medios.
4. Registrar identificadores de plataforma, resultado, fecha y errores.
5. Añadir reintentos limitados y seguros; no repetir automáticamente solicitudes cuando el resultado sea ambiguo.
6. Probar publicaciones y programaciones con cuentas propias antes de ampliar el acceso.

**Resultado esperado:** publicación verificable en cada plataforma que haya autorizado la integración.

### Fase 4 — Funciones avanzadas

1. Añadir publicaciones por lote y contenido recurrente respetando reglas específicas de cada red.
2. Incorporar analíticas e informes únicamente para métricas que las APIs concedan.
3. Añadir aprobaciones, colaboración y gestión de comentarios/mensajes donde existan permisos oficiales.
4. Implementar exportación y reportes, además del historial de auditoría.
5. Evaluar asistencia de redacción sin depender de servicios de pago; cualquier integración opcional se aprueba antes.

**Resultado esperado:** herramientas avanzadas habilitadas por canal, con límites claramente mostrados.

### Fase 5 — PWA y aplicaciones móviles obligatorias

1. Convertir la web estable en PWA instalable y probarla en distintos navegadores.
2. Evaluar notificaciones, funcionamiento sin conexión y límites de publicación de una PWA.
3. Después de completar y estabilizar la web, desarrollar las aplicaciones para Android e iOS. La tecnología de implementación (incluido Flutter/Dart u otra alternativa) se decidirá antes de iniciar ese trabajo.
4. Probar seguridad, inicio de sesión y publicación en dispositivos reales antes de distribuir.

**Resultado esperado:** PWA y aplicaciones Android/iOS probadas. Las aplicaciones móviles forman parte obligatoria de LOP Planificador 1.0 y se desarrollarán después de la web.

### Fase 6 — Suscripciones

1. Medir costos reales de infraestructura, soporte y APIs.
2. Diseñar planes, límites y tratamiento de pagos/impuestos.
3. Añadir facturación, administración comercial, límites por cuenta y herramientas de soporte.
4. Mantener una cuenta administrativa de desarrollo separada de los planes comerciales.

**Resultado esperado:** modelo de negocio basado en costos comprobados, no en supuestos.

### Fase 7 — Lanzamiento comercial

1. Hacer una prueba piloto con usuarios que hayan autorizado el acceso.
2. Medir fallos, tiempos, límites de API y costos; corregir antes de ampliar.
3. Publicar términos, privacidad, soporte y proceso para revocar conexiones/eliminar datos.
4. Lanzar gradualmente y supervisar errores y cambios de las APIs.
5. Declarar LOP Planificador 1.0 solo cuando las fases y criterios de aceptación acordados estén completos.

**Resultado esperado:** lanzamiento controlado y sostenible, sin prometer disponibilidad o gratuidad que dependa de terceros.

## Decisiones que deben confirmarse antes de publicar

- Las publicaciones programadas deben quedar aceptadas en los servidores de cada red. El medio se transfiere desde el computador al crear la programación; cuando la red confirma la recepción y la fecha, el computador puede apagarse. Si la API oficial no soporta programación nativa, LOP no sustituirá esa función con un proceso propio y mostrará que el canal no está disponible para programación.
- Las APIs, aprobaciones, permisos y tarifas pueden cambiar. Deben verificarse en fuentes oficiales al implementar cada integración.
- No se activarán servicios de pago ni se efectuarán cargos sin autorización expresa.
