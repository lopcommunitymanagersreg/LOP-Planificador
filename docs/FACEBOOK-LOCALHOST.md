# Facebook en localhost

LOP conserva el cliente Meta, las páginas y sus asociaciones existentes. Las credenciales permanecen cifradas con AES-256-GCM en SQLite y no se devuelven al navegador.

## Verificación

«Verificar conexión» consulta `debug_token` y la identidad de la página en Graph API. Comprueba la aplicación emisora, tipo PAGE, ID, permisos y vencimientos, incluidos los de acceso a datos. Un vencimiento cero significa ausencia de fecha fija; no garantiza acceso permanente. El resultado se muestra en la tarjeta y el detalle, aunque los avisos opcionales estén desactivados.

El error 190 debe diagnosticarse junto con la inspección de la aplicación. Si el inspector devuelve `API access blocked`, LOP conserva tokens, páginas, espacios y marcas, e informa de la restricción. No presenta los permisos guardados como verificados ni ofrece esa cuenta como destino verificado de un nuevo borrador. Los errores temporales no borran ni invalidan credenciales.

## Intervención manual cuando Meta bloquea la aplicación

1. Abrir [las aplicaciones de Meta](https://developers.facebook.com/apps/) y elegir la aplicación que ya usa LOP.
2. Revisar sus avisos y las acciones requeridas. Si aparece una sección de calidad o restricciones, revisar el motivo. Compartir únicamente el aviso, nunca tokens, secretos ni códigos SMS. No crear otra aplicación, eliminar integraciones ni modificar permisos por ensayo.
3. Completar únicamente la acción concreta que indique Meta. Si el SMS impide entrar, ese acceso debe resolverse con Meta antes de comprobar el desbloqueo; el código de LOP no puede saltarse esa verificación.
4. Tras recuperar acceso a la API, usar «Verificar conexión» en las dos páginas. Si Meta exige consentimiento nuevo, usar «Reconectar Facebook» o «Conectar Facebook» en el espacio y marca actuales, autorizar las mismas páginas y conservar sus destinos al confirmar.
5. El backend vuelve a comprobar cada página antes de guardar. Actualiza la conexión por ID de página y usuario, sin duplicarla. Verificar ambas páginas y repetir la consulta después del reinicio antes de considerar completada la red.

El callback existente intercambia el token de usuario por uno de larga duración y obtiene los tokens de página. Facebook no entrega un refresh token equivalente al de Google para estas páginas. Una revocación requiere consentimiento otra vez; un bloqueo de aplicación requiere resolver primero la restricción. LOP no realiza publicaciones ni promete una renovación indefinida.

Referencias oficiales: [tokens de larga duración](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/), [depuración y errores](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/debugging-and-error-handling/), [debug_token](https://developers.facebook.com/docs/graph-api/reference/debug_token/).
