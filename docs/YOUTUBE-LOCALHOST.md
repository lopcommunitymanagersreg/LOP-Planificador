# Conexión real de YouTube en localhost

## Alcance actual

La plataforma permanece en localhost hasta terminar y aprobar sus funciones. Se conserva el proyecto Google Cloud y cliente OAuth web existentes. OAuth continúa en **Usuarios externos / Prueba**. Publicación, dominio, HTTPS, Cloudflare y verificación para usuarios públicos pertenecen a la fase final.

## Intervención necesaria en Google Cloud

Con la cuenta administradora y el proyecto correcto seleccionados:

1. En [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com), comprobar que esté habilitada. Si aparece **Habilitar**, activarla; si aparece **Administrar**, ya está habilitada. No se requiere subir vídeos para comprobar la conexión.
2. En [Clientes](https://console.cloud.google.com/auth/clients), abrir el cliente web existente y añadir exactamente `http://localhost:5173/api/connections/youtube/callback` a sus URI de retorno. Conservar `http://localhost:5173/api/auth/google/callback` y las demás URI existentes. No crear otro cliente ni rotar su secreto.
3. En [Audiencia](https://console.cloud.google.com/auth/audience), conservar **Usuarios externos / Prueba** y añadir a **Usuarios de prueba** la cuenta Google que posee el canal. El contador de usuarios OAuth no demuestra por sí solo que esa cuenta esté en la lista. No cambiar el estado a Producción.

El callback de YouTube ya se deriva del origen de `GOOGLE_REDIRECT_URI` si no se define `YOUTUBE_REDIRECT_URI`. No hace falta sobrescribir `.env` para repetir un valor que ya coincide. No compartir secretos, códigos OAuth ni tokens.

## Autorizar, comprobar y guardar

1. Iniciar LOP con `npm run dev:full` y abrir `http://localhost:5173`.
2. Iniciar sesión, elegir el espacio y la marca correctos y entrar en **Cuentas sociales > Conectar YouTube con Google**.
3. Autorizar con la cuenta Google propietaria del canal. Si Google ofrece seleccionar una cuenta de marca/canal, comprobar que sea la deseada. El código solo solicita `https://www.googleapis.com/auth/youtube.readonly`, con acceso offline; no solicita subir vídeos.
4. Al regresar, comprobar el ID oficial, nombre y usuario del canal devueltos por YouTube. `channels.list(part=snippet,mine=true)` prueba el acceso al canal propio de esa autorización. Cuando se necesite contrastar un usuario solicitado, `channels.list(part=snippet,forHandle=...)` permite comparar su ID oficial con el canal autorizado; no sustituye la comprobación de propiedad con `mine=true`.
5. Confirmar únicamente el canal verificado y su espacio/marca. El backend consulta de nuevo la API antes de guardar y evita duplicados mediante el ID oficial por usuario.
6. Usar **Verificar conexión** para probar la renovación y confirmar de nuevo el canal. Comprobar su recuperación después de reiniciar los servidores.

La selección temporal y las credenciales se cifran con AES-256-GCM, se vinculan a usuario/sesión y nunca se entregan al navegador. La selección vence a los treinta minutos; una selección pendiente no es una conexión guardada.

Inicio muestra los nombres del espacio y de la marca activos. La selección de marca se guarda por usuario y espacio en SQLite. **Sin marca seleccionada** muestra las cuentas de todo el espacio; no elimina ni reasigna ninguna cuenta. Para conectar una cuenta nueva hay que elegir una marca.

**Verificar conexión** muestra progreso y un resultado persistente en la tarjeta y en el detalle de la cuenta, incluso si las notificaciones visuales están desactivadas. Los errores temporales del proveedor conservan la conexión. Una autorización vencida ofrece **Reconectar YouTube**, usando el mismo canal y evitando duplicados al completar OAuth.

## Renovación y reconexión en Prueba

El access token se renueva automáticamente cuando lo necesita el flujo y se fuerza una renovación al verificar la conexión. El refresh token se conserva cifrado y no se pierde cuando Google devuelve solo un access token nuevo.

En modo Prueba, la autorización de YouTube y el refresh token vencen a los siete días. La renovación no elimina ese límite. Si Google rechaza el grant o ya no confirma el canal, la interfaz pide reconectar mediante **Conectar YouTube**. Confirmar el mismo canal actualiza sus credenciales sin duplicar la cuenta. No revocar globalmente el acceso de LOP a Google como reparación: puede afectar al inicio de sesión existente.

Un fallo temporal o la API deshabilitada no elimina las conexiones guardadas. Las pruebas controladas de código no demuestran una conexión real: la comprobación final debe usar la API y los datos persistidos del canal autorizado.

## Fuentes oficiales

- [OAuth de servidor para YouTube](https://developers.google.com/youtube/data/guides/auth/server-side-web-apps).
- [Canales: mine, forHandle y campos](https://developers.google.com/youtube/data/reference/rest/v3/channels/list).
- [Usuarios de prueba y vencimiento a siete días](https://support.google.com/cloud/answer/15549945).
