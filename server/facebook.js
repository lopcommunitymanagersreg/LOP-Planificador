// Page tokens are obtained from a long-lived user grant by the existing OAuth
// callback. Meta does not issue refresh tokens for Pages: revoked grants require
// consent again; an application API restriction must be resolved in Meta first.
export function createFacebookVerifier({ config, fetchImpl = globalThis.fetch }) {
  const failure = (reason, code) => Object.assign(new Error('No se pudo verificar Facebook.'), { reason, providerCode: code });
  const graph = async (path, token, parameters = {}) => {
    const url = new URL(`https://graph.facebook.com/${config.graphVersion}/${path}`);
    for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    const payload = await response.json();
    if (!response.ok || payload.error) {
      const code = payload.error?.code;
      if (code === 200 && payload.error?.message === 'API access blocked.') throw failure('api-blocked', code);
      throw failure(code === 190 ? 'token-invalid' : [10, 200].includes(code) ? 'permissions-missing' : 'provider-error', code);
    }
    return payload;
  };
  return async (token, pageId) => {
    const results = await Promise.allSettled([
      graph('debug_token', `${config.appId}|${config.appSecret}`, { input_token: token }),
      graph(pageId, token, { fields: 'id,name' }),
    ]);
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (failures.length) throw failures.find((error) => error.reason === 'api-blocked') || failures[0];
    const debug = results[0].value.data;
    const page = results[1].value;
    if (!debug?.is_valid || String(debug.app_id) !== String(config.appId) || debug.type !== 'PAGE'
      || (debug.profile_id && String(debug.profile_id) !== pageId) || page.id !== pageId || typeof page.name !== 'string') throw failure('token-invalid', 190);
    const dates = [debug.expires_at, debug.data_access_expires_at].filter((value) => Number.isFinite(value) && value > 0).map((value) => value * 1000);
    if (dates.some((date) => date <= Date.now())) throw failure('token-expired', 190);
    const scopes = Array.isArray(debug.scopes) ? debug.scopes.filter((scope) => typeof scope === 'string') : [];
    const required = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'];
    if (required.some((scope) => !scopes.includes(scope)
      || debug.granular_scopes?.some((grant) => grant.scope === scope && Array.isArray(grant.target_ids) && !grant.target_ids.includes(pageId)))) throw failure('permissions-missing', 200);
    return { name: page.name.slice(0, 120), scopes, expiresAt: dates.length ? Math.min(...dates) : null,
      verifiedAt: new Date().toISOString() };
  };
}

export function registerFacebookVerification({ app, database, config, encryptionKey, decryptToken, requireSession, getActiveWorkspaceId, verifyPage }) {
  app.post('/api/connections/:connectionId/verify', requireSession, async (request, response, next) => {
    const connection = database.prepare("SELECT * FROM social_connections WHERE id = ? AND user_id = ? AND workspace_id = ? AND network_id = 'facebook'")
      .get(request.params.connectionId, request.user.id, getActiveWorkspaceId(request.user.id));
    if (!connection) return next();
    if (!config.configured || !encryptionKey) return response.status(503).json({ error: 'La configuración de Facebook o su clave de cifrado no está disponible.' });
    const current = () => database.prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?').get(request.sessionTokenHash, request.user.id, Date.now())
      && getActiveWorkspaceId(request.user.id) === connection.workspace_id;
    const update = (sql, values) => database.prepare(`${sql} WHERE id = ? AND user_id = ? AND workspace_id = ? AND brand_id = ? AND access_token_encrypted = ?`)
      .run(...values, connection.id, request.user.id, connection.workspace_id, connection.brand_id, connection.access_token_encrypted);
    try {
      const token = decryptToken(connection.access_token_encrypted, encryptionKey, `${request.user.id}:facebook:${connection.account_id}`);
      const verified = await verifyPage(token, connection.provider_account_id);
      if (!current()) return response.status(401).json({ error: 'La sesión o el espacio cambió durante la verificación.' });
      database.transaction(() => {
        const result = update("UPDATE social_connections SET status = 'connected', expires_at = ?, granted_scopes_json = ?, verified_at = ?, last_error_code = NULL, updated_at = CURRENT_TIMESTAMP", [verified.expiresAt, JSON.stringify(verified.scopes), verified.verifiedAt]);
        if (!result.changes) throw Object.assign(new Error('Connection changed'), { reason: 'conflict' });
        database.prepare('UPDATE social_accounts SET name = ? WHERE id = ? AND user_id = ?').run(verified.name, connection.account_id, request.user.id);
      })();
      return response.json({ verified: true, verifiedAt: verified.verifiedAt, message: `Meta confirmó la página ${verified.name}, su identidad y los permisos vigentes.` });
    } catch (error) {
      if (!current()) return response.status(401).json({ error: 'La sesión o el espacio cambió durante la verificación.' });
      if (error.reason === 'conflict') return response.status(409).json({ error: 'La conexión cambió durante la verificación. Actualiza las cuentas.' });
      const blocked = error.reason === 'api-blocked';
      const invalid = ['token-invalid', 'token-expired', 'permissions-missing'].includes(error.reason);
      if (!blocked && !invalid) return response.status(502).json({ error: 'Meta no pudo responder a la verificación. La conexión y sus credenciales se conservaron; vuelve a intentarlo.' });
      const result = update(`UPDATE social_connections SET ${invalid ? "status = 'expired'," : ''} last_error_code = ?, updated_at = CURRENT_TIMESTAMP`, [error.reason]);
      if (!result.changes) return response.status(409).json({ error: 'La conexión cambió durante la verificación. Actualiza las cuentas.' });
      return response.json({ verified: false, reason: error.reason, reconnectRequired: invalid, message: blocked
        ? 'Meta bloqueó el acceso de la aplicación (API access blocked). Revisa los avisos de la aplicación en Meta antes de volver a autorizar. La página y sus credenciales se conservaron.'
        : 'Meta no confirma permisos vigentes para esta página (error 190 o permisos insuficientes). Usa «Reconectar Facebook» y autoriza la misma página. No hace falta eliminarla.' });
    }
  });
}
