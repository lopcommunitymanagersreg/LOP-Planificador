import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { createApp, createYouTubeOAuthConfig } from '../server/index.js';

const origin = 'http://localhost:5173';
const readOnlyScope = 'https://www.googleapis.com/auth/youtube.readonly';
const uploadScope = 'https://www.googleapis.com/auth/youtube.upload';
const requiredScopes = [readOnlyScope, uploadScope];
const encryptionKey = Buffer.alloc(32, 11);
const clientId = 'test-youtube-client.apps.googleusercontent.com';
const channelOne = 'UC1111111111111111111111';
const channelTwo = 'UC2222222222222222222222';
const channelOther = 'UC3333333333333333333333';
const hash = (value) => createHash('sha256').update(value).digest('hex');

test('YouTube OAuth preserves local development and requires a public HTTPS callback in production', () => {
  const environment = {
    NODE_ENV: 'development',
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: 'test-youtube-client-secret',
    GOOGLE_REDIRECT_URI: `${origin}/api/auth/google/callback`,
  };
  const development = createYouTubeOAuthConfig(environment);
  assert.equal(development.configured, true);
  assert.equal(development.redirectUri, `${origin}/api/connections/youtube/callback`);
  assert.throws(() => createYouTubeOAuthConfig({ ...environment, NODE_ENV: 'production' }), /producción/);
  for (const hostname of ['localhost', '127.0.0.1', '[::1]', 'app.localhost']) {
    for (const protocol of ['http:', 'https:']) {
      assert.throws(() => createYouTubeOAuthConfig({
        ...environment,
        NODE_ENV: 'production',
        YOUTUBE_REDIRECT_URI: `${protocol}//${hostname}/api/connections/youtube/callback`,
      }), `production must reject ${protocol}//${hostname}`);
    }
  }
  for (const redirectUri of [
    'http://app.example.com/api/connections/youtube/callback',
    'https://user:password@app.example.com/api/connections/youtube/callback',
  ]) {
    assert.throws(() => createYouTubeOAuthConfig({ ...environment, NODE_ENV: 'production', YOUTUBE_REDIRECT_URI: redirectUri }));
  }
  const production = createYouTubeOAuthConfig({
    ...environment,
    NODE_ENV: 'production',
    YOUTUBE_REDIRECT_URI: 'https://app.example.com/api/connections/youtube/callback',
  });
  assert.equal(production.configured, true);
  assert.equal(production.redirectUri, 'https://app.example.com/api/connections/youtube/callback');
});

test('Production keeps injected Google OAuth credentials instead of replacing them with local development values', () => {
  const script = `
    console.log(JSON.stringify({
      clientId: process.env.GOOGLE_CLIENT_ID === 'test-production-client-id',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET === 'test-production-client-secret',
      redirectUri: process.env.GOOGLE_REDIRECT_URI === 'https://app.example.com/api/auth/google/callback',
    }));
  `;
  const child = spawnSync(process.execPath, ['-r', './server/load-env.cjs', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      GOOGLE_CLIENT_ID: 'test-production-client-id',
      GOOGLE_CLIENT_SECRET: 'test-production-client-secret',
      GOOGLE_REDIRECT_URI: 'https://app.example.com/api/auth/google/callback',
    },
  });
  assert.equal(child.status, 0, 'the production environment loader starts successfully');
  assert.deepEqual(JSON.parse(child.stdout.trim()), { clientId: true, clientSecret: true, redirectUri: true });
  assert.equal(child.stdout.includes('test-production-client-secret'), false, 'the subprocess reports only comparison results');
});

function decryptJson(encrypted, aad) {
  const [nonce, tag, ciphertext] = encrypted.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
}

function encryptJson(value, aad) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [nonce, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

function createYouTubeProvider() {
  const provider = {
    authorizationOptions: null,
    exchanges: 0,
    tokenInfoCalls: [],
    refreshCalls: [],
    apiCalls: [],
    infoMode: 'valid',
    apiMode: 'valid',
    refreshMode: 'valid',
    missingRefreshToken: false,
    rotateRefreshToken: false,
    paginated: false,
    initialExpiry: Date.now() + 60 * 60 * 1000,
    beforeResponse: null,
  };
  const channel = (id, title, customUrl) => ({ id, snippet: { title, customUrl } });
  const channels = [channel(channelOne, 'Canal Uno', '@canal.uno'), channel(channelTwo, 'Canal Dos', '@canal.dos')];
  const reply = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, async json() { return payload; } });
  provider.oauthClient = {
    generateAuthUrl(options) {
      provider.authorizationOptions = options;
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      for (const [key, value] of Object.entries(options)) url.searchParams.set(key, Array.isArray(value) ? value.join(' ') : String(value));
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', `${origin}/api/connections/youtube/callback`);
      return url.href;
    },
    async getToken(code) {
      assert.equal(code, 'test-youtube-authorization-code');
      provider.exchanges += 1;
      return { tokens: {
        access_token: 'test-youtube-access-initial',
        ...(provider.missingRefreshToken ? {} : { refresh_token: 'test-youtube-refresh-initial' }),
        scope: requiredScopes.join(' '),
        expiry_date: provider.initialExpiry,
      } };
    },
    async getTokenInfo(accessToken) {
      assert.match(accessToken, /^test-youtube-access-/);
      provider.tokenInfoCalls.push(accessToken);
      if (provider.infoMode === 'revoked') throw Object.assign(new Error('invalid token test-youtube-access-initial'), {
        response: { status: 400, data: { error: 'invalid_token' } },
      });
      return {
        aud: provider.infoMode === 'wrong-audience' ? 'another-client.apps.googleusercontent.com' : clientId,
        scopes: provider.infoMode === 'missing-scope' ? ['openid', 'email']
          : provider.infoMode === 'missing-upload' ? [readOnlyScope]
          : provider.infoMode === 'missing-readonly' ? [uploadScope]
          : requiredScopes,
        expiry_date: accessToken === 'test-youtube-access-initial' ? provider.initialExpiry : Date.now() + 60 * 60 * 1000,
      };
    },
    async refreshToken(refreshToken) {
      assert.match(refreshToken, /^test-youtube-refresh-/);
      provider.refreshCalls.push(refreshToken);
      if (provider.refreshMode === 'invalid-grant') throw Object.assign(new Error('invalid_grant test-youtube-refresh-initial'), {
        response: { status: 400, data: { error: 'invalid_grant', error_description: 'Refresh grant was revoked' } },
      });
      if (provider.refreshMode === 'transient') throw Object.assign(new Error('Temporary token service problem'), {
        response: { status: 503, data: { error: 'temporarily_unavailable' } },
      });
      return { tokens: {
        access_token: `test-youtube-access-refreshed-${provider.refreshCalls.length}`,
        ...(provider.rotateRefreshToken ? { refresh_token: `test-youtube-refresh-rotated-${provider.refreshCalls.length}` } : {}),
        expiry_date: Date.now() + 60 * 60 * 1000,
        scope: requiredScopes.join(' '),
      } };
    },
  };
  provider.fetch = async (input, options = {}) => {
    const url = new URL(input);
    assert.ok(['https://youtube.googleapis.com', 'https://www.googleapis.com'].includes(url.origin));
    assert.equal(url.pathname, '/youtube/v3/channels');
    assert.equal(url.searchParams.get('mine'), 'true', 'ownership is proved using the authenticated channel list');
    assert.equal(url.searchParams.has('id'), false, 'public channel lookup alone cannot prove ownership');
    assert.equal(url.searchParams.get('part'), 'snippet');
    assert.equal(url.searchParams.has('access_token'), false);
    assert.equal(url.searchParams.has('key'), false);
    const authorization = new Headers(options.headers).get('authorization');
    assert.match(authorization || '', /^Bearer test-youtube-access-/);
    provider.apiCalls.push({ pageToken: url.searchParams.get('pageToken'), authorization });
    const override = await provider.beforeResponse?.({ url, options, authorization });
    if (override) return reply(override.payload, override.status);
    if (provider.apiMode === 'transient') return reply({ error: { code: 503, errors: [{ reason: 'backendError' }] } }, 503);
    if (provider.apiMode === 'disabled') return reply({ error: { code: 403, errors: [{ reason: 'accessNotConfigured' }], message: 'YouTube Data API has not been used in this project or is disabled.' } }, 403);
    if (provider.apiMode === 'revoked') return reply({ error: { code: 401, errors: [{ reason: 'authError' }] } }, 401);
    if (provider.apiMode === 'wrong-channel') return reply({ items: [channel(channelOther, 'Otro canal', '@otro.canal')] });
    if (provider.apiMode === 'no-channels') return reply({ items: [] });
    if (provider.paginated) return url.searchParams.get('pageToken') === 'test-next-page'
      ? reply({ items: [channels[1]] })
      : reply({ items: [channels[0]], nextPageToken: 'test-next-page' });
    return reply({ items: channels });
  };
  return provider;
}

function pauseApi(provider, override) {
  let release;
  let markStarted;
  let timer;
  const continuing = new Promise((done) => { release = done; });
  const started = new Promise((done, reject) => {
    timer = setTimeout(() => reject(new Error('The expected mocked YouTube API request never started')), 5000);
    timer.unref();
    markStarted = () => { clearTimeout(timer); done(); };
  });
  provider.beforeResponse = async () => {
    provider.beforeResponse = null;
    markStarted();
    await continuing;
    return override;
  };
  return { started, release() { clearTimeout(timer); release(); } };
}

async function withYouTube(callback) {
  const directory = mkdtempSync(join(tmpdir(), 'lop-youtube-test-'));
  const provider = createYouTubeProvider();
  const options = {
    databasePath: join(directory, 'test.sqlite'), mailer: null, googleClient: null,
    facebookOAuthConfig: { configured: false, missing: [] },
    instagramOAuthConfig: { configured: false, missing: [] },
    youtubeOAuthConfig: { configured: true, missing: [], clientId, clientSecret: 'test-youtube-client-secret', redirectUri: `${origin}/api/connections/youtube/callback` },
    youtubeOAuthClient: provider.oauthClient,
    socialTokenEncryptionKey: encryptionKey,
    fetchImpl: provider.fetch,
  };
  let app;
  let server;
  const start = async () => {
    app = createApp(options);
    server = app.listen(0, '127.0.0.1');
    await new Promise((done, reject) => { server.once('listening', done); server.once('error', reject); });
  };
  const stop = async () => {
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
    app.locals.database.close();
    server = null;
  };
  await start();
  const fixture = {
    provider,
    get database() { return app.locals.database; },
    async restart() { await stop(); await start(); },
    async request(path, { cookie, method = 'GET', body } = {}) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
        method, redirect: 'manual',
        headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      const payload = text && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null;
      return { response, payload };
    },
    seedOwner(id) {
      const token = `test-youtube-session-${id}`;
      const workspaceId = `workspace-${id}`;
      const brandId = `brand-${id}`;
      fixture.database.prepare('INSERT INTO users (id, name, email, password_hash, email_verified) VALUES (?, ?, ?, ?, 1)').run(id, id, `${id}@example.test`, 'unused-test-password');
      fixture.database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hash(token), id, Date.now() + 5 * 60 * 1000);
      fixture.database.prepare('INSERT INTO workspaces (id, user_id, name) VALUES (?, ?, ?)').run(workspaceId, id, `Espacio ${id}`);
      fixture.database.prepare('INSERT INTO brands (id, workspace_id, name) VALUES (?, ?, ?)').run(brandId, workspaceId, `Marca ${id}`);
      fixture.database.prepare('INSERT INTO user_workspace_settings (user_id, active_workspace_id) VALUES (?, ?)').run(id, workspaceId);
      return { id, cookie: `lop_session=${token}`, sessionHash: hash(token), workspaceId, brandId };
    },
    credentials(owner, connectionId) {
      const { encrypted } = fixture.database.prepare('SELECT credentials_encrypted AS encrypted FROM youtube_connections WHERE id = ?').get(connectionId);
      return decryptJson(encrypted, `youtube-connection:${owner.id}:${connectionId}`);
    },
    expireAccessToken(owner, connectionId) {
      const credentials = fixture.credentials(owner, connectionId);
      credentials.expiresAt = Date.now() + 60_000;
      fixture.database.prepare('UPDATE youtube_connections SET credentials_encrypted = ? WHERE id = ?')
        .run(encryptJson(credentials, `youtube-connection:${owner.id}:${connectionId}`), connectionId);
    },
  };
  try { await callback(fixture); } finally {
    await stop();
    const absolute = resolve(directory);
    if (!absolute.startsWith(`${resolve(tmpdir())}${sep}`) || !basename(absolute).startsWith('lop-youtube-test-')) throw new Error('Refusing to clean an unexpected YouTube test directory');
    rmSync(absolute, { recursive: true, force: true });
  }
}

async function authorize(fixture, owner) {
  const result = await fixture.request(`/connections/youtube/authorize?brandId=${encodeURIComponent(owner.brandId)}`, { cookie: owner.cookie });
  assert.equal(result.response.status, 302);
  return new URL(result.response.headers.get('location'));
}

async function completeCallback(fixture, owner, state) {
  const result = await fixture.request(`/connections/youtube/callback?code=test-youtube-authorization-code&state=${encodeURIComponent(state)}`, { cookie: owner?.cookie });
  assert.equal(result.response.status, 302);
  return new URL(result.response.headers.get('location'), origin);
}

async function discover(fixture, owner) {
  const authorization = await authorize(fixture, owner);
  const redirect = await completeCallback(fixture, owner, authorization.searchParams.get('state'));
  assert.equal(redirect.searchParams.get('connection'), 'youtube-select');
  const id = redirect.searchParams.get('selection');
  assert.ok(id);
  const selection = await fixture.request(`/connections/youtube/selections/${id}`, { cookie: owner.cookie });
  assert.equal(selection.response.status, 200);
  return { id, ...selection.payload.selection };
}

function assignment(owner, providerChannelId = channelOne) {
  return { providerChannelId, workspaceId: owner.workspaceId, brandId: owner.brandId };
}

async function saveSelection(fixture, owner, selection, channels = [assignment(owner)]) {
  return fixture.request(`/connections/youtube/selections/${selection.id}`, { cookie: owner.cookie, method: 'POST', body: { channels } });
}

async function connectOne(fixture, owner) {
  const selection = await discover(fixture, owner);
  const saved = await saveSelection(fixture, owner, selection);
  assert.ok([200, 201].includes(saved.response.status));
  assert.equal(saved.payload.connectedCount, 1);
  const result = await fixture.request('/connections', { cookie: owner.cookie });
  return result.payload.connections.find(({ networkId, providerAccountId }) => networkId === 'youtube' && providerAccountId === channelOne);
}

test('YouTube requests read and upload offline access and binds one-time OAuth state to its live session', async () => {
  await withYouTube(async (fixture) => {
    const owner = fixture.seedOwner('youtube-owner');
    const other = fixture.seedOwner('youtube-other');
    assert.equal((await fixture.request(`/connections/youtube/authorize?brandId=${owner.brandId}`)).response.status, 401);
    const methods = await fixture.request('/connections/methods', { cookie: owner.cookie });
    assert.equal(methods.payload.youtube.available, true);
    const authorization = await authorize(fixture, owner);
    assert.equal(authorization.hostname, 'accounts.google.com');
    assert.deepEqual(fixture.provider.authorizationOptions.scope, requiredScopes);
    assert.deepEqual(methods.payload.youtube.requiredScopes, requiredScopes);
    assert.equal(fixture.provider.authorizationOptions.include_granted_scopes, true);
    assert.equal(fixture.provider.authorizationOptions.access_type, 'offline');
    assert.equal(fixture.provider.authorizationOptions.prompt, 'consent');
    const state = authorization.searchParams.get('state');
    assert.ok(state && state.length >= 32);
    assert.equal((await completeCallback(fixture, other, state)).searchParams.get('connection'), 'youtube-error');
    assert.equal(fixture.provider.exchanges, 0);
    assert.equal((await completeCallback(fixture, owner, state)).searchParams.get('connection'), 'youtube-error');
    assert.equal(fixture.provider.exchanges, 0);
    const expired = await authorize(fixture, owner);
    fixture.database.prepare('UPDATE youtube_oauth_states SET expires_at = ?').run(Date.now() - 1);
    assert.equal((await completeCallback(fixture, owner, expired.searchParams.get('state'))).searchParams.get('reason'), 'state-expired');
    assert.equal(fixture.provider.exchanges, 0);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM youtube_connections').get().n, 0);
  });
});

test('YouTube validates token audience, actual granted scope and refresh grant before offering a channel', async () => {
  await withYouTube(async (fixture) => {
    const owner = fixture.seedOwner('youtube-owner');
    for (const mode of ['wrong-audience', 'missing-scope', 'missing-upload', 'missing-readonly', 'revoked']) {
      fixture.provider.infoMode = mode;
      const authorization = await authorize(fixture, owner);
      const redirect = await completeCallback(fixture, owner, authorization.searchParams.get('state'));
      assert.equal(redirect.searchParams.get('connection'), 'youtube-error', mode);
      assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM youtube_channel_selections').get().n, 0, mode);
    }
    assert.equal(fixture.provider.apiCalls.length, 0, 'untrusted OAuth claims never reach the channel API');
    fixture.provider.infoMode = 'valid';
    fixture.provider.missingRefreshToken = true;
    const authorization = await authorize(fixture, owner);
    assert.equal((await completeCallback(fixture, owner, authorization.searchParams.get('state'))).searchParams.get('connection'), 'youtube-error');
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM youtube_connections').get().n, 0);
    fixture.provider.missingRefreshToken = false;
    fixture.provider.refreshMode = 'invalid-grant';
    const revokedGrant = await authorize(fixture, owner);
    assert.equal((await completeCallback(fixture, owner, revokedGrant.searchParams.get('state'))).searchParams.get('connection'), 'youtube-error');
    assert.equal(fixture.provider.apiCalls.length, 0, 'a nonrenewable grant never offers a connected channel');
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM youtube_channel_selections').get().n, 0);
  });
});

test('YouTube handles disabled API and absent channels without storing a false connection', async () => {
  await withYouTube(async (fixture) => {
    const owner = fixture.seedOwner('youtube-owner');
    for (const mode of ['disabled', 'no-channels']) {
      fixture.provider.apiMode = mode;
      const authorization = await authorize(fixture, owner);
      const redirect = await completeCallback(fixture, owner, authorization.searchParams.get('state'));
      assert.equal(redirect.searchParams.get('connection'), 'youtube-error');
      assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM youtube_channel_selections').get().n, 0);
      assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM social_accounts').get().n, 0);
    }
  });
});

test('YouTube paginates owned channels and keeps pending credentials encrypted and session-isolated', async () => {
  await withYouTube(async (fixture) => {
    const owner = fixture.seedOwner('youtube-owner');
    const other = fixture.seedOwner('youtube-other');
    fixture.provider.paginated = true;
    const selection = await discover(fixture, owner);
    assert.equal(fixture.provider.refreshCalls.length, 1, 'the callback proves that offline access can actually be renewed');
    assert.ok(fixture.provider.tokenInfoCalls.includes('test-youtube-access-initial'));
    assert.ok(fixture.provider.tokenInfoCalls.includes('test-youtube-access-refreshed-1'));
    assert.deepEqual(selection.channels.map(({ id }) => id), [channelOne, channelTwo]);
    assert.equal(selection.workspaceId, owner.workspaceId);
    assert.equal(selection.brandId, owner.brandId);
    assert.ok(fixture.provider.apiCalls.some(({ pageToken }) => pageToken === 'test-next-page'));
    assert.equal(JSON.stringify(selection).includes('test-youtube-access'), false);
    assert.equal(JSON.stringify(selection).includes('test-youtube-refresh'), false);
    const stored = fixture.database.prepare('SELECT credentials_encrypted AS credentials, channels_encrypted AS channels FROM youtube_channel_selections WHERE id = ?').get(selection.id);
    const aad = `youtube-selection:${owner.id}:${owner.sessionHash}:${selection.id}`;
    assert.equal(stored.credentials.includes('test-youtube-refresh'), false);
    assert.equal(decryptJson(stored.credentials, `${aad}:credentials`).refreshToken, 'test-youtube-refresh-initial');
    assert.equal(decryptJson(stored.channels, `${aad}:channels`).length, 2);
    assert.equal((await fixture.request(`/connections/youtube/selections/${selection.id}`, { cookie: other.cookie })).response.status, 404);
    const pending = await fixture.request('/connections/youtube/selections/pending', { cookie: owner.cookie });
    assert.equal(pending.payload.pending.length, 1);
    assert.equal(pending.payload.pending[0].workspaceId, owner.workspaceId);
    assert.equal(JSON.stringify(pending.payload).includes('test-youtube-refresh'), false);
    assert.equal((await fixture.request('/connections/youtube/selections/pending', { cookie: other.cookie })).payload.pending.length, 0);
  });
});

test('YouTube rechecks channel ownership when saving and only accepts destinations owned by the current user', async () => {
  await withYouTube(async (fixture) => {
    const owner = fixture.seedOwner('youtube-owner');
    const other = fixture.seedOwner('youtube-other');
    const selection = await discover(fixture, owner);
    const foreign = await saveSelection(fixture, owner, selection, [assignment(other)]);
    assert.equal(foreign.response.status, 400);
    fixture.provider.apiMode = 'wrong-channel';
    const staleSelection = await saveSelection(fixture, owner, selection);
    assert.equal(staleSelection.response.status, 400);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM youtube_connections').get().n, 0);
    fixture.provider.apiMode = 'valid';
    const saved = await saveSelection(fixture, owner, selection);
    assert.ok([200, 201].includes(saved.response.status));
    assert.equal(saved.payload.connectedCount, 1);
    assert.equal((await fixture.request(`/connections/youtube/selections/${selection.id}`, { cookie: owner.cookie })).response.status, 404);
    const connection = (await fixture.request('/connections', { cookie: owner.cookie })).payload.connections[0];
    const credentials = fixture.credentials(owner, connection.id);
    assert.equal(credentials.refreshToken, 'test-youtube-refresh-initial');
    assert.ok(credentials.expiresAt > Date.now());
    const data = await fixture.request('/data', { cookie: owner.cookie });
    assert.equal(data.payload.accounts[0].status, 'connected');
    assert.equal(data.payload.accounts[0].networkId, 'youtube');
    assert.equal(JSON.stringify(data.payload).includes('test-youtube-access'), false);
    assert.equal(JSON.stringify(data.payload).includes('test-youtube-refresh'), false);
    assert.equal((await fixture.request('/data', { cookie: other.cookie })).payload.accounts.length, 0);
    assert.equal((await fixture.request(`/connections/${connection.id}/verify`, { cookie: other.cookie, method: 'POST' })).response.status, 404);
    const summary = await fixture.request(`/connections/summary?workspaceId=${owner.workspaceId}&brandId=${owner.brandId}`, { cookie: owner.cookie });
    assert.equal(summary.payload.officialConnections, 1);
    assert.equal(summary.payload.registeredAccounts, 1);
  });
});

test('YouTube refreshes expiring access before verification and persists rotated refresh credentials encrypted', async () => {
  await withYouTube(async (fixture) => {
    const owner = fixture.seedOwner('youtube-owner');
    const connection = await connectOne(fixture, owner);
    const refreshCount = fixture.provider.refreshCalls.length;
    fixture.expireAccessToken(owner, connection.id);
    fixture.provider.rotateRefreshToken = true;
    const verified = await fixture.request(`/connections/${connection.id}/verify`, { cookie: owner.cookie, method: 'POST' });
    assert.equal(verified.response.status, 200);
    assert.equal(verified.payload.status, 'connected');
    assert.equal(verified.payload.verified, true);
    assert.ok(verified.payload.verifiedAt);
    assert.equal(fixture.provider.refreshCalls.length, refreshCount + 1);
    const credentials = fixture.credentials(owner, connection.id);
    assert.equal(credentials.accessToken, `test-youtube-access-refreshed-${refreshCount + 1}`);
    assert.equal(credentials.refreshToken, `test-youtube-refresh-rotated-${refreshCount + 1}`);
    assert.ok(credentials.expiresAt > Date.now() + 5 * 60 * 1000);
    const record = fixture.database.prepare('SELECT credentials_encrypted AS encrypted, verified_at AS verifiedAt, custom_url AS customUrl FROM youtube_connections WHERE id = ?').get(connection.id);
    assert.equal(record.encrypted.includes('test-youtube-refresh'), false);
    assert.ok(record.verifiedAt);
    assert.equal(record.customUrl, '@canal.uno');
    assert.equal(JSON.stringify(verified.payload).includes('test-youtube-access'), false);
  });
});

test('YouTube preserves state on temporary failures and detects lost channel access or revoked refresh grants', async () => {
  await withYouTube(async (fixture) => {
    const owner = fixture.seedOwner('youtube-owner');
    const connection = await connectOne(fixture, owner);
    fixture.provider.apiMode = 'transient';
    let result = await fixture.request(`/connections/${connection.id}/verify`, { cookie: owner.cookie, method: 'POST' });
    assert.equal(result.response.status, 502);
    assert.equal(fixture.database.prepare('SELECT status FROM youtube_connections WHERE id = ?').get(connection.id).status, 'connected');
    fixture.provider.apiMode = 'wrong-channel';
    result = await fixture.request(`/connections/${connection.id}/verify`, { cookie: owner.cookie, method: 'POST' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.status, 'expired');
    assert.equal(result.payload.verified, false);
    fixture.provider.apiMode = 'valid';
    result = await fixture.request(`/connections/${connection.id}/verify`, { cookie: owner.cookie, method: 'POST' });
    assert.equal(result.payload.status, 'connected');
    fixture.expireAccessToken(owner, connection.id);
    fixture.provider.refreshMode = 'invalid-grant';
    const messages = [];
    const previousLog = console.error;
    console.error = (...args) => messages.push(args);
    try { result = await fixture.request(`/connections/${connection.id}/verify`, { cookie: owner.cookie, method: 'POST' }); }
    finally { console.error = previousLog; }
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.status, 'expired');
    assert.equal(result.payload.verified, false);
    assert.equal(JSON.stringify(result.payload).includes('test-youtube-refresh'), false);
    assert.equal(JSON.stringify(messages).includes('test-youtube-refresh'), false, 'provider error details cannot leak refresh credentials');
    const summary = await fixture.request(`/connections/summary?workspaceId=${owner.workspaceId}`, { cookie: owner.cookie });
    assert.equal(summary.payload.officialConnections, 0);
  });
});

test('YouTube restart, reassignment and brand removal preserve Facebook and Instagram credentials', async () => {
  await withYouTube(async (fixture) => {
    const owner = fixture.seedOwner('youtube-owner');
    for (const [id, network] of [['preserved-fb-account', 'facebook'], ['preserved-ig-account', 'instagram']]) {
      fixture.database.prepare('INSERT INTO social_accounts (id,user_id,name,network_id,status,workspace_id,brand_id) VALUES (?,?,?,?,\'demo\',?,?)')
        .run(id, owner.id, network, network, owner.workspaceId, owner.brandId);
    }
    fixture.database.prepare(`INSERT INTO social_connections
      (id,user_id,account_id,workspace_id,brand_id,network_id,provider_account_id,provider_user_id,status,access_token_encrypted,granted_scopes_json)
      VALUES ('preserved-fb',?,'preserved-fb-account',?,?,'facebook','700001','10101','connected','unchanged-facebook-ciphertext','[]')`)
      .run(owner.id, owner.workspaceId, owner.brandId);
    fixture.database.prepare(`INSERT INTO instagram_connections
      (id,user_id,account_id,workspace_id,brand_id,provider_account_id,page_id,page_name,username,status,access_token_encrypted,granted_scopes_json,verified_at)
      VALUES ('preserved-ig',?,'preserved-ig-account',?,?,'178414000001','700001','Página existente','marca.existente','connected','unchanged-instagram-ciphertext','[]',?)`)
      .run(owner.id, owner.workspaceId, owner.brandId, new Date().toISOString());
    const connection = await connectOne(fixture, owner);
    const before = fixture.database.prepare('SELECT credentials_encrypted AS encrypted FROM youtube_connections WHERE id = ?').get(connection.id).encrypted;
    await fixture.restart();
    assert.equal(fixture.database.prepare('SELECT credentials_encrypted AS encrypted FROM youtube_connections WHERE id = ?').get(connection.id).encrypted, before);
    assert.equal(fixture.database.prepare("SELECT access_token_encrypted AS token FROM social_connections WHERE id='preserved-fb'").get().token, 'unchanged-facebook-ciphertext');
    assert.equal(fixture.database.prepare("SELECT access_token_encrypted AS token FROM instagram_connections WHERE id='preserved-ig'").get().token, 'unchanged-instagram-ciphertext');
    const destination = await fixture.request(`/workspaces/${owner.workspaceId}/brands`, { cookie: owner.cookie, method: 'POST', body: { name: 'Marca conservada' } });
    assert.equal((await fixture.request(`/connections/${connection.id}`, { cookie: owner.cookie, method: 'PATCH', body: { workspaceId: owner.workspaceId, brandId: destination.payload.id } })).response.status, 204);
    assert.equal((await fixture.request(`/brands/${owner.brandId}`, { cookie: owner.cookie, method: 'DELETE' })).response.status, 204);
    assert.equal(fixture.database.prepare("SELECT brand_id AS brand FROM social_connections WHERE id='preserved-fb'").get().brand, destination.payload.id);
    assert.equal(fixture.database.prepare("SELECT brand_id AS brand FROM instagram_connections WHERE id='preserved-ig'").get().brand, destination.payload.id);
    const summary = await fixture.request(`/connections/summary?workspaceId=${owner.workspaceId}&brandId=${destination.payload.id}`, { cookie: owner.cookie });
    assert.equal(summary.payload.officialConnections, 3);
    assert.equal(summary.payload.registeredAccounts, 3);
    assert.equal((await fixture.request(`/connections/${connection.id}`, { cookie: owner.cookie, method: 'DELETE' })).response.status, 204);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM youtube_connections').get().n, 0);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM social_connections').get().n, 1);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM instagram_connections').get().n, 1);
    assert.equal(fixture.database.pragma('integrity_check', { simple: true }), 'ok');
  });
});

test('YouTube callback cannot persist selection after logout while the channel API is responding', async () => {
  await withYouTube(async (fixture) => {
    const owner = fixture.seedOwner('youtube-owner');
    const authorization = await authorize(fixture, owner);
    const paused = pauseApi(fixture.provider);
    const pending = fixture.request(`/connections/youtube/callback?code=test-youtube-authorization-code&state=${encodeURIComponent(authorization.searchParams.get('state'))}`, { cookie: owner.cookie });
    try {
      await paused.started;
      assert.equal((await fixture.request('/auth/logout', { cookie: owner.cookie, method: 'POST' })).response.status, 204);
    } finally { paused.release(); }
    const result = await pending;
    assert.equal(result.response.status, 302);
    assert.equal(new URL(result.response.headers.get('location'), origin).searchParams.get('reason'), 'session-expired');
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM youtube_channel_selections').get().n, 0);
  });
});

test('YouTube selection cannot create connections after logout during final ownership proof', async () => {
  await withYouTube(async (fixture) => {
    const owner = fixture.seedOwner('youtube-owner');
    const selection = await discover(fixture, owner);
    const paused = pauseApi(fixture.provider);
    const pending = saveSelection(fixture, owner, selection);
    try {
      await paused.started;
      assert.equal((await fixture.request('/auth/logout', { cookie: owner.cookie, method: 'POST' })).response.status, 204);
    } finally { paused.release(); }
    const result = await pending;
    assert.equal(result.response.status, 401);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM youtube_connections').get().n, 0);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM social_accounts').get().n, 0);
  });
});

test('YouTube delayed verification success or revocation cannot overwrite a newly reauthorized connection', async () => {
  await withYouTube(async (fixture) => {
    const owner = fixture.seedOwner('youtube-owner');
    const connection = await connectOne(fixture, owner);
    for (const outcome of ['valid', 'revoked']) {
      const before = fixture.database.prepare('SELECT credentials_encrypted AS token FROM youtube_connections WHERE id = ?').get(connection.id).token;
      const override = outcome === 'revoked' ? { payload: { error: { code: 401, errors: [{ reason: 'authError' }] } }, status: 401 } : undefined;
      const paused = pauseApi(fixture.provider, override);
      const pending = fixture.request(`/connections/${connection.id}/verify`, { cookie: owner.cookie, method: 'POST' });
      let replacement;
      try {
        await paused.started;
        const reconnected = await connectOne(fixture, owner);
        assert.equal(reconnected.id, connection.id);
        replacement = fixture.database.prepare('SELECT credentials_encrypted AS token FROM youtube_connections WHERE id = ?').get(connection.id).token;
        assert.notEqual(replacement, before);
      } finally { paused.release(); }
      const result = await pending;
      assert.equal(result.response.status, 409, outcome);
      const record = fixture.database.prepare('SELECT status, credentials_encrypted AS token FROM youtube_connections WHERE id = ?').get(connection.id);
      assert.equal(record.status, 'connected');
      assert.equal(record.token, replacement);
    }
  });
});


test('YouTube missing permissions preserve existing connection and credentials during verification', async () => {
  await withYouTube(async (fixture) => {
    const owner = fixture.seedOwner('youtube-owner');
    const connection = await connectOne(fixture, owner);
    fixture.database.prepare('UPDATE youtube_connections SET granted_scopes_json = ? WHERE id = ?')
      .run(JSON.stringify([readOnlyScope]), connection.id);
    const before = fixture.database.prepare('SELECT * FROM youtube_connections WHERE id = ?').get(connection.id);
    await fixture.restart();
    assert.deepEqual(fixture.database.prepare('SELECT * FROM youtube_connections WHERE id = ?').get(connection.id), before);
    for (const mode of ['missing-upload', 'missing-readonly']) {
      fixture.provider.infoMode = mode;
      const result = await fixture.request('/connections/' + connection.id + '/verify', { cookie: owner.cookie, method: 'POST' });
      assert.equal(result.response.status, 403, mode);
      assert.match(result.payload.error, /youtube.readonly.*youtube.upload/);
      assert.deepEqual(fixture.database.prepare('SELECT * FROM youtube_connections WHERE id = ?').get(connection.id), before);
      const authorization = await authorize(fixture, owner);
      const redirect = await completeCallback(fixture, owner, authorization.searchParams.get('state'));
      assert.equal(redirect.searchParams.get('reason'), 'permissions-missing');
      assert.deepEqual(fixture.database.prepare('SELECT * FROM youtube_connections WHERE id = ?').get(connection.id), before);
    }
  });
});

test('YouTube rejects a refreshed token missing upload permission before saving a selection', async () => {
  await withYouTube(async (fixture) => {
    const owner = fixture.seedOwner('youtube-owner');
    const inspect = fixture.provider.oauthClient.getTokenInfo;
    fixture.provider.oauthClient.getTokenInfo = async (token) => {
      const info = await inspect(token);
      return token.includes('refreshed') ? { ...info, scopes: [readOnlyScope] } : info;
    };
    const authorization = await authorize(fixture, owner);
    const redirect = await completeCallback(fixture, owner, authorization.searchParams.get('state'));
    assert.equal(redirect.searchParams.get('reason'), 'permissions-missing');
    assert.equal(fixture.provider.refreshCalls.length, 1);
    assert.equal(fixture.provider.apiCalls.length, 0);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM youtube_channel_selections').get().n, 0);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM youtube_connections').get().n, 0);
  });
});
