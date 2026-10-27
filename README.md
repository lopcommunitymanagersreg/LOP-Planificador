# LOP Planificador

Aplicación web local de LOP Planificador, construida con React y JavaScript, con una API Node.js/Express y persistencia SQLite por usuario. El acceso y los borradores se guardan en este equipo. Facebook Pages y canales de YouTube disponen de conexiones OAuth oficiales opcionales; Instagram está en preparación y las demás conexiones sociales siguen siendo referencias locales.

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

### Configurar Google OAuth oficial sin costo

El acceso Google usa OAuth 2.0 oficial y solo se activa con credenciales reales. Para una prueba local no se necesita habilitar APIs de pago ni configurar facturación.

1. Abre [Google Cloud Console](https://console.cloud.google.com/) e inicia sesión con la cuenta propietaria del proyecto. Crea un proyecto o selecciona uno existente.
2. Abre **Google Auth Platform** (en algunas cuentas todavía aparece como **APIs y servicios > Pantalla de consentimiento OAuth**). Completa el nombre y correo de soporte. Para probar con cuentas personales, elige audiencia **Externa**, deja la aplicación en **Prueba** y agrega tu correo como usuario de prueba.
3. En **Clientes**, crea un cliente OAuth de tipo **Aplicación web**.
4. Agrega `http://localhost:5173` en **Orígenes autorizados de JavaScript** y `http://localhost:5173/api/auth/google/callback` en **URI de redireccionamiento autorizados**. La dirección debe coincidir exactamente con el navegador y la URI que se configurará en LOP.
5. Copia `.env.example` como `.env` en la carpeta del proyecto. Completa `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` y `GOOGLE_REDIRECT_URI=http://localhost:5173/api/auth/google/callback`. No compartas ni pegues el secreto en chats, capturas, Git o el navegador.
6. Guarda `.env`, detén la ejecución actual con `Ctrl+C`, ejecuta `npm run dev:full` y abre `http://localhost:5173`. El botón de Google solo aparecerá si el servidor reconoce las credenciales. Inicia sesión con la cuenta agregada como usuario de prueba.

La configuración de consentimiento en modo Prueba limita quién puede iniciar sesión; para una aplicación pública, Google puede exigir verificación. Consulta la [guía oficial de OAuth para aplicaciones web](https://developers.google.com/identity/protocols/oauth2/web-server). Si cambias el puerto o el host de Vite, actualiza tanto el origen autorizado como la URI de redirección en Google y `GOOGLE_REDIRECT_URI`.

### Correo, verificación y recuperación

El registro con contraseña, la verificación y la recuperación requieren un servidor SMTP real. Para pruebas personales sin costo, una cuenta Gmail puede usar una contraseña de aplicación (requiere verificación en dos pasos); consulta los límites vigentes de Google. Completa `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` y `SMTP_FROM` en `.env`. OAuth de Google no habilita por sí solo el envío de correo. Si SMTP no está configurado o falla, el registro y la recuperación informan que el servicio no está disponible.

- La verificación y recuperación usan códigos de un solo uso, con caducidad de 10 minutos, límite de cinco intentos por código y un minuto entre reenvíos. Se limitan también los intentos por IP. Si un proveedor no está configurado o rechaza el envío, la aplicación informa que el método no está disponible.
- Google no se vincula automáticamente por coincidencia de correo. Para una cuenta de correo ya existente, inicia sesión primero con esa cuenta y elige **Vincular Google** en el menú del perfil. La vinculación exige la sesión vigente, correo confirmado por Google y que la identidad de Google no pertenezca a otra cuenta.
- Al iniciar o volver a iniciar sesión con Google, LOP actualiza en el perfil SQLite la URL HTTPS de fotografía incluida en el perfil oficial. La imagen no se descarga ni se almacena localmente; si Google no proporciona una foto, se muestra la inicial del nombre.
- Cerrar sesión solicita confirmación, intenta guardar los cambios pendientes, invalida todas las sesiones del usuario en SQLite y expira `lop_session` con los mismos atributos de cookie usados al crearla. Un fallo al guardar cambios pendientes ya no bloquea la revocación y se comunica al regresar al acceso; se espera la respuesta HTTP 204 antes de limpiar el estado React y reemplazar la navegación por `/`. Los demás navegadores comprueban la sesión cada cinco segundos y al volver a primer plano; al detectar la revocación regresan al acceso. Las respuestas API no se almacenan en caché y Atrás/recargar vuelve a validar la sesión.

### Espacios de trabajo, marcas y cuentas

- Cada usuario tiene espacios de trabajo propios y puede crear, seleccionar, renombrar y eliminar espacios. Se conserva al menos un espacio por usuario. Eliminar un espacio elimina en cascada sus marcas, referencias de cuentas y borradores asociados; perfiles y datos de otros espacios o usuarios no se alteran.
- Cada espacio inicia con una marca principal y permite agregar, editar y eliminar marcas. Las marcas guardan nombre, URL HTTPS del logotipo y configuración propia (descripción, sitio web y colores). El logotipo se muestra desde la URL y no se suben archivos multimedia a SQLite. Se conserva al menos una marca por espacio; al eliminar otra, sus cuentas y borradores se reasignan a una marca restante.
- Las cuentas se organizan por marca y espacio. Facebook Pages y canales de YouTube pueden conectarse con OAuth oficial; sus credenciales se cifran en SQLite. Instagram está preparado para una conexión posterior con cuentas profesionales; las demás redes continúan como referencias locales no autorizadas.
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

La edición de contenido multimedia se limita a escoger un archivo en el navegador como referencia temporal; los archivos no se suben ni se guardan en SQLite. LOP no publica ni programa contenido. Las conexiones oficiales de Facebook y YouTube solo identifican las páginas/canales y sus permisos; no envían publicaciones.

Las cuentas sin autorización son referencias locales, no conexiones. Facebook y YouTube muestran el estado y permisos reales; sus cuentas se pueden reasignar entre espacios/marcas propios y eliminar localmente junto con sus credenciales cifradas. Esta fase acepta borradores; las estadísticas de publicaciones programadas o realizadas permanecen en cero. Los registros se guardan por elemento para evitar que una escritura atrasada de la lista borre cambios recientes.

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

La conexión reutiliza el ID, secreto y pantalla de consentimiento OAuth de Google ya configurados para el acceso de LOP. YouTube requiere una URI de retorno adicional en ese mismo cliente. El permiso de conexión es `https://www.googleapis.com/auth/youtube.readonly`; permite listar los canales propios/autorizados y no publicar. LOP requiere un token renovable para guardar la conexión, conserva las credenciales cifradas con la clave `SOCIAL_TOKEN_ENCRYPTION_KEY` y nunca devuelve tokens al frontend.

1. En el proyecto ya usado en [Google Cloud Console](https://console.cloud.google.com/), habilita **YouTube Data API v3**.
2. En **Google Auth Platform > Clientes**, abre el mismo cliente OAuth de tipo **Aplicación web** usado por Google Sign-In. Agrega `http://localhost:5173/api/connections/youtube/callback` como URI de redireccionamiento autorizada. Mantén también las URI existentes de acceso Google y Facebook sin cambios.
3. En **Google Auth Platform > Audiencia**, para pruebas deja la aplicación en **Prueba** y agrega como usuario de prueba cada cuenta Google que autorizará YouTube. La autorización real se completa en el navegador con esa cuenta.
4. Verifica que `.env` ya tenga el ID/secreto OAuth de Google y `SOCIAL_TOKEN_ENCRYPTION_KEY`. Si corresponde, configura `YOUTUBE_REDIRECT_URI=http://localhost:5173/api/connections/youtube/callback`; no reemplaces el secreto ni la clave de cifrado existentes. Reinicia `npm run dev:full`.
5. Inicia sesión, abre **Cuentas sociales** y selecciona **Conectar YouTube**. Google devuelve los canales a los que tiene acceso esa cuenta; marca los deseados y asígnalos a espacios/marcas. El listado y los contadores se leen desde SQLite.

Consulta la [guía oficial de OAuth para aplicaciones web de servidor](https://developers.google.com/youtube/data/guides/auth/server-side-web-apps), [autorización OAuth de Google](https://developers.google.com/identity/protocols/oauth2/web-server), [channels.list](https://developers.google.com/youtube/v3/docs/channels/list), [activación de YouTube Data API](https://developers.google.com/youtube/v3/getting-started) y [videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert). La API tiene cuota diaria y Google puede exigir verificación/revisión de la aplicación para el acceso externo o scopes sensibles. La Fase 3 deberá solicitar `youtube.upload` mediante autorización incremental antes de subir videos; los uploads consumen cuota de API y no se habilitan en este paso. YouTube aplica restricciones específicas a videos de clientes API no auditados, incluido su nivel de privacidad, que se deberán comprobar al implementar publicación automática.

### Preparación de Instagram Graph API

Se conserva el flujo de Facebook Pages como está. La ruta prevista es Instagram API con Facebook Login y la aplicación Meta existente: autorizar por separado los permisos de Instagram, consultar en cada página `instagram_business_account`, comprobar la cuenta profesional vinculada y guardar la cuenta/credenciales con el mismo aislamiento por usuario, cifrado y asignación a espacio/marca. La conexión de Instagram todavía no está habilitada y no aparece como exitosa.

Requisitos oficiales identificados:

- Solo cuentas **Instagram Business o Creator**; una cuenta personal no es compatible con Instagram API con Facebook Login.
- La cuenta profesional debe estar vinculada a una página de Facebook que el usuario pueda administrar. La consulta del campo `instagram_business_account` permite detectar la vinculación.
- Para identificación básica, preparar `instagram_basic`, `pages_show_list` y `pages_read_engagement`. La Fase 3 solicitará `instagram_content_publish` de forma incremental para publicar; moderación y métricas requieren permisos adicionales como `instagram_manage_comments` e `instagram_manage_insights`, solo si se aprueban esas funciones.
- En Meta for Developers se debe habilitar/configurar Instagram Graph API y Facebook Login, agregar usuarios de prueba/roles en Desarrollo y registrar la URI exacta de retorno OAuth. Para dar servicio a cuentas fuera de los roles de la app pueden exigirse App Review, Advanced Access y verificación empresarial. No se agregan los permisos de Instagram al consentimiento actual de Facebook, para no alterar las dos páginas ya conectadas.

Fuentes oficiales: [Instagram API con Facebook Login y limitaciones](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login), [inicio rápido](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/get-started), [permisos Meta](https://developers.facebook.com/documentation/development/permissions) y [publicación de contenido](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/content-publishing).

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
5. Completar Facebook y YouTube con canales reales y dejar Instagram preparado sobre Meta, manteniendo separados los estados de borrador, programada, enviada, publicada y fallida.

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
