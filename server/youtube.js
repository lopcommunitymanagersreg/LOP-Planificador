import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const youtubeRequiredScopes = Object.freeze([
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.upload',
]);
const lifetime = 30 * 60 * 1000;
const hash = (value) => createHash('sha256').update(value).digest('hex');

export function initializeYouTubeDatabase(database) {
  const selectionColumns = new Set(database.pragma('table_info(youtube_channel_selections)').map(({ name }) => name));
  if (!selectionColumns.has('workspace_id')) database.exec('ALTER TABLE youtube_channel_selections ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE');
  if (!selectionColumns.has('brand_id')) database.exec('ALTER TABLE youtube_channel_selections ADD COLUMN brand_id TEXT REFERENCES brands(id) ON DELETE CASCADE');
  const connectionColumns = new Set(database.pragma('table_info(youtube_connections)').map(({ name }) => name));
  if (!connectionColumns.has('custom_url')) database.exec("ALTER TABLE youtube_connections ADD COLUMN custom_url TEXT NOT NULL DEFAULT ''");
  if (!connectionColumns.has('verified_at')) database.exec('ALTER TABLE youtube_connections ADD COLUMN verified_at TEXT');
}

export function registerYouTubeRoutes({
  app, database, config, oauthClient, encryptionKey, encryptToken, decryptToken,
  requireSession, getActiveWorkspaceId, parseCookies, fetchImpl,
}) {
  const available = Boolean(config.configured && oauthClient && encryptionKey);
  const jsonError = (response, status, error) => response.status(status).json({ error });
  const failure = (reason) => Object.assign(new Error('No se pudo verificar YouTube.'), { youtubeReason: reason });
  const sessionValid = (userId, tokenHash) => Boolean(database.prepare(`
    SELECT 1 FROM sessions WHERE user_id = ? AND token_hash = ? AND expires_at > ?
  `).get(userId, tokenHash, Date.now()));
  const ownsBrand = (userId, workspaceId, brandId) => typeof workspaceId === 'string' && typeof brandId === 'string'
    && workspaceId.length <= 150 && brandId.length <= 150 && Boolean(database.prepare(`
      SELECT 1 FROM brands b JOIN workspaces w ON w.id = b.workspace_id
      WHERE b.id = ? AND b.workspace_id = ? AND w.user_id = ?
    `).get(brandId, workspaceId, userId));
  const reasonFor = (error) => {
    if (error.youtubeReason) return error.youtubeReason;
    const payload = error.response?.data;
    const oauthError = typeof payload?.error === 'string' ? payload.error : null;
    const providerReason = error.providerReason || payload?.error?.errors?.[0]?.reason;
    if (['invalid_client', 'unauthorized_client'].includes(oauthError)) return 'invalid-client';
    if (oauthError === 'redirect_uri_mismatch') return 'redirect-mismatch';
    if (['invalid_grant', 'invalid_token'].includes(oauthError)) return 'token-invalid';
    if (['accessNotConfigured', 'serviceDisabled'].includes(providerReason)) return 'api-disabled';
    if (['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'].includes(providerReason)) return 'permissions-missing';
    if (Number(error.response?.status || error.httpStatus) === 401) return 'token-invalid';
    return 'provider-error';
  };
  const invalidAuthorization = (error) => ['token-invalid', 'permissions-missing', 'channel-unavailable'].includes(reasonFor(error));
  const oauthFailure = (response, reason) => response.redirect(`/?connection=youtube-error&reason=${encodeURIComponent(reason)}`);

  const inspectAccess = async (accessToken) => {
    if (typeof accessToken !== 'string' || !accessToken) throw failure('token-invalid');
    const info = await oauthClient.getTokenInfo(accessToken);
    if (info.aud !== config.clientId) throw failure('token-invalid');
    if (!Array.isArray(info.scopes) || !youtubeRequiredScopes.every((scope) => info.scopes.includes(scope))) throw failure('permissions-missing');
    if (!Number.isFinite(info.expiry_date) || info.expiry_date <= Date.now()) throw failure('token-invalid');
    return info;
  };
  const freshCredentials = async (credentials, forceRefresh = false) => {
    if (typeof credentials?.refreshToken !== 'string' || !credentials.refreshToken) throw failure('refresh-token-required');
    let result = { ...credentials };
    if (forceRefresh || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now() + 60_000) {
      // The installed Google library accepts an explicit refresh token, without shared setCredentials().
      const { tokens } = await oauthClient.refreshToken(result.refreshToken);
      result = {
        accessToken: tokens.access_token,
        refreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token ? tokens.refresh_token : result.refreshToken,
        expiresAt: tokens.expiry_date,
      };
    }
    const info = await inspectAccess(result.accessToken);
    return { credentials: { ...result, expiresAt: info.expiry_date }, grantedScopes: info.scopes };
  };
  const listChannels = async (accessToken) => {
    const channels = new Map();
    const seen = new Set();
    let pageToken;
    for (let count = 0; count < 1000; count += 1) {
      const url = new URL('https://youtube.googleapis.com/youtube/v3/channels');
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('mine', 'true');
      url.searchParams.set('maxResults', '50');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15000), redirect: 'error',
      });
      let payload;
      try { payload = await response.json(); } catch { throw failure('provider-error'); }
      if (!response.ok || payload?.error) {
        // Retain only controlled classifications; Google errors may contain credentials in their config.
        const error = { providerReason: payload?.error?.errors?.[0]?.reason, httpStatus: response.status };
        throw failure(reasonFor(error));
      }
      if (!Array.isArray(payload.items)) throw failure('provider-error');
      for (const channel of payload.items) {
        if (typeof channel?.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(channel.id)
          || typeof channel.snippet?.title !== 'string' || !channel.snippet.title.trim()) throw failure('provider-error');
        channels.set(channel.id, {
          id: channel.id, name: channel.snippet.title.slice(0, 120),
          customUrl: typeof channel.snippet.customUrl === 'string' ? channel.snippet.customUrl.slice(0, 120) : '',
        });
      }
      if (!payload.nextPageToken) return [...channels.values()];
      pageToken = payload.nextPageToken;
      if (typeof pageToken !== 'string' || pageToken.length > 2048 || seen.has(pageToken)) throw failure('provider-error');
      seen.add(pageToken);
    }
    throw failure('provider-error');
  };
  const verifyAccess = async (credentials, forceRefresh = false) => {
    let access;
    try { access = await freshCredentials(credentials, forceRefresh); }
    catch (error) {
      // Expired access tokens are renewable; retry once with the channel's own refresh token.
      if (!forceRefresh && reasonFor(error) === 'token-invalid') access = await freshCredentials(credentials, true);
      else throw error;
    }
    let channels;
    try { channels = await listChannels(access.credentials.accessToken); }
    catch (error) {
      if (!forceRefresh && reasonFor(error) === 'token-invalid') {
        access = await freshCredentials(access.credentials, true);
        channels = await listChannels(access.credentials.accessToken);
      } else throw error;
    }
    if (access.credentials.expiresAt <= Date.now()) throw failure('token-invalid');
    return { ...access, channels, verifiedAt: new Date().toISOString() };
  };
  const getSelection = (request, id) => database.prepare(`
    SELECT * FROM youtube_channel_selections WHERE id = ? AND user_id = ? AND session_token_hash = ?
  `).get(id, request.user.id, request.sessionTokenHash);
  const selectionAad = (selection) => `youtube-selection:${selection.user_id}:${selection.session_token_hash}:${selection.id}`;
  const decodeSelection = (selection) => {
    const aad = selectionAad(selection);
    const channels = JSON.parse(decryptToken(selection.channels_encrypted, encryptionKey, `${aad}:channels`));
    const credentials = JSON.parse(decryptToken(selection.credentials_encrypted, encryptionKey, `${aad}:credentials`));
    if (!Array.isArray(channels) || typeof credentials.refreshToken !== 'string') throw failure('token-invalid');
    return { channels, credentials };
  };
  const publicSelection = (selection) => ({
    id: selection.id, expiresAt: selection.expires_at, workspaceId: selection.workspace_id, brandId: selection.brand_id,
    grantedScopes: JSON.parse(selection.granted_scopes_json), channels: decodeSelection(selection).channels,
  });

  app.get('/api/connections/youtube/authorize', requireSession, (request, response) => {
    if (!available) return jsonError(response, 503, 'Configura las credenciales OAuth de Google y la clave local de cifrado.');
    const workspaceId = getActiveWorkspaceId(request.user.id);
    if (!ownsBrand(request.user.id, workspaceId, request.query.brandId)) return jsonError(response, 400, 'Selecciona una marca del espacio activo antes de conectar YouTube.');
    database.prepare('DELETE FROM youtube_oauth_states WHERE expires_at <= ?').run(Date.now());
    database.prepare('DELETE FROM youtube_channel_selections WHERE expires_at <= ?').run(Date.now());
    const state = randomBytes(32).toString('base64url');
    database.prepare(`INSERT INTO youtube_oauth_states
      (state_hash, user_id, session_token_hash, workspace_id, brand_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(hash(state), request.user.id, request.sessionTokenHash, workspaceId, request.query.brandId, Date.now() + lifetime);
    response.redirect(oauthClient.generateAuthUrl({
      access_type: 'offline', include_granted_scopes: true, prompt: 'consent', scope: [...youtubeRequiredScopes], state,
    }));
  });
  app.get('/api/connections/youtube/callback', async (request, response) => {
    const state = typeof request.query.state === 'string' ? request.query.state : '';
    const record = state ? database.prepare('SELECT * FROM youtube_oauth_states WHERE state_hash = ?').get(hash(state)) : null;
    if (record) database.prepare('DELETE FROM youtube_oauth_states WHERE state_hash = ?').run(record.state_hash);
    if (!record) return oauthFailure(response, 'invalid-state');
    if (record.expires_at <= Date.now()) return oauthFailure(response, 'state-expired');
    const token = parseCookies(request.get('cookie')).lop_session;
    if (!token || hash(token) !== record.session_token_hash || !sessionValid(record.user_id, record.session_token_hash)) return oauthFailure(response, 'session-expired');
    if (request.query.error || typeof request.query.code !== 'string' || !request.query.code) {
      return oauthFailure(response, request.query.error === 'access_denied' ? 'cancelled' : 'provider-error');
    }
    if (!available) return oauthFailure(response, 'not-configured');
    if (!ownsBrand(record.user_id, record.workspace_id, record.brand_id)) return oauthFailure(response, 'invalid-state');
    try {
      const { tokens } = await oauthClient.getToken(request.query.code);
      if (typeof tokens.access_token !== 'string' || !tokens.access_token) throw failure('token-invalid');
      if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) throw failure('refresh-token-required');
      // Check the original grant, then prove that its offline token can really renew access.
      await inspectAccess(tokens.access_token);
      const verified = await verifyAccess({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: tokens.expiry_date }, true);
      if (!verified.channels.length) return oauthFailure(response, 'no-channels');
      if (record.expires_at <= Date.now()) return oauthFailure(response, 'state-expired');
      if (!sessionValid(record.user_id, record.session_token_hash)) return oauthFailure(response, 'session-expired');
      if (!ownsBrand(record.user_id, record.workspace_id, record.brand_id)) return oauthFailure(response, 'invalid-state');
      const selection = { id: randomUUID(), user_id: record.user_id, session_token_hash: record.session_token_hash };
      const aad = selectionAad(selection);
      database.prepare(`INSERT INTO youtube_channel_selections
        (id, user_id, session_token_hash, channels_encrypted, credentials_encrypted, granted_scopes_json,
          expires_at, workspace_id, brand_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(selection.id, record.user_id, record.session_token_hash,
          encryptToken(JSON.stringify(verified.channels), encryptionKey, `${aad}:channels`),
          encryptToken(JSON.stringify(verified.credentials), encryptionKey, `${aad}:credentials`),
          JSON.stringify(verified.grantedScopes), Date.now() + lifetime, record.workspace_id, record.brand_id);
      return response.redirect(`/?connection=youtube-select&selection=${encodeURIComponent(selection.id)}`);
    } catch (error) { return oauthFailure(response, reasonFor(error)); }
  });
  app.get('/api/connections/youtube/selections/pending', requireSession, (request, response) => {
    if (!available) return response.json({ pending: [] });
    try {
      const selections = database.prepare(`SELECT * FROM youtube_channel_selections
        WHERE user_id = ? AND session_token_hash = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 5`)
        .all(request.user.id, request.sessionTokenHash, Date.now());
      return response.json({ pending: selections.map(publicSelection) });
    } catch { return jsonError(response, 500, 'No se pudo recuperar de forma segura la selección de canales.'); }
  });
  app.get('/api/connections/youtube/selections/:selectionId', requireSession, (request, response) => {
    const selection = getSelection(request, request.params.selectionId);
    if (!selection) return jsonError(response, 404, 'La selección de canales no pertenece a esta sesión o no existe.');
    if (selection.expires_at <= Date.now()) return jsonError(response, 410, 'La selección temporal venció. Vuelve a conectar YouTube.');
    if (!available) return jsonError(response, 503, 'La configuración OAuth o la clave de cifrado no están disponibles.');
    try { return response.json({ selection: publicSelection(selection) }); }
    catch { return jsonError(response, 500, 'No se pudo recuperar de forma segura la selección de canales.'); }
  });
  app.post('/api/connections/youtube/selections/:selectionId', requireSession, async (request, response) => {
    const selection = getSelection(request, request.params.selectionId);
    if (!selection) return jsonError(response, 404, 'La selección de canales no pertenece a esta sesión o no existe.');
    if (selection.expires_at <= Date.now()) return jsonError(response, 410, 'La selección temporal venció. Vuelve a conectar YouTube.');
    if (!available) return jsonError(response, 503, 'La configuración OAuth o la clave de cifrado no están disponibles.');
    const assignments = request.body?.channels;
    if (!Array.isArray(assignments) || !assignments.length || assignments.length > 50) return jsonError(response, 400, 'Selecciona entre uno y 50 canales de YouTube.');
    try {
      const selected = decodeSelection(selection);
      const ids = assignments.map((item) => item?.providerChannelId);
      if (new Set(ids).size !== ids.length || ids.some((id) => !selected.channels.some((channel) => channel.id === id))
        || assignments.some((item) => !ownsBrand(request.user.id, item.workspaceId, item.brandId))) {
        return jsonError(response, 400, 'Asigna únicamente canales autorizados a espacios y marcas de tu cuenta.');
      }
      const verified = await verifyAccess(selected.credentials);
      const channels = new Map(verified.channels.map((channel) => [channel.id, channel]));
      if (ids.some((id) => !channels.has(id))) return jsonError(response, 400, 'Google ya no confirma el acceso a los canales seleccionados. Vuelve a conectar YouTube.');
      database.transaction(() => {
        if (!sessionValid(request.user.id, request.sessionTokenHash)) throw Object.assign(failure('session-expired'), { localStatus: 401 });
        if (selection.expires_at <= Date.now() || !getSelection(request, selection.id)
          || assignments.some((item) => !ownsBrand(request.user.id, item.workspaceId, item.brandId))) {
          throw Object.assign(failure('invalid-state'), { localStatus: 409 });
        }
        for (const item of assignments) {
          const channel = channels.get(item.providerChannelId);
          const existing = database.prepare('SELECT id, account_id FROM youtube_connections WHERE user_id = ? AND provider_channel_id = ?')
            .get(request.user.id, channel.id);
          const connectionId = existing?.id || `youtube-${randomUUID()}`;
          const accountId = existing?.account_id || `account-${randomUUID()}`;
          database.prepare(`INSERT INTO social_accounts
            (id, user_id, name, network_id, status, preference_enabled, workspace_id, brand_id)
            VALUES (?, ?, ?, 'youtube', 'demo', 1, ?, ?) ON CONFLICT(user_id, id) DO UPDATE SET
            name = excluded.name, network_id = 'youtube', workspace_id = excluded.workspace_id, brand_id = excluded.brand_id`)
            .run(accountId, request.user.id, channel.name, item.workspaceId, item.brandId);
          database.prepare(`INSERT INTO youtube_connections
            (id, user_id, account_id, workspace_id, brand_id, provider_channel_id, status,
              credentials_encrypted, granted_scopes_json, custom_url, verified_at)
            VALUES (?, ?, ?, ?, ?, ?, 'connected', ?, ?, ?, ?)
            ON CONFLICT(user_id, provider_channel_id) DO UPDATE SET workspace_id = excluded.workspace_id,
              brand_id = excluded.brand_id, status = 'connected', credentials_encrypted = excluded.credentials_encrypted,
              granted_scopes_json = excluded.granted_scopes_json, custom_url = excluded.custom_url,
              verified_at = excluded.verified_at, updated_at = CURRENT_TIMESTAMP`)
            .run(connectionId, request.user.id, accountId, item.workspaceId, item.brandId, channel.id,
              encryptToken(JSON.stringify(verified.credentials), encryptionKey, `youtube-connection:${request.user.id}:${connectionId}`),
              JSON.stringify(verified.grantedScopes), channel.customUrl, verified.verifiedAt);
        }
        database.prepare('DELETE FROM youtube_channel_selections WHERE id = ?').run(selection.id);
      })();
      return response.json({ connectedCount: assignments.length });
    } catch (error) {
      if (error.localStatus) return jsonError(response, error.localStatus, 'La sesión, selección o marca cambió durante la verificación. Inicia de nuevo la conexión.');
      return jsonError(response, invalidAuthorization(error) ? 400 : 502,
        reasonFor(error) === 'api-disabled' ? 'Habilita YouTube Data API v3 en el proyecto Google Cloud del cliente existente.'
          : 'Google no pudo verificar los canales. Las conexiones guardadas se conservaron; vuelve a intentarlo.');
    }
  });
  app.delete('/api/connections/youtube/selections/:selectionId', requireSession, (request, response) => {
    const deleted = database.prepare(`DELETE FROM youtube_channel_selections
      WHERE id = ? AND user_id = ? AND session_token_hash = ?`).run(request.params.selectionId, request.user.id, request.sessionTokenHash);
    return deleted.changes ? response.status(204).end() : jsonError(response, 404, 'La selección no existe en esta sesión.');
  });

  // The same path continues to the existing Instagram handler for other connection IDs.
  app.post('/api/connections/:connectionId/verify', requireSession, async (request, response, next) => {
    const connection = database.prepare('SELECT * FROM youtube_connections WHERE id = ? AND user_id = ? AND workspace_id = ?')
      .get(request.params.connectionId, request.user.id, getActiveWorkspaceId(request.user.id));
    if (!connection) return next();
    if (!available) return jsonError(response, 503, 'La configuración OAuth o la clave de cifrado no están disponibles.');
    try {
      const credentials = JSON.parse(decryptToken(connection.credentials_encrypted, encryptionKey, `youtube-connection:${request.user.id}:${connection.id}`));
      const verified = await verifyAccess(credentials, true);
      const channel = verified.channels.find((item) => item.id === connection.provider_channel_id);
      if (!channel) throw failure('channel-unavailable');
      if (!sessionValid(request.user.id, request.sessionTokenHash)) return jsonError(response, 401, 'La sesión venció durante la verificación.');
      database.transaction(() => {
        const result = database.prepare(`UPDATE youtube_connections SET status = 'connected', credentials_encrypted = ?,
          granted_scopes_json = ?, custom_url = ?, verified_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND user_id = ? AND workspace_id = ? AND credentials_encrypted = ?`)
          .run(encryptToken(JSON.stringify(verified.credentials), encryptionKey, `youtube-connection:${request.user.id}:${connection.id}`),
            JSON.stringify(verified.grantedScopes), channel.customUrl, verified.verifiedAt,
            connection.id, request.user.id, connection.workspace_id, connection.credentials_encrypted);
        if (!result.changes) throw Object.assign(failure('invalid-state'), { localStatus: 409 });
        database.prepare('UPDATE social_accounts SET name = ? WHERE id = ? AND user_id = ?')
          .run(channel.name, connection.account_id, request.user.id);
      })();
      return response.json({ verified: true, status: 'connected', verifiedAt: verified.verifiedAt, message: 'Google verificó el acceso renovable y el canal de YouTube autorizado.' });
    } catch (error) {
      if (!sessionValid(request.user.id, request.sessionTokenHash)) return jsonError(response, 401, 'La sesión venció durante la verificación.');
      if (error.localStatus) return jsonError(response, error.localStatus, 'La conexión cambió durante la verificación. Actualiza las cuentas.');
      if (reasonFor(error) === 'permissions-missing') {
        return jsonError(response, 403, 'YouTube requiere youtube.readonly y youtube.upload. Se conservaron la conexión y sus credenciales; falta autorizar ambos permisos.');
      }
      if (!invalidAuthorization(error) && reasonFor(error) !== 'refresh-token-required') {
        return jsonError(response, 502, reasonFor(error) === 'api-disabled'
          ? 'Habilita YouTube Data API v3 en el proyecto Google Cloud del cliente existente. Se conservó el estado anterior.'
          : 'Google no pudo responder a la verificación. Se conservó el estado anterior; inténtalo de nuevo.');
      }
      const updated = database.prepare(`UPDATE youtube_connections SET status = 'expired', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ? AND workspace_id = ? AND credentials_encrypted = ?`)
        .run(connection.id, request.user.id, connection.workspace_id, connection.credentials_encrypted);
      if (!updated.changes) return jsonError(response, 409, 'La conexión cambió durante la verificación. Actualiza las cuentas.');
      return response.json({ verified: false, status: 'expired', verifiedAt: connection.verified_at,
        message: 'Google ya no confirma el acceso renovable a este canal. Vuelve a conectar YouTube sin retirar el acceso de LOP a Google.' });
    }
  });
}
