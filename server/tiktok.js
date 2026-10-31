import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const tiktokRequiredScopes = Object.freeze(['user.info.basic']);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const lifetime = 30 * 60 * 1000;

export function createTikTokOAuthConfig(environment = process.env) {
  const missing = ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REDIRECT_URI'].filter((key) => !environment[key]);
  let redirectUri = '';
  if (environment.TIKTOK_REDIRECT_URI) {
    const redirect = new URL(environment.TIKTOK_REDIRECT_URI);
    if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.search || redirect.hash
      || redirect.href.length >= 512 || redirect.pathname !== '/api/connections/tiktok/callback'
      || ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) || redirect.hostname.endsWith('.localhost')) {
      throw new Error('TIKTOK_REDIRECT_URI debe ser una URL pública HTTPS que termine en /api/connections/tiktok/callback.');
    }
    redirectUri = redirect.href;
  }
  return { configured: !missing.length, missing, clientKey: environment.TIKTOK_CLIENT_KEY || '', clientSecret: environment.TIKTOK_CLIENT_SECRET || '', redirectUri };
}

export function initializeTikTokDatabase(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tiktok_oauth_states (
      state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_token_hash TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tiktok_connections (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE, provider_account_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('connected', 'expired')), credentials_encrypted TEXT NOT NULL,
      granted_scopes_json TEXT NOT NULL DEFAULT '[]', expires_at INTEGER NOT NULL, verified_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id, account_id) REFERENCES social_accounts(user_id, id) ON DELETE CASCADE,
      UNIQUE(user_id, provider_account_id)
    );
    CREATE INDEX IF NOT EXISTS tiktok_connections_context ON tiktok_connections(user_id, workspace_id, brand_id);
    CREATE INDEX IF NOT EXISTS tiktok_oauth_expiry ON tiktok_oauth_states(expires_at);
  `);
}

export function getTikTokConnections(database, userId, workspaceId) {
  return database.prepare(`SELECT c.id, c.account_id AS accountId, 'tiktok' AS networkId,
    c.provider_account_id AS providerAccountId, c.status, c.expires_at AS expiresAt,
    c.granted_scopes_json AS grantedScopes, c.verified_at AS verifiedAt,
    c.workspace_id AS workspaceId, c.brand_id AS brandId, a.name
    FROM tiktok_connections c JOIN social_accounts a ON a.user_id = c.user_id AND a.id = c.account_id
    WHERE c.user_id = ? AND c.workspace_id = ? ORDER BY a.name, c.id`).all(userId, workspaceId)
    .map((row) => ({ ...row, status: row.expiresAt <= Date.now() ? 'expired' : row.status, grantedScopes: JSON.parse(row.grantedScopes) }));
}

export function registerTikTokRoutes({ app, database, config, encryptionKey, encryptToken, decryptToken,
  requireSession, getActiveWorkspaceId, parseCookies, fetchImpl }) {
  const available = Boolean(config.configured && encryptionKey);
  const sessionValid = (userId, sessionHash) => Boolean(database.prepare('SELECT 1 FROM sessions WHERE user_id = ? AND token_hash = ? AND expires_at > ?').get(userId, sessionHash, Date.now()));
  const ownsBrand = (userId, workspaceId, brandId) => typeof brandId === 'string' && Boolean(database.prepare(`SELECT 1 FROM brands b JOIN workspaces w ON w.id = b.workspace_id WHERE w.user_id = ? AND w.id = ? AND b.id = ?`).get(userId, workspaceId, brandId));
  const failure = (reason) => Object.assign(new Error('No se pudo verificar TikTok.'), { tiktokReason: reason });
  const jsonError = (response, status, error) => response.status(status).json({ error });
  const tokenRequest = async (parameters) => {
    const response = await fetchImpl('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_key: config.clientKey, client_secret: config.clientSecret, ...parameters }),
      signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    const body = await response.json();
    if (!response.ok || body.error) throw failure(body.error === 'invalid_grant' ? 'token-invalid' : 'provider-error');
    const scopes = typeof body.scope === 'string' ? body.scope.split(',').map((scope) => scope.trim()) : [];
    if (!tiktokRequiredScopes.every((scope) => scopes.includes(scope))) throw failure('permissions-missing');
    if (typeof body.access_token !== 'string' || !body.access_token || typeof body.refresh_token !== 'string' || !body.refresh_token
      || typeof body.open_id !== 'string' || !body.open_id || !Number.isFinite(body.expires_in) || body.expires_in <= 0
      || !Number.isFinite(body.refresh_expires_in) || body.refresh_expires_in <= 0) throw failure('provider-error');
    return { accessToken: body.access_token, refreshToken: body.refresh_token, openId: body.open_id,
      expiresAt: Date.now() + body.expires_in * 1000, refreshExpiresAt: Date.now() + body.refresh_expires_in * 1000, scopes };
  };
  const readProfile = async (credentials) => {
    const response = await fetchImpl('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url', {
      headers: { Authorization: `Bearer ${credentials.accessToken}` }, signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    const body = await response.json();
    if (!response.ok || (body.error?.code && body.error.code !== 'ok')) throw failure(response.status === 401 ? 'token-invalid' : 'provider-error');
    const profile = body.data?.user;
    if (!profile || profile.open_id !== credentials.openId || typeof profile.display_name !== 'string' || !profile.display_name.trim()) throw failure('provider-error');
    return { name: profile.display_name.trim().slice(0, 120), verifiedAt: new Date().toISOString() };
  };

  app.get('/api/connections/tiktok/authorize', requireSession, (request, response) => {
    if (!available) return jsonError(response, 503, 'La conexión de TikTok está pendiente de habilitación.');
    const workspaceId = getActiveWorkspaceId(request.user.id);
    if (!ownsBrand(request.user.id, workspaceId, request.query.brandId)) return jsonError(response, 400, 'Selecciona una marca de tu espacio.');
    database.prepare('DELETE FROM tiktok_oauth_states WHERE expires_at <= ?').run(Date.now());
    const state = randomBytes(32).toString('base64url');
    database.prepare('INSERT INTO tiktok_oauth_states VALUES (?, ?, ?, ?, ?, ?)')
      .run(hash(state), request.user.id, request.sessionTokenHash, workspaceId, request.query.brandId, Date.now() + lifetime);
    const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
    for (const [key, value] of Object.entries({ client_key: config.clientKey, response_type: 'code', redirect_uri: config.redirectUri, scope: tiktokRequiredScopes.join(','), state })) url.searchParams.set(key, value);
    return response.redirect(url.href);
  });

  app.get('/api/connections/tiktok/callback', async (request, response) => {
    const fail = () => response.redirect('/?connection=tiktok-error');
    const state = typeof request.query.state === 'string' ? request.query.state : '';
    const record = state ? database.prepare('SELECT * FROM tiktok_oauth_states WHERE state_hash = ?').get(hash(state)) : null;
    if (record) database.prepare('DELETE FROM tiktok_oauth_states WHERE state_hash = ?').run(record.state_hash);
    const token = parseCookies(request.get('cookie')).lop_session;
    const valid = () => record && record.expires_at > Date.now() && token && hash(token) === record.session_token_hash
      && sessionValid(record.user_id, record.session_token_hash) && ownsBrand(record.user_id, record.workspace_id, record.brand_id);
    if (!available || !valid() || request.query.error || typeof request.query.code !== 'string' || !request.query.code) return fail();
    try {
      const credentials = await tokenRequest({ grant_type: 'authorization_code', code: request.query.code, redirect_uri: config.redirectUri });
      const profile = await readProfile(credentials);
      if (!valid()) return fail();
      database.transaction(() => {
        const previous = database.prepare('SELECT id, account_id FROM tiktok_connections WHERE user_id = ? AND provider_account_id = ?').get(record.user_id, credentials.openId);
        const id = previous?.id || `tiktok-${randomUUID()}`;
        const accountId = previous?.account_id || `account-${randomUUID()}`;
        database.prepare(`INSERT INTO social_accounts (id, user_id, name, network_id, status, preference_enabled, workspace_id, brand_id)
          VALUES (?, ?, ?, 'tiktok', 'demo', 1, ?, ?) ON CONFLICT(user_id, id) DO UPDATE SET name = excluded.name, workspace_id = excluded.workspace_id, brand_id = excluded.brand_id`)
          .run(accountId, record.user_id, profile.name, record.workspace_id, record.brand_id);
        database.prepare(`INSERT INTO tiktok_connections (id, user_id, account_id, workspace_id, brand_id, provider_account_id, status, credentials_encrypted, granted_scopes_json, expires_at, verified_at)
          VALUES (?, ?, ?, ?, ?, ?, 'connected', ?, ?, ?, ?) ON CONFLICT(user_id, provider_account_id) DO UPDATE SET
          workspace_id = excluded.workspace_id, brand_id = excluded.brand_id, status = 'connected', credentials_encrypted = excluded.credentials_encrypted,
          granted_scopes_json = excluded.granted_scopes_json, expires_at = excluded.expires_at, verified_at = excluded.verified_at, updated_at = CURRENT_TIMESTAMP`)
          .run(id, record.user_id, accountId, record.workspace_id, record.brand_id, credentials.openId,
            encryptToken(JSON.stringify(credentials), encryptionKey, `tiktok-connection:${record.user_id}:${id}`), JSON.stringify(credentials.scopes), credentials.expiresAt, profile.verifiedAt);
      })();
      return response.redirect('/?connection=tiktok-connected');
    } catch { return fail(); }
  });

  app.post('/api/connections/:connectionId/verify', requireSession, async (request, response, next) => {
    const connection = database.prepare('SELECT * FROM tiktok_connections WHERE id = ? AND user_id = ? AND workspace_id = ?').get(request.params.connectionId, request.user.id, getActiveWorkspaceId(request.user.id));
    if (!connection) return next();
    if (!available) return jsonError(response, 503, 'La conexión de TikTok está pendiente de habilitación.');
    try {
      const previous = JSON.parse(decryptToken(connection.credentials_encrypted, encryptionKey, `tiktok-connection:${request.user.id}:${connection.id}`));
      if (previous.refreshExpiresAt <= Date.now()) throw failure('token-invalid');
      const credentials = await tokenRequest({ grant_type: 'refresh_token', refresh_token: previous.refreshToken });
      if (credentials.openId !== connection.provider_account_id) throw failure('token-invalid');
      const profile = await readProfile(credentials);
      if (!sessionValid(request.user.id, request.sessionTokenHash)) return jsonError(response, 401, 'La sesión venció.');
      const updated = database.transaction(() => {
        const result = database.prepare(`UPDATE tiktok_connections SET status = 'connected', credentials_encrypted = ?, granted_scopes_json = ?, expires_at = ?, verified_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND user_id = ? AND workspace_id = ? AND credentials_encrypted = ?`)
          .run(encryptToken(JSON.stringify(credentials), encryptionKey, `tiktok-connection:${request.user.id}:${connection.id}`), JSON.stringify(credentials.scopes), credentials.expiresAt, profile.verifiedAt, connection.id, request.user.id, connection.workspace_id, connection.credentials_encrypted);
        if (result.changes) database.prepare('UPDATE social_accounts SET name = ? WHERE user_id = ? AND id = ?').run(profile.name, request.user.id, connection.account_id);
        return result.changes;
      })();
      if (!updated) return jsonError(response, 409, 'La conexión cambió durante la verificación.');
      return response.json({ verified: true, status: 'connected', verifiedAt: profile.verifiedAt, message: 'TikTok confirmó tu perfil y el acceso renovable.' });
    } catch (error) {
      return jsonError(response, error.tiktokReason === 'permissions-missing' ? 403 : 502, 'TikTok no pudo confirmar el acceso. Se conservaron la conexión y sus credenciales.');
    }
  });
}
