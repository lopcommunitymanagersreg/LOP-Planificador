# Google OAuth y YouTube para usuarios reales

**Referencia aplazada a la FASE FINAL.** Por decisión del proyecto, LOP permanece en localhost y Google OAuth en **Usuarios externos / Prueba** hasta terminar, comprobar y aprobar sus funciones. Esta guía no es un requisito para conectar ahora un canal real y no autoriza publicar la app, configurar dominios, HTTPS o Cloudflare. Para el trabajo actual usar [YOUTUBE-LOCALHOST.md](./YOUTUBE-LOCALHOST.md).

La información de producción se conserva como referencia futura. No se han realizado cambios en Google Cloud, credenciales, conexiones ni base de datos para redactar esta guía.

## Estado conocido y objetivo

El proyecto funciona actualmente en localhost; todavía no se ha definido un dominio/despliegue público. El 27 de octubre de 2026 la propietaria revisó su consola y confirmó **Usuarios externos / Prueba**, un contador **0/100**, el botón **Publicar app** deshabilitado y una indicación de Google para completar **Desarrollo de la marca / Branding**. No encontró un estado de verificación visible. Son datos comunicados por la propietaria; esta revisión no accedió directamente a la consola autenticada. La habilitación de la API, los scopes aprobados y las URI registradas en los clientes siguen sin comprobarse.

| Elemento | Estado conocido y fuente | Objetivo público / comprobación pendiente |
|---|---|---|
| Aplicación | React, Express y SQLite; desarrollo en `localhost:5173` y API `127.0.0.1:3001`. | Dominio público y despliegue HTTPS pendientes. |
| OAuth YouTube | Flujo, selección, comprobación de audiencia/scopes/caducidad, renovación y verificación implementados. | Completar consentimiento y comprobar un canal real; una prueba controlada no lo certifica. |
| Audience | La propietaria confirma Usuarios externos / Prueba y contador mostrado 0/100. | External / In production para el proyecto público; Prueba es el estado actual de desarrollo, no el objetivo final. |
| Marca y publicación | La propietaria informa Publicar app deshabilitado y solicitud de completar Branding; no ve estado de verificación. | Identificar los campos obligatorios vacíos; después revisar por separado la verificación/publicación de marca y la publicación de Audience. |
| Dominio | La propietaria confirma solo localhost y ningún dominio público definido. | Home, privacidad y términos públicos; dominio propio verificado. |
| YouTube Data API v3 | Estado Enabled/Disabled no comprobado en consola. | Comprobarlo en el proyecto que corresponda. |
| Scopes | El código pide `youtube.readonly`; categoría/aprobación de Data Access no comprobadas en consola. | Declararlo y obtener aprobación para el uso público. |
| Clientes OAuth | El código define sus callbacks; las URI registradas en Cloud no se han comprobado. | Contrastar las URI del cliente local y, por separado, las del futuro cliente público. |
| Renovación | Refresh token cifrado, comprobación y actualización al conectar/confirmar/verificar. | Mantener acceso mientras Google lo autorice; reconexión cuando deje de ser válido. |

Publicar Audience, publicar la marca y aprobar los scopes son estados distintos. Una aplicación External/In production que solicita permisos sensibles sin aprobar puede mostrar advertencias y quedar limitada a 100 usuarios nuevos durante la vida del proyecto. El acceso público no elimina las políticas de las cuentas u organizaciones que autorizan. [Google: Audience y límites](https://support.google.com/cloud/answer/15549945).

## Fase final: revisar Branding sin cambiar credenciales

Abrir [Branding / Desarrollo de la marca](https://console.cloud.google.com/auth/branding) en el proyecto actual. Primero identificar qué campos aparecen marcados como obligatorios y están vacíos, y el texto de cualquier aviso. Comunicar esos nombres de campos y avisos antes de indicar que se guarde el formulario; no se ha comprobado todavía cuáles faltan. Esta revisión no necesita crear un cliente o secreto, cambiar el ID existente ni editar `.env`.

| Campo | Qué revisar o preparar |
|---|---|
| Nombre de la aplicación | **LOP Planificador**; comprobar el valor que ya muestra la ficha. |
| Correo de asistencia al usuario | Conservar o seleccionar un correo válido ya existente que se supervise y pueda usarse para soporte; no publicar aquí su dirección. |
| Información de contacto del desarrollador | Revisar el contacto existente para recibir comunicaciones de Google; no sustituirlo sin revisar con la propietaria. |
| Logotipo | Opcional; no hace falta inventar o subir uno para identificar los campos obligatorios pendientes. |
| Página de inicio, privacidad y términos | Requieren URLs reales y públicas del dominio acordado. Siguen pendientes; no rellenarlas con localhost ni direcciones inventadas. |
| Dominios autorizados | Revisar lo mostrado y preparar la propiedad del futuro dominio real; no presentarlo como verificado antes de comprobarlo. |

La guía de Google distingue **Verify Branding / Publish branding** en Branding, **Publish app** en Audience y la aprobación de scopes en **Data access status**. Completar o guardar datos no equivale a ninguno de esos resultados. Revisar con la propietaria los valores y campos pendientes antes de guardar; publicar marca, cambiar Audience o enviar verificación son pasos posteriores que también requieren su revisión. [Configuración y estados oficiales de Branding](https://support.google.com/cloud/answer/15549049).

## Lista ordenada para preparar producción

Estos pasos se revisan con la propietaria antes de crear recursos, cambiar ajustes críticos, publicar o enviar una solicitud. No son acciones ya realizadas ni confirman que falte un ajuste concreto en Cloud.

1. **Conservar desarrollo y decidir el entorno público.** Mantener intactos el proyecto/cliente local, `.env`, sus callbacks y las conexiones existentes. Acordar el dominio real, alojamiento y responsables. Preparar un proyecto Google Cloud y cliente web separados para producción: las políticas de Google separan entornos y excluyen del cliente público los orígenes/callbacks accesibles solo al equipo. No resolverlo borrando ahora el cliente local. [Políticas de producción](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance).
2. **Publicar información verificable de LOP.** La home HTTPS debe abrir sin iniciar sesión, identificar LOP y explicar sus funciones y acceso a datos. Preparar enlaces públicos propios de privacidad y términos; la guía actual de Branding solicita esos enlaces para aplicaciones externas de producción. La política debe corresponder al tratamiento real de datos Google y estar enlazada desde la home y el consentimiento. [Branding](https://support.google.com/cloud/answer/15549049), [requisitos de home](https://support.google.com/cloud/answer/13807376).
3. **Verificar los dominios y responsables.** En [Google Search Console](https://search.google.com/search-console), verificar la propiedad con una cuenta que también sea Owner o Editor del proyecto de producción. En Branding, declarar los dominios de home, privacidad, términos, callbacks y orígenes. Mantener correo de soporte, contactos de desarrollo y Owners/Editors accesibles y actualizados. [Requisitos de verificación](https://support.google.com/cloud/answer/13464321), [propiedad de dominio](https://support.google.com/cloud/answer/13804266).
4. **Habilitar la API del proyecto público.** Comprobar/habilitar **YouTube Data API v3** en su biblioteca. Google Sign-In operativo no demuestra que esté habilitada. No activar facturación o productos adicionales como parte de una comprobación. [Primeros pasos oficiales](https://developers.google.com/youtube/data/getting-started).
5. **Preparar el cliente Web application de producción.** Registrar el origen HTTPS real y sus callbacks exactos de Google y YouTube. Las siguientes son plantillas, no direcciones configuradas ni un dominio elegido:

   ```text
   https://<dominio-real>/api/auth/google/callback
   https://<dominio-real>/api/connections/youtube/callback
   ```

   Configurar sus credenciales mediante el gestor de secretos o las variables del entorno público, con sus `GOOGLE_REDIRECT_URI`/`YOUTUBE_REDIRECT_URI`. Con `NODE_ENV=production`, LOP rechaza estos callbacks si usan HTTP o localhost. `server/load-env.cjs` conserva las variables Google inyectadas en producción, sin sustituirlas por `.env` local; desarrollo mantiene su prioridad histórica de `.env`. Mantener ambos entornos separados: no copiar `.env` de desarrollo sobre producción ni sobrescribir el local con credenciales de producción. Tampoco mover tokens entre proyectos como si fueran intercambiables. [OAuth web y coincidencia del callback](https://developers.google.com/youtube/data/guides/auth/server-side-web-apps).
6. **Revisar Audience y Data Access.** En el proyecto público, preparar **External / In production**, sin usar una lista de testers como mecanismo para usuarios finales. Declarar los scopes de identidad utilizados y `youtube.readonly`; comprobar su categoría visible. Este permiso da lectura de la cuenta YouTube y es sensible; `youtube.upload` corresponde a otra capacidad y no se solicita ahora. Justificar la lectura necesaria para identificar y conectar el canal propio; no prometer publicaciones todavía. [Scopes oficiales](https://developers.google.com/identity/protocols/oauth2/scopes#youtube), [clasificación confirmada por Google](https://issuetracker.google.com/issues/573256244), [Data Access](https://support.google.com/cloud/answer/15549135).
7. **Completar marca y verificación de datos.** Revisar antes de aplicar la publicación de Audience. En Branding, completar y verificar la ficha, revisar el resultado y publicar la marca cuando corresponda. En Verification Center, consultar por separado **Branding status** y **Data access status** y preparar la solicitud de los scopes. La guía actual exige marca publicada para solicitar la verificación de datos. Publicar la aplicación no equivale a que Google haya aprobado esos permisos. [Verificación de permisos sensibles](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).
8. **Preparar una demostración real y enviar tras revisión.** Grabar el flujo de LOP, el acceso Google y la conexión YouTube, mostrando el consentimiento completo en inglés, la app/cliente correctos y el uso de cada permiso solicitado. Mostrar cómo se identifica el canal y se confirma su conexión; no simular publicación. Compartir con Google un vídeo accesible según las instrucciones del expediente, sin secretos ni datos de otras personas. Revisar justificación, URLs y alcance con la propietaria antes del envío y atender los requerimientos posteriores de Google. [Demostración oficial](https://support.google.com/cloud/answer/13804565), [envío de verificación](https://support.google.com/cloud/answer/13461325).
9. **Validar antes de abrir a usuarios.** Tras las aprobaciones y el despliegue autorizado, completar el flujo desde la URL pública con un canal propio, verificar ID/nombre, confirmar asignación y ejecutar **Verificar conexión**. Comprobar el estado de aprobación de los scopes realmente solicitados; una marca aprobada no cubre automáticamente permisos nuevos. Conservar desarrollo y sus datos durante esta validación. [Cambios de scopes y advertencias](https://support.google.com/cloud/answer/13463817).

## Enlaces y datos para comprobar la configuración real

Abrir con la cuenta administradora y seleccionar expresamente el proyecto correcto:

| Página oficial | Revisar sin compartir secretos |
|---|---|
| [Audience](https://console.cloud.google.com/auth/audience) | User type, Publishing status y contador OAuth user cap. |
| [Branding](https://console.cloud.google.com/auth/branding) | Nombre, URLs públicas, dominios autorizados y estado de marca publicada. |
| [Data Access](https://console.cloud.google.com/auth/scopes) | Scopes declarados, categorías y permisos aprobados. |
| [Verification Center](https://console.cloud.google.com/auth/verification) | Branding status, Data access status y observaciones del expediente. |
| [Clients](https://console.cloud.google.com/auth/clients) | Tipo Web application, orígenes y callbacks; no copiar client secrets. |
| [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com) | Estado Enabled/Disabled dentro del proyecto seleccionado. |

Para cotejar el estado bastan el dominio público elegido, las URLs de home/privacidad/términos, los estados anteriores y la lista de scopes/callbacks. No se necesitan contraseñas, secretos de cliente, códigos OAuth, tokens ni la clave de cifrado.

## Renovación y reconexión

LOP usa `google-auth-library`, acceso `offline` y consentimiento. El módulo `server/youtube.js` reemplaza el antiguo bloque de rutas de `server/index.js`; este último conserva la configuración y registra el módulo. No hay dos implementaciones del callback.

El código comprueba con `getTokenInfo` que el acceso pertenezca al cliente configurado, incluya `youtube.readonly` y no esté vencido. En el callback y en **Verificar conexión** prueba la renovación real; al confirmar una selección renueva si hace falta y vuelve a consultar el canal. El refresh token propio se conserva cuando Google no devuelve uno nuevo. Las credenciales actualizadas se cifran con AES-256-GCM en SQLite y no se entregan al navegador. No hay un proceso permanente que renueve todas las cuentas en segundo plano.

El endpoint `POST /api/connections/:connectionId/verify` atiende YouTube e Instagram y exige que la conexión pertenezca al usuario y espacio activo. La migración añade `custom_url` y `verified_at` a `youtube_connections`, y `workspace_id`/`brand_id` a `youtube_channel_selections`; conserva cuentas y credenciales anteriores.

Si falla el token de acceso o llega un HTTP 401, el flujo intenta renovar de forma limitada. Cuando Google rechaza definitivamente la renovación (`invalid_grant`), faltan permisos o ya no confirma el canal, se solicita reconexión. Los fallos temporales o de API deshabilitada conservan el estado anterior. Usar **Conectar YouTube** para autorizar de nuevo; no revocar globalmente LOP en Google como reparación, porque la revocación puede invalidar los permisos y tokens de los clientes del proyecto, incluido el acceso Google. [OAuth y revocación](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke).

El estado External/Testing impone siete días a la autorización YouTube y a su refresh token. Esa regla de Testing no se aplica a nuevas autorizaciones de producción, pero ningún estado garantiza tokens permanentes: pueden revocarse, caducar por otras condiciones o dejar de ser válidos. No asumir que cambiar Audience recupera un refresh token vencido; completar una autorización nueva cuando sea necesario. [Caducidad de tokens](https://developers.google.com/identity/protocols/oauth2#expiration).

## Identidad del canal y límites de las pruebas

`channels.list(part=snippet,mine=true)` devuelve los canales propios del usuario autenticado por el token. No es una búsqueda por nombre ni garantiza enumerar todos los Brand Accounts administrados desde el mismo correo. `managedByMe` se reserva a partners CMS. Revisar siempre el ID/nombre del canal devuelto. [Referencia oficial](https://developers.google.com/youtube/data/reference/rest/v3/channels/list).

Las cuentas de marca pueden producir una selección distinta en aplicaciones de terceros. Una invitación mediante permisos de YouTube Studio permite funciones de Studio, pero por sí sola no concede acceso a YouTube APIs; no equivale a la identidad OAuth propietaria del canal. [Cuentas de marca](https://support.google.com/youtube/answer/3046478?hl=es), [permisos de canal](https://support.google.com/youtube/answer/9481328?hl=en).

`tests/youtube.test.js` contiene escenarios controlados de autorización, propiedad, permisos, cifrado, renovación, errores y conservación de datos, además de las protecciones de callbacks y carga de variables de producción. Se complementa con la regresión del backend existente y pruebas Instagram. Estas pruebas no inspeccionan Cloud, no otorgan aprobación de Google ni prueban una conexión de producción. La interfaz permite conectar, seleccionar/asignar y verificar un canal; la publicación y subida de vídeos siguen fuera de esta implementación.
