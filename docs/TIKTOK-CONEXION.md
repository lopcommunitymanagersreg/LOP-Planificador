# Conexión de perfil de TikTok

La revisión inicial encontró el identificador visual `tiktok`, referencias locales y documentación de futuras publicaciones en FASE-1-MATRIZ-APIS.md. No había OAuth, callbacks ni almacenamiento de tokens. Se añadió únicamente conexión de perfil, reutilizando las sesiones, el cifrado y la gestión de espacios y marcas existentes.

## Implementado

- `server/tiktok.js`: Login Kit para Web con `user.info.basic`, estado aleatorio de un solo uso ligado a sesión, usuario, espacio y marca; 30 minutos para completar el proceso de conexión.
- Intercambio del código en el servidor y consulta de `open_id` y `display_name` para confirmar la identidad. El nombre viene de TikTok; no basta escribir un usuario.
- Tokens de acceso y renovación cifrados con la clave existente `SOCIAL_TOKEN_ENCRYPTION_KEY`; no se entregan al navegador. Renovación y rotación al verificar la conexión.
- Reconectar la misma identidad actualiza su registro sin duplicarlo. No se ejecuta OAuth al iniciar la aplicación.
- Cuentas, contadores, reasignación y eliminación local integrados en los mecanismos existentes. Tablas separadas `tiktok_connections` y `tiktok_oauth_states`; las otras plataformas se conservan.
- Errores de proveedor o permisos no sobrescriben las credenciales guardadas. No hay renovación automática en segundo plano; la comprobación se realiza mediante «Verificar conexión».
- No existen endpoints de carga, publicación ni programación. No se solicitan `video.publish`, `video.upload`, `video.list`, estadísticas ni información ampliada de perfil.

## Pendiente para una conexión real

En la revisión local no están presentes `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` ni `TIKTOK_REDIRECT_URI`. No se creó otra aplicación ni se modificó ningún portal.

1. Identificar la aplicación existente en TikTok for Developers y comprobar su estado de revisión, disponibilidad de Login Kit para Web y autorización de `user.info.basic`. Verificar si el entorno permite únicamente usuarios de prueba y registrar los usuarios necesarios en ese entorno, si corresponde.
2. Configurar las credenciales de esa misma aplicación como variables del entorno. Se documentan en `.env.example`, sin valores reales.
3. Proporcionar un dominio HTTPS público que llegue al frontend y al proxy `/api` del mismo despliegue. Registrar exactamente `https://DOMINIO/api/connections/tiktok/callback` en Login Kit y en `TIKTOK_REDIRECT_URI`; TikTok no admite el callback HTTP de localhost. No crear un túnel ni un despliegue sin autorización.
4. Comprobar que el origen público esté admitido en `LOP_ALLOWED_ORIGINS` y que la sesión del usuario esté en ese mismo dominio. Para producción, usar configuración de cookies segura y `NODE_ENV=production` como en el servidor existente.
5. Revisar los datos generales exigidos por el portal: dominio, política de privacidad, términos y verificación del sitio cuando aplique. La existencia y aprobación de estos ajustes no se pueden deducir de las variables locales.
6. Una vez habilitado, ejecutar una autorización real con consentimiento del usuario, confirmar el perfil correcto y comprobar renovación y permisos. No se realizó esa autorización durante el desarrollo.

## Fuentes oficiales consultadas

- [Login Kit para Web y restricciones del callback](https://developers.tiktok.com/docs/en/login-kit-web).
- [Intercambio y renovación de tokens](https://developers.tiktok.com/docs/en/oauth-user-access-token-management).
- [Get User Info y scopes por campo](https://developers.tiktok.com/docs/en/tiktok-api-v2-get-user-info).

Las pruebas usan proveedores simulados y bases temporales. No acreditan aprobación del portal ni acceso real a TikTok.

## Revisión del botón y preparación para autorización real — 30 de octubre de 2026

- «Conectar TikTok» usa el icono original del paquete oficial de [Design Guidelines](https://developers.tiktok.com/docs/en/getting-started-design-guidelines), guardado en `src/assets/tiktok-icon.png`. El botón mantiene la ruta existente `/api/connections/tiktok/authorize?brandId=…`.
- El botón permanece visible y deshabilitado cuando faltan credenciales o no se ha seleccionado una marca. No intenta iniciar OAuth en ese estado.
- Se confirmó de nuevo, sin mostrar valores, la ausencia local de `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` y `TIKTOK_REDIRECT_URI`. No se cambiaron credenciales, permisos ni conexiones de otras plataformas.
- Se revisó el OAuth existente: `state` de un solo uso ligado a la sesión y al contexto, comprobación de `user.info.basic`, validación de `open_id`, cifrado y renovación. No se añadieron flujos paralelos ni publicación.
- La documentación oficial de [Login Kit Web](https://developers.tiktok.com/docs/en/login-kit-web) confirma el callback HTTPS estático registrado; [App Management](https://developers.tiktok.com/docs/en/getting-started-create-an-app) distingue Sandbox y Production y sus requisitos de revisión.
- Sin acceso autenticado al portal, quedan pendientes de comprobación manual Login Kit/Web, `user.info.basic`, callback exacto, usuarios permitidos en Sandbox, estado de revisión de Production y los datos legales/dominio exigidos. Los pasos de la sección anterior se aplican a la aplicación existente; no se debe registrar una aplicación duplicada.
- No se inició ninguna autorización real. La prueba con la cuenta del usuario queda pendiente hasta completar la configuración y decidir iniciarla.
