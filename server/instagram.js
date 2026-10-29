import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

const requiredPermissions = ['instagram_basic', 'pages_show_list', 'pages_read_engagement'];
const pagePermissions = ['instagram_basic', 'pages_read_engagement'];
const authorizationLifetime = 30 * 60 * 1000;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const providerId = (value) => typeof value === 'string' && /^\d{1,40}$/.test(value);

export function createInstagramOAuthConfig(environment = process.env) {
  const missing = ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET', 'META_GRAPH_API_VERSION']
    .filter((key) => !environment[key]);
  let redirectUri = environment.INSTAGRAM_REDIRECT_URI;
  if (!redirectUri && environment.FACEBOOK_REDIRECT_URI) {
    redirectUri = new URL('/api/connections/instagram/callback', environment.FACEBOOK_REDIRECT_URI).href;
  }
  if (!redirectUri) missing.push('INSTAGRAM_REDIRECT_URI');
  if (missing.length) return { configured: false, missing };
  const redirect = new URL(redirectUri);
  const localHttp = redirect.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname);
  if ((!localHttp && redirect.protocol !== 'https:') || redirect.username || redirect.password
    || redirect.pathname !== '/api/connections/instagram/callback' || redirect.search || redirect.hash) {
    throw new Error('INSTAGRAM_REDIRECT_URI debe usar HTTPS (o localhost HTTP) y terminar exactamente en /api/connections/instagram/callback.');
  }
  if (!/^v\d+\.\d+$/.test(environment.META_GRAPH_API_VERSION)) {
    throw new Error('META_GRAPH_API_VERSION debe tener el formato oficial vNN.N.');
  }
  return {
    configured: true, missing: [], appId: environment.FACEBOOK_APP_ID,
    appSecret: environment.FACEBOOK_APP_SECRET, graphVersion: environment.META_GRAPH_API_VERSION,
    redirectUri: redirect.href,
  };
}

export function initializeInstagramDatabase(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS instagram_oauth_states (
      state_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_token_hash TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS instagram_oauth_states_expiry ON instagram_oauth_states(expires_at);
    CREATE TABLE IF NOT EXISTS instagram_account_selections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_token_hash TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      accounts_encrypted TEXT NOT NULL,
      granted_scopes_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS instagram_selections_user_expiry ON instagram_account_selections(user_id, expires_at);
    CREATE TABLE IF NOT EXISTS instagram_connections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      provider_account_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      page_name TEXT NOT NULL,
      username TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('connected', 'expired')),
      access_token_encrypted TEXT NOT NULL,
      expires_at INTEGER,
      granted_scopes_json TEXT NOT NULL,
      verified_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id, account_id) REFERENCES social_accounts(user_id, id) ON DELETE CASCADE,
      UNIQUE (user_id, provider_account_id)
    );
    CREATE INDEX IF NOT EXISTS instagram_connections_workspace_brand
      ON instagram_connections(user_id, workspace_id, brand_id);
  `);
}

export function registerInstagramRoutes({
  app, database, config, encryptionKey, encryptToken, decryptToken,
  requireSession, getActiveWorkspaceId, fetchImpl,
}) {
  const jsonError = (response, status, message) => response.status(status).json({ error: message });
  const available = Boolean(config.configured && encryptionKey);
  const sessionValid = (userId, tokenHash) => Boolean(database.prepare(`
    SELECT 1 FROM sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?
  `).get(tokenHash, userId, Date.now()));
  const ownsBrand = (userId, workspaceId, brandId) => typeof workspaceId === 'string' && typeof brandId === 'string'
    && Boolean(database.prepare(`
      SELECT 1 FROM brands b JOIN workspaces w ON w.id = b.workspace_id
      WHERE b.id = ? AND b.workspace_id = ? AND w.user_id = ?
    `).get(brandId, workspaceId, userId));
  const invalidAuthorization = (reason = 'token-invalid') => Object.assign(new Error('Meta no confirmó una autorización válida de Instagram.'), { reason });
  const invalidTokenError = (error) => error.reason === 'token-invalid' || error.reason === 'permissions-missing'
    || error.reason === 'account-unavailable' || [190, 10, 200].includes(error.providerCode);
  const expiry = (...values) => {
    const dates = values.filter((value) => Number.isFinite(value) && value > 0);
    return dates.length ? Math.min(...dates) : null;
  };
  const tokenDate = (value) => typeof value === 'number' && value > 0 ? value * 1000 : null;

  // OAuth credentials use headers/bodies. debug_token uses Meta's documented input_token parameter.
  // Provider error text and request URLs are never logged or returned.
  const graph = async (path, accessToken = '', parameters = {}, form = null) => {
    const url = new URL(`https://graph.facebook.com/${config.graphVersion}/${path}`);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    if (accessToken && path !== 'debug_token') {
      url.searchParams.set('appsecret_proof', createHmac('sha256', config.appSecret).update(accessToken).digest('hex'));
    }
    const response = await fetchImpl(url, {
      method: form ? 'POST' : 'GET', signal: AbortSignal.timeout(15000), redirect: 'error',
      headers: {
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });
    let payload;
    try { payload = await response.json(); } catch { throw new Error('Respuesta no válida de Meta.'); }
    if (!response.ok || payload?.error) {
      throw Object.assign(new Error('Meta no pudo verificar la conexión.'), {
        providerCode: Number(payload?.error?.code || response.status),
      });
    }
    return payload;
  };
  const edge = async (path, token, parameters) => {
    const records = [];
    const seen = new Set();
    let after;
    for (let count = 0; count < 1000; count += 1) {
      const payload = await graph(path, token, { ...parameters, ...(after ? { after } : {}) });
      if (!Array.isArray(payload.data)) throw new Error('Meta no devolvió una lista válida.');
      records.push(...payload.data);
      if (!payload.paging?.next) return records;
      const next = new URL(payload.paging.next);
      if (next.protocol !== 'https:' || next.hostname !== 'graph.facebook.com' || next.port
        || next.username || next.password || next.pathname !== `/${config.graphVersion}/${path}`) {
        throw new Error('Paginación no válida de Meta.');
      }
      after = next.searchParams.get('after');
      if (!after || seen.has(after)) throw new Error('Paginación repetida o no válida de Meta.');
      seen.add(after);
    }
    throw new Error('El listado de Meta excede el máximo de seguridad.');
  };
  const inspectToken = async (token, permissions) => {
    const { data } = await graph('debug_token', `${config.appId}|${config.appSecret}`, { input_token: token });
    if (data?.is_valid !== true || String(data.app_id) !== config.appId) throw invalidAuthorization();
    if (!Array.isArray(data.scopes) || permissions.some((scope) => !data.scopes.includes(scope))) {
      throw invalidAuthorization('permissions-missing');
    }
    for (const field of ['expires_at', 'data_access_expires_at']) {
      if (data[field] !== undefined && (typeof data[field] !== 'number' || !Number.isFinite(data[field]) || data[field] < 0)) {
        throw invalidAuthorization();
      }
    }
    const expiresAt = expiry(tokenDate(data.expires_at), tokenDate(data.data_access_expires_at));
    if (expiresAt && expiresAt <= Date.now()) throw invalidAuthorization();
    return expiresAt;
  };
  const inspectAccount = async ({ pageId, accessToken, id, expiresAt: previousExpiry }) => {
    const expiresAt = expiry(await inspectToken(accessToken, pagePermissions), previousExpiry);
    if (expiresAt && expiresAt <= Date.now()) throw invalidAuthorization();
    const page = await graph(pageId, accessToken, { fields: 'id,name,instagram_business_account' });
    const instagramId = page.instagram_business_account?.id;
    if (page.id !== pageId || !providerId(instagramId) || (id && instagramId !== id)) {
      throw invalidAuthorization('account-unavailable');
    }
    const profile = await graph(instagramId, accessToken, { fields: 'id,username,name' });
    if (profile.id !== instagramId || typeof profile.username !== 'string' || !profile.username.trim()) {
      throw invalidAuthorization('account-unavailable');
    }
    if (expiresAt && expiresAt <= Date.now()) throw invalidAuthorization();
    return {
      id: instagramId, name: (profile.name || `@${profile.username}`).slice(0, 120),
      username: profile.username.slice(0, 120), pageId, pageName: String(page.name || pageId).slice(0, 120),
      accessToken, expiresAt, verifiedAt: new Date().toISOString(),
    };
  };
  const discoverPages = async (token, scopes, userId) => {
    const pages = new Map();
    const errors = [];
    const add = (records) => {
      for (const page of records) if (providerId(page?.id)) pages.set(page.id, page);
    };
    if (scopes.includes('business_management')) {
      try {
        for (const business of await edge('me/businesses', token, { fields: 'id,name', limit: '100' })) {
          if (!providerId(business?.id)) continue;
          for (const name of ['owned_pages', 'client_pages']) {
            try { add(await edge(`${business.id}/${name}`, token, { fields: 'id,name,access_token', limit: '100' })); }
            catch (error) { errors.push(error); }
          }
        }
      } catch (error) { errors.push(error); }
    }
    try { add(await edge('me/accounts', token, { fields: 'id,name,access_token,instagram_business_account', limit: '100' })); }
    catch (error) { errors.push(error); }
    // Existing Facebook assets are hints only: every asset is checked with the NEW consent.
    for (const { id } of database.prepare(`
      SELECT provider_account_id AS id FROM social_connections WHERE user_id = ? AND network_id = 'facebook'
    `).all(userId)) if (providerId(id) && !pages.has(id)) pages.set(id, { id });
    const usable = [];
    for (const page of pages.values()) {
      try {
        const details = await graph(page.id, token, { fields: 'id,name,access_token,instagram_business_account' });
        if (typeof details.access_token === 'string' && providerId(details.instagram_business_account?.id)) usable.push(details);
      } catch (error) { errors.push(error); }
    }
    if (!usable.length && errors.length) throw errors[0];
    return usable;
  };
  const publicAccount = ({ accessToken, ...account }) => account;
  const selectionAad = (selection) => `instagram-selection:${selection.user_id}:${selection.session_token_hash}:${selection.id}`;
  const readSelection = (request, id) => database.prepare(`
    SELECT * FROM instagram_account_selections WHERE id = ? AND user_id = ? AND session_token_hash = ?
  `).get(id, request.user.id, request.sessionTokenHash);
  const decodeSelection = (selection) => ({
    id: selection.id, workspaceId: selection.workspace_id, brandId: selection.brand_id,
    accounts: JSON.parse(decryptToken(selection.accounts_encrypted, encryptionKey, selectionAad(selection))).map(publicAccount),
    grantedScopes: JSON.parse(selection.granted_scopes_json), expiresAt: selection.expires_at,
  });
  const oauthFailure = (response, reason) => response.redirect(`/?connection=instagram-error&reason=${encodeURIComponent(reason)}`);

  app.get('/api/connections/instagram/authorize', requireSession, (request, response) => {
    if (!available) return jsonError(response, 503, 'Configura la aplicación Meta y la clave de cifrado para conectar Instagram.');
    const workspaceId = getActiveWorkspaceId(request.user.id);
    if (!ownsBrand(request.user.id, workspaceId, request.query.brandId)) return jsonError(response, 400, 'Selecciona una marca del espacio activo.');
    database.prepare('DELETE FROM instagram_oauth_states WHERE expires_at <= ?').run(Date.now());
    database.prepare('DELETE FROM instagram_account_selections WHERE expires_at <= ?').run(Date.now());
    const state = randomBytes(32).toString('base64url');
    database.prepare(`INSERT INTO instagram_oauth_states
      (state_hash, user_id, session_token_hash, workspace_id, brand_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(digest(state), request.user.id, request.sessionTokenHash, workspaceId, request.query.brandId, Date.now() + authorizationLifetime);
    const url = new URL(`https://www.facebook.com/${config.graphVersion}/dialog/oauth`);
    for (const [key, value] of Object.entries({
      client_id: config.appId, redirect_uri: config.redirectUri, response_type: 'code', state,
      scope: [...requiredPermissions, 'business_management'].join(','),
    })) url.searchParams.set(key, value);
    response.redirect(url.href);
  });

  app.get('/api/connections/instagram/callback', async (request, response) => {
    const state = typeof request.query.state === 'string' ? request.query.state : '';
    const record = state ? database.prepare('SELECT * FROM instagram_oauth_states WHERE state_hash = ?').get(digest(state)) : null;
    if (record) database.prepare('DELETE FROM instagram_oauth_states WHERE state_hash = ?').run(record.state_hash);
    if (!record) return oauthFailure(response, 'invalid-state');
    if (record.expires_at <= Date.now()) return oauthFailure(response, 'state-expired');
    const sessionCookie = (request.get('cookie') || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('lop_session='));
    const session = sessionCookie?.slice('lop_session='.length);
    if (!session || digest(session) !== record.session_token_hash
      || !sessionValid(record.user_id, record.session_token_hash)) return oauthFailure(response, 'session-expired');
    if (request.query.error === 'access_denied') return oauthFailure(response, 'cancelled');
    if (request.query.error || typeof request.query.code !== 'string' || !request.query.code) return oauthFailure(response, 'provider-error');
    if (!available) return oauthFailure(response, 'not-configured');
    if (!ownsBrand(record.user_id, record.workspace_id, record.brand_id)) return oauthFailure(response, 'invalid-state');
    try {
      const short = await graph('oauth/access_token', '', {}, {
        client_id: config.appId, client_secret: config.appSecret, redirect_uri: config.redirectUri, code: request.query.code,
      });
      if (typeof short.access_token !== 'string' || !short.access_token) throw invalidAuthorization();
      const extended = await graph('oauth/access_token', '', {}, {
        client_id: config.appId, client_secret: config.appSecret, grant_type: 'fb_exchange_token', fb_exchange_token: short.access_token,
      });
      if (typeof extended.access_token !== 'string' || !extended.access_token) throw invalidAuthorization();
      const userToken = extended.access_token;
      const permissionData = await edge('me/permissions', userToken, {});
      const scopes = permissionData.filter((item) => item.status === 'granted').map((item) => item.permission);
      if (requiredPermissions.some((scope) => !scopes.includes(scope))) throw invalidAuthorization('permissions-missing');
      const userExpiry = await inspectToken(userToken, requiredPermissions);
      const pages = await discoverPages(userToken, scopes, record.user_id);
      const accounts = [];
      const errors = [];
      for (const page of pages) {
        try {
          const account = await inspectAccount({ pageId: page.id, accessToken: page.access_token, expiresAt: userExpiry });
          if (!accounts.some((item) => item.id === account.id)) accounts.push(account);
        } catch (error) { errors.push(error); }
      }
      if (!accounts.length) {
        if (errors.length) throw errors[0];
        return oauthFailure(response, 'no-professional-accounts');
      }
      if (record.expires_at <= Date.now()) return oauthFailure(response, 'state-expired');
      if (!sessionValid(record.user_id, record.session_token_hash)) return oauthFailure(response, 'session-expired');
      if (!ownsBrand(record.user_id, record.workspace_id, record.brand_id)) return oauthFailure(response, 'invalid-state');
      const selection = { id: `instagram-selection-${randomUUID()}`, user_id: record.user_id, session_token_hash: record.session_token_hash };
      database.prepare(`INSERT INTO instagram_account_selections
        (id, user_id, session_token_hash, workspace_id, brand_id, accounts_encrypted, granted_scopes_json, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(selection.id, record.user_id, record.session_token_hash, record.workspace_id, record.brand_id,
          encryptToken(JSON.stringify(accounts), encryptionKey, selectionAad(selection)), JSON.stringify(scopes), Date.now() + authorizationLifetime);
      return response.redirect(`/?connection=instagram-select&selection=${encodeURIComponent(selection.id)}`);
    } catch (error) {
      return oauthFailure(response, error.reason || (error.providerCode === 190 ? 'token-invalid' : 'provider-error'));
    }
  });

  app.get('/api/connections/instagram/selections/pending', requireSession, (request, response) => {
    if (!available) return response.json({ pending: [] });
    try {
      const selections = database.prepare(`SELECT * FROM instagram_account_selections
        WHERE user_id = ? AND session_token_hash = ? AND expires_at > ? ORDER BY created_at DESC`)
        .all(request.user.id, request.sessionTokenHash, Date.now());
      return response.json({ pending: selections.map(decodeSelection) });
    } catch { return jsonError(response, 500, 'No se pudo recuperar la selección cifrada de Instagram.'); }
  });
  app.get('/api/connections/instagram/selections/:selectionId', requireSession, (request, response) => {
    const selection = readSelection(request, request.params.selectionId);
    if (!selection || selection.expires_at <= Date.now()) return jsonError(response, 404, 'La selección de Instagram venció o no existe en esta sesión.');
    if (!available) return jsonError(response, 503, 'La conexión de Instagram no está configurada.');
    try { return response.json({ selection: decodeSelection(selection) }); }
    catch { return jsonError(response, 500, 'No se pudo recuperar la selección cifrada de Instagram.'); }
  });
  app.post('/api/connections/instagram/selections/:selectionId', requireSession, async (request, response) => {
    const selection = readSelection(request, request.params.selectionId);
    if (!selection || selection.expires_at <= Date.now()) return jsonError(response, 404, 'La selección de Instagram venció o no existe en esta sesión.');
    if (!available) return jsonError(response, 503, 'La conexión de Instagram no está configurada.');
    const requested = request.body?.accounts;
    if (!Array.isArray(requested) || !requested.length || requested.length > 100) return jsonError(response, 400, 'Selecciona al menos una cuenta de Instagram.');
    try {
      const accounts = new Map(JSON.parse(decryptToken(selection.accounts_encrypted, encryptionKey, selectionAad(selection)))
        .map((account) => [account.id, account]));
      const seen = new Set();
      for (const item of requested) {
        if (!item || !accounts.has(item.providerAccountId) || seen.has(item.providerAccountId)
          || !ownsBrand(request.user.id, item.workspaceId, item.brandId)) {
          return jsonError(response, 400, 'Cada cuenta seleccionada debe pertenecer a esta autorización y asignarse a una marca propia.');
        }
        seen.add(item.providerAccountId);
      }
      const verified = [];
      for (const item of requested) verified.push({ ...item, account: await inspectAccount(accounts.get(item.providerAccountId)) });
      if (selection.expires_at <= Date.now()) return jsonError(response, 409, 'La selección venció durante la verificación. Inicia de nuevo la conexión.');
      database.transaction(() => {
        if (!sessionValid(request.user.id, request.sessionTokenHash)) throw Object.assign(new Error('La sesión venció.'), { localStatus: 401 });
        if (selection.expires_at <= Date.now() || !readSelection(request, selection.id)) {
          throw Object.assign(new Error('La selección ya fue utilizada o venció.'), { localStatus: 409 });
        }
        if (verified.some((item) => !ownsBrand(request.user.id, item.workspaceId, item.brandId))) {
          throw Object.assign(new Error('La marca cambió durante la verificación.'), { localStatus: 409 });
        }
        for (const { account, workspaceId, brandId } of verified) {
          const existing = database.prepare('SELECT id, account_id FROM instagram_connections WHERE user_id = ? AND provider_account_id = ?')
            .get(request.user.id, account.id);
          const accountId = existing?.account_id || `social-${randomUUID()}`;
          database.prepare(`INSERT INTO social_accounts (id, user_id, name, network_id, status, preference_enabled, workspace_id, brand_id)
            VALUES (?, ?, ?, 'instagram', 'demo', 1, ?, ?) ON CONFLICT(user_id, id) DO UPDATE SET
            name = excluded.name, workspace_id = excluded.workspace_id, brand_id = excluded.brand_id`)
            .run(accountId, request.user.id, account.name, workspaceId, brandId);
          database.prepare(`INSERT INTO instagram_connections
            (id, user_id, account_id, workspace_id, brand_id, provider_account_id, page_id, page_name, username,
              status, access_token_encrypted, expires_at, granted_scopes_json, verified_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?, ?, ?)
            ON CONFLICT(user_id, provider_account_id) DO UPDATE SET workspace_id = excluded.workspace_id,
              brand_id = excluded.brand_id, page_id = excluded.page_id, page_name = excluded.page_name,
              username = excluded.username, status = 'connected', access_token_encrypted = excluded.access_token_encrypted,
              expires_at = excluded.expires_at, granted_scopes_json = excluded.granted_scopes_json,
              verified_at = excluded.verified_at, updated_at = CURRENT_TIMESTAMP`)
            .run(existing?.id || `instagram-${randomUUID()}`, request.user.id, accountId, workspaceId, brandId,
              account.id, account.pageId, account.pageName, account.username,
              encryptToken(account.accessToken, encryptionKey, `${request.user.id}:instagram:${accountId}`),
              account.expiresAt, selection.granted_scopes_json, account.verifiedAt);
        }
        database.prepare('DELETE FROM instagram_account_selections WHERE id = ?').run(selection.id);
      })();
      return response.status(201).json({ connectedCount: verified.length });
    } catch (error) {
      if (error.localStatus) return jsonError(response, error.localStatus, 'La sesión o la selección cambió durante la verificación. Inicia de nuevo la conexión.');
      return jsonError(response, invalidTokenError(error) ? 400 : 502,
        invalidTokenError(error) ? 'Meta ya no confirma el token, los permisos o la cuenta. Inicia de nuevo la conexión de Instagram.'
          : 'No se pudo verificar Instagram con Meta. Las conexiones guardadas se conservaron; inténtalo de nuevo.');
    }
  });
  app.delete('/api/connections/instagram/selections/:selectionId', requireSession, (request, response) => {
    const result = database.prepare(`DELETE FROM instagram_account_selections
      WHERE id = ? AND user_id = ? AND session_token_hash = ?`).run(request.params.selectionId, request.user.id, request.sessionTokenHash);
    return result.changes ? response.status(204).end() : jsonError(response, 404, 'La selección no existe en esta sesión.');
  });
  app.post('/api/connections/:connectionId/verify', requireSession, async (request, response) => {
    const connection = database.prepare(`SELECT * FROM instagram_connections WHERE id = ? AND user_id = ? AND workspace_id = ?`)
      .get(request.params.connectionId, request.user.id, getActiveWorkspaceId(request.user.id));
    if (!connection) return jsonError(response, 404, 'No se encontró esa conexión de Instagram en el espacio activo.');
    if (!available) return jsonError(response, 503, 'La conexión de Instagram no está configurada.');
    try {
      const accessToken = decryptToken(connection.access_token_encrypted, encryptionKey, `${request.user.id}:instagram:${connection.account_id}`);
      const account = await inspectAccount({ accessToken, pageId: connection.page_id, id: connection.provider_account_id, expiresAt: connection.expires_at });
      if (!sessionValid(request.user.id, request.sessionTokenHash)) return jsonError(response, 401, 'La sesión venció durante la verificación.');
      if (!database.prepare('SELECT 1 FROM instagram_connections WHERE id = ? AND user_id = ? AND workspace_id = ?')
        .get(connection.id, request.user.id, connection.workspace_id)) return jsonError(response, 409, 'La conexión cambió durante la verificación. Actualiza las cuentas.');
      database.transaction(() => {
        const updated = database.prepare(`UPDATE instagram_connections SET status = 'connected', username = ?, page_name = ?,
          expires_at = ?, verified_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND user_id = ? AND workspace_id = ? AND access_token_encrypted = ?`)
          .run(account.username, account.pageName, account.expiresAt, account.verifiedAt,
            connection.id, request.user.id, connection.workspace_id, connection.access_token_encrypted);
        if (!updated.changes) throw Object.assign(new Error('La conexión cambió.'), { localStatus: 409 });
        database.prepare('UPDATE social_accounts SET name = ? WHERE id = ? AND user_id = ?')
          .run(account.name, connection.account_id, request.user.id);
      })();
      return response.json({ status: 'connected', verified: true, verifiedAt: account.verifiedAt, message: 'Meta verificó el token, los permisos y la cuenta profesional vinculada.' });
    } catch (error) {
      if (!sessionValid(request.user.id, request.sessionTokenHash)) return jsonError(response, 401, 'La sesión venció durante la verificación.');
      if (error.localStatus) return jsonError(response, error.localStatus, 'La conexión cambió durante la verificación. Actualiza las cuentas.');
      if (!invalidTokenError(error)) return jsonError(response, 502, 'Meta no pudo responder a la verificación. Se conservó el estado anterior; inténtalo de nuevo.');
      const updated = database.prepare(`UPDATE instagram_connections SET status = 'expired', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ? AND workspace_id = ? AND access_token_encrypted = ?`)
        .run(connection.id, request.user.id, connection.workspace_id, connection.access_token_encrypted);
      if (!updated.changes) return jsonError(response, 409, 'La conexión cambió durante la verificación. Actualiza las cuentas.');
      return response.json({ status: 'expired', verified: false, verifiedAt: connection.verified_at, message: 'Meta ya no confirma esta autorización o su cuenta vinculada. Vuelve a conectar Instagram.' });
    }
  });
}
