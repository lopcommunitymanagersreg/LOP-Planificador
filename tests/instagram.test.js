import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../server/index.js';

const origin = 'http://localhost:5173';
const requiredPermissions = ['instagram_basic', 'pages_show_list', 'pages_read_engagement'];
const encryptionKey = Buffer.alloc(32, 7);
const hash = (value) => createHash('sha256').update(value).digest('hex');

function createMetaProvider() {
  const provider = {
    calls: [],
    permissions: [...requiredPermissions, 'business_management'],
    businessDenied: false,
    professionalAccounts: true,
    tokenMode: 'valid',
    zeroExpiry: false,
    paginated: false,
    beforeResponse: null,
  };
  const pages = [
    { id: '700001', name: 'Primera página', access_token: 'test-instagram-page-token-one', instagram_business_account: { id: '178414000001' } },
    { id: '700002', name: 'Segunda página', access_token: 'test-instagram-page-token-two', instagram_business_account: { id: '178414000002' } },
  ];
  const accounts = [
    { id: '178414000001', username: 'marca.uno', name: 'Marca Uno' },
    { id: '178414000002', username: 'marca.dos', name: 'Marca Dos' },
  ];
  const visiblePages = () => pages.map((page) => ({
    ...page,
    ...(provider.professionalAccounts ? {} : { instagram_business_account: null }),
  }));
  const reply = (payload, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  });

  provider.fetch = async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://graph.facebook.com', 'all provider requests use the official Graph host');
    assert.ok(url.pathname.startsWith('/v26.0/'));
    assert.equal(url.searchParams.has('access_token'), false, 'access tokens travel in authorization headers');
    assert.equal(url.searchParams.has('client_secret'), false, 'app secrets do not travel in query strings');
    const path = url.pathname.replace('/v26.0/', '');
    provider.calls.push({ path, method: options.method || 'GET', after: url.searchParams.get('after') });
    const authorization = new Headers(options.headers).get('authorization');
    const override = await provider.beforeResponse?.({ path, url, options, authorization });
    if (override) return reply(override.payload, override.status);

    if (path === 'oauth/access_token') {
      assert.equal(options.method, 'POST');
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('client_id'), 'test-meta-app');
      assert.equal(body.get('client_secret'), 'test-meta-secret');
      return reply({
        access_token: body.get('grant_type') === 'fb_exchange_token' ? 'test-instagram-user-token-long' : 'test-instagram-user-token-short',
        token_type: 'bearer',
        expires_in: 3600,
      });
    }
    assert.match(authorization || '', /^Bearer /);
    if (path === 'debug_token') {
      assert.equal(authorization, 'Bearer test-meta-app|test-meta-secret');
      const inputToken = url.searchParams.get('input_token');
      const userToken = inputToken === 'test-instagram-user-token-long';
      assert.ok(userToken || pages.some((page) => page.access_token === inputToken));
      const mode = userToken ? 'valid' : provider.tokenMode;
      if (mode === 'transient') return reply({ error: { code: 2, message: 'Temporary Graph failure' } }, 503);
      if (mode === 'revoked') return reply({ error: { code: 190, message: 'The token is no longer valid' } }, 400);
      const expires = Math.floor(Date.now() / 1000) + 3600;
      return reply({ data: {
        app_id: mode === 'wrong-app' ? 'another-meta-app' : 'test-meta-app',
        type: userToken ? 'USER' : 'PAGE',
        is_valid: mode !== 'invalid',
        expires_at: provider.zeroExpiry ? 0 : mode === 'expired' ? Math.floor(Date.now() / 1000) - 60 : expires,
        data_access_expires_at: provider.zeroExpiry ? 0 : mode === 'data-expired' ? Math.floor(Date.now() / 1000) - 60 : expires + 3600,
        scopes: mode === 'missing-scopes' ? ['pages_show_list'] : [...requiredPermissions, 'business_management'],
      } });
    }
    if (path === 'me/permissions') return reply({ data: provider.permissions.map((permission) => ({ permission, status: 'granted' })) });
    if (path === 'me') return reply({ id: '10101', name: 'Persona de prueba' });
    if (path === 'me/businesses') return provider.businessDenied
      ? reply({ error: { code: 200, message: 'Business discovery is unavailable' } }, 403)
      : reply({ data: [{ id: '123456', name: 'Portafolio de prueba' }] });
    if (path === 'me/accounts' && provider.paginated) {
      if (url.searchParams.get('after') === 'cursor-two') return reply({ data: [visiblePages()[1]] });
      return reply({ data: [visiblePages()[0]], paging: {
        next: 'https://graph.facebook.com/v26.0/me/accounts?after=cursor-two&access_token=untrusted-pagination-token',
      } });
    }
    if (path === '123456/owned_pages' || path === 'me/accounts') return reply({ data: visiblePages() });
    if (path === '123456/client_pages') return reply({ data: [] });
    const page = visiblePages().find(({ id }) => id === path);
    if (page) return reply(page);
    const account = accounts.find(({ id }) => id === path);
    if (account) return reply(account);
    throw new Error(`Unexpected mocked Graph request: ${path}`);
  };
  return provider;
}

function pauseResponse(provider, predicate, override) {
  let continueRequest;
  let markStarted;
  let timer;
  const continuing = new Promise((done) => { continueRequest = done; });
  const started = new Promise((done, reject) => {
    timer = setTimeout(() => reject(new Error('The expected mocked provider request never started')), 5000);
    timer.unref();
    markStarted = () => { clearTimeout(timer); done(); };
  });
  provider.beforeResponse = async (request) => {
    if (!predicate(request)) return undefined;
    provider.beforeResponse = null;
    markStarted();
    await continuing;
    return override;
  };
  return { started, release() { clearTimeout(timer); continueRequest(); } };
}

const isPageDebug = ({ path, url }) => path === 'debug_token'
  && url.searchParams.get('input_token')?.startsWith('test-instagram-page-token-');

async function withInstagram(callback) {
  const directory = mkdtempSync(join(tmpdir(), 'lop-instagram-test-'));
  const databasePath = join(directory, 'test.sqlite');
  const provider = createMetaProvider();
  const options = {
    databasePath,
    mailer: null,
    googleClient: null,
    facebookOAuthConfig: { configured: false, missing: [] },
    youtubeOAuthConfig: { configured: false, missing: [] },
    youtubeOAuthClient: null,
    instagramOAuthConfig: {
      configured: true,
      missing: [],
      appId: 'test-meta-app',
      appSecret: 'test-meta-secret',
      redirectUri: `${origin}/api/connections/instagram/callback`,
      graphVersion: 'v26.0',
    },
    fetchImpl: provider.fetch,
    socialTokenEncryptionKey: encryptionKey,
  };
  let app;
  let server;
  const start = async () => {
    app = createApp(options);
    server = app.listen(0, '127.0.0.1');
    await new Promise((done, reject) => {
      server.once('listening', done);
      server.once('error', reject);
    });
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
        method,
        redirect: 'manual',
        headers: {
          Origin: origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      let payload = null;
      if (text && response.headers.get('content-type')?.includes('application/json')) payload = JSON.parse(text);
      return { response, payload };
    },
    seedOwner(id) {
      const token = `test-session-${id}`;
      const workspaceId = `workspace-${id}`;
      const brandId = `brand-${id}`;
      fixture.database.prepare('INSERT INTO users (id, name, email, password_hash, email_verified) VALUES (?, ?, ?, ?, 1)')
        .run(id, id, `${id}@example.test`, 'unused-test-password');
      fixture.database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .run(hash(token), id, Date.now() + 60_000);
      fixture.database.prepare('INSERT INTO workspaces (id, user_id, name) VALUES (?, ?, ?)').run(workspaceId, id, `Espacio ${id}`);
      fixture.database.prepare('INSERT INTO brands (id, workspace_id, name) VALUES (?, ?, ?)').run(brandId, workspaceId, `Marca ${id}`);
      fixture.database.prepare('INSERT INTO user_workspace_settings (user_id, active_workspace_id) VALUES (?, ?)').run(id, workspaceId);
      return { id, cookie: `lop_session=${token}`, workspaceId, brandId };
    },
  };
  try {
    await callback(fixture);
  } finally {
    await stop();
    const absolute = resolve(directory);
    if (!absolute.startsWith(`${resolve(tmpdir())}${sep}`) || !basename(absolute).startsWith('lop-instagram-test-')) {
      throw new Error('Refusing to clean an unexpected Instagram test directory');
    }
    rmSync(absolute, { recursive: true, force: true });
  }
}

async function authorize(fixture, owner) {
  const result = await fixture.request(`/connections/instagram/authorize?brandId=${encodeURIComponent(owner.brandId)}`, { cookie: owner.cookie });
  assert.equal(result.response.status, 302);
  return new URL(result.response.headers.get('location'));
}

async function callbackUrl(fixture, owner, state) {
  const result = await fixture.request(`/connections/instagram/callback?code=test-authorization-code&state=${encodeURIComponent(state)}`, { cookie: owner?.cookie });
  assert.equal(result.response.status, 302);
  return new URL(result.response.headers.get('location'), origin);
}

async function discover(fixture, owner) {
  const authorization = await authorize(fixture, owner);
  const redirect = await callbackUrl(fixture, owner, authorization.searchParams.get('state'));
  assert.equal(redirect.searchParams.get('connection'), 'instagram-select');
  const selectionId = redirect.searchParams.get('selection');
  assert.ok(selectionId);
  const result = await fixture.request(`/connections/instagram/selections/${selectionId}`, { cookie: owner.cookie });
  assert.equal(result.response.status, 200);
  return { id: selectionId, ...result.payload.selection };
}

async function connectOne(fixture, owner) {
  const selection = await discover(fixture, owner);
  const result = await fixture.request(`/connections/instagram/selections/${selection.id}`, {
    cookie: owner.cookie,
    method: 'POST',
    body: { accounts: [{ providerAccountId: selection.accounts[0].id, workspaceId: owner.workspaceId, brandId: owner.brandId }] },
  });
  assert.ok([200, 201].includes(result.response.status));
  assert.equal(result.payload.connectedCount, 1);
  const connections = await fixture.request('/connections', { cookie: owner.cookie });
  return connections.payload.connections.find(({ networkId }) => networkId === 'instagram');
}

test('Instagram requests read permissions and binds single-use OAuth state to its authenticated session', async () => {
  await withInstagram(async (fixture) => {
    const owner = fixture.seedOwner('instagram-owner');
    const other = fixture.seedOwner('instagram-other');
    assert.equal((await fixture.request(`/connections/instagram/authorize?brandId=${owner.brandId}`)).response.status, 401);
    const methods = await fixture.request('/connections/methods', { cookie: owner.cookie });
    assert.equal(methods.payload.instagram.available, true);
    const authorization = await authorize(fixture, owner);
    assert.equal(authorization.hostname, 'www.facebook.com');
    assert.equal(authorization.searchParams.get('redirect_uri'), `${origin}/api/connections/instagram/callback`);
    const scopes = authorization.searchParams.get('scope').split(',');
    assert.ok(requiredPermissions.every((scope) => scopes.includes(scope)));
    assert.equal(scopes.includes('instagram_content_publish'), false);
    assert.equal(scopes.includes('pages_manage_posts'), false);
    const state = authorization.searchParams.get('state');
    assert.ok(state && state.length >= 32);
    const denied = await callbackUrl(fixture, other, state);
    assert.equal(denied.searchParams.get('connection'), 'instagram-error');
    assert.equal(fixture.provider.calls.length, 0, 'a different session never exchanges the authorization code');
    const replay = await callbackUrl(fixture, owner, state);
    assert.equal(replay.searchParams.get('connection'), 'instagram-error');
    assert.equal(fixture.provider.calls.length, 0, 'a consumed state cannot be replayed');
    const expired = await authorize(fixture, owner);
    fixture.database.prepare('UPDATE instagram_oauth_states SET expires_at = ?').run(Date.now() - 1);
    assert.equal((await callbackUrl(fixture, owner, expired.searchParams.get('state'))).searchParams.get('connection'), 'instagram-error');
    assert.equal(fixture.provider.calls.length, 0);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM instagram_connections').get().n, 0);
  });
});

test('Instagram rejects missing consent and pages without a linked professional account', async () => {
  await withInstagram(async (fixture) => {
    const owner = fixture.seedOwner('instagram-owner');
    fixture.provider.permissions = ['instagram_basic', 'pages_show_list'];
    let authorization = await authorize(fixture, owner);
    let redirect = await callbackUrl(fixture, owner, authorization.searchParams.get('state'));
    assert.equal(redirect.searchParams.get('connection'), 'instagram-error');
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM instagram_connections').get().n, 0);
    fixture.provider.permissions = [...requiredPermissions, 'business_management'];
    fixture.provider.professionalAccounts = false;
    authorization = await authorize(fixture, owner);
    redirect = await callbackUrl(fixture, owner, authorization.searchParams.get('state'));
    assert.equal(redirect.searchParams.get('connection'), 'instagram-error');
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM instagram_account_selections').get().n, 0);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM social_accounts').get().n, 0);
  });
});

test('Instagram checks page token app ownership, granted scopes and both expiry limits before connecting', async () => {
  await withInstagram(async (fixture) => {
    const owner = fixture.seedOwner('instagram-owner');
    for (const mode of ['invalid', 'wrong-app', 'expired', 'data-expired', 'missing-scopes']) {
      fixture.provider.tokenMode = mode;
      const authorization = await authorize(fixture, owner);
      const redirect = await callbackUrl(fixture, owner, authorization.searchParams.get('state'));
      assert.equal(redirect.searchParams.get('connection'), 'instagram-error', mode);
      assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM instagram_connections').get().n, 0, mode);
    }
  });
});

test('Instagram fallback discovery, encrypted persistence and assignments are isolated by owner and workspace', async () => {
  await withInstagram(async (fixture) => {
    const owner = fixture.seedOwner('instagram-owner');
    const other = fixture.seedOwner('instagram-other');
    fixture.provider.businessDenied = true;
    const selection = await discover(fixture, owner);
    assert.equal(selection.accounts.length, 2);
    assert.ok(selection.accounts.every((account) => account.id && account.username && account.pageId && account.pageName));
    assert.ok(fixture.provider.calls.some(({ path }) => path === 'me/accounts'));
    assert.equal(JSON.stringify(selection).includes('test-instagram-page-token'), false);
    assert.equal((await fixture.request(`/connections/instagram/selections/${selection.id}`, { cookie: other.cookie })).response.status, 404);
    const wrongAssignment = await fixture.request(`/connections/instagram/selections/${selection.id}`, {
      cookie: owner.cookie,
      method: 'POST',
      body: { accounts: [{ providerAccountId: selection.accounts[0].id, workspaceId: other.workspaceId, brandId: other.brandId }] },
    });
    assert.equal(wrongAssignment.response.status, 400);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM instagram_connections').get().n, 0);
    const saved = await fixture.request(`/connections/instagram/selections/${selection.id}`, {
      cookie: owner.cookie,
      method: 'POST',
      body: { accounts: selection.accounts.map(({ id }) => ({ providerAccountId: id, workspaceId: owner.workspaceId, brandId: owner.brandId })) },
    });
    assert.ok([200, 201].includes(saved.response.status));
    assert.equal(saved.payload.connectedCount, 2);
    assert.equal((await fixture.request(`/connections/instagram/selections/${selection.id}`, { cookie: owner.cookie })).response.status, 404);
    const records = fixture.database.prepare('SELECT account_id AS accountId, access_token_encrypted AS encrypted FROM instagram_connections').all();
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.equal(record.encrypted.includes('test-instagram-page-token'), false);
      const [nonce, tag, ciphertext] = record.encrypted.split('.').map((part) => Buffer.from(part, 'base64url'));
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, nonce);
      decipher.setAAD(Buffer.from(`${owner.id}:instagram:${record.accountId}`));
      decipher.setAuthTag(tag);
      const token = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      assert.match(token, /^test-instagram-page-token-(one|two)$/);
    }
    let data = await fixture.request('/data', { cookie: owner.cookie });
    assert.equal(data.payload.accounts.length, 2);
    assert.ok(data.payload.accounts.every(({ status, networkId }) => status === 'connected' && networkId === 'instagram'));
    assert.equal(JSON.stringify(data.payload).includes('test-instagram-page-token'), false);
    const connections = await fixture.request('/connections', { cookie: owner.cookie });
    assert.equal(connections.payload.connections.length, 2);
    assert.equal(JSON.stringify(connections.payload).includes('test-instagram-page-token'), false);
    const target = connections.payload.connections[0];
    const directEdit = await fixture.request(`/data/accounts/${target.accountId}`, {
      cookie: owner.cookie,
      method: 'PUT',
      body: { name: 'Una referencia demo', networkId: 'facebook', brandId: owner.brandId },
    });
    assert.equal(directEdit.response.status, 409, 'the demo endpoint cannot overwrite an official Instagram account');
    assert.equal(fixture.database.prepare('SELECT network_id AS network FROM social_accounts WHERE id = ?').get(target.accountId).network, 'instagram');
    const targetBrand = await fixture.request(`/workspaces/${owner.workspaceId}/brands`, { cookie: owner.cookie, method: 'POST', body: { name: 'Segunda marca' } });
    assert.equal(targetBrand.response.status, 201);
    assert.equal((await fixture.request(`/connections/${target.id}`, { cookie: other.cookie, method: 'PATCH', body: { workspaceId: other.workspaceId, brandId: other.brandId } })).response.status, 404);
    assert.equal((await fixture.request(`/connections/${target.id}`, { cookie: owner.cookie, method: 'PATCH', body: { workspaceId: owner.workspaceId, brandId: targetBrand.payload.id } })).response.status, 204);
    const summary = await fixture.request(`/connections/summary?workspaceId=${owner.workspaceId}&brandId=${targetBrand.payload.id}`, { cookie: owner.cookie });
    assert.equal(summary.payload.officialConnections, 1);
    assert.equal(summary.payload.registeredAccounts, 1);
    assert.equal((await fixture.request('/data', { cookie: other.cookie })).payload.accounts.length, 0);
    assert.equal((await fixture.request(`/connections/${target.id}`, { cookie: other.cookie, method: 'DELETE' })).response.status, 404);
    assert.equal((await fixture.request(`/connections/${target.id}`, { cookie: owner.cookie, method: 'DELETE' })).response.status, 204);
    data = await fixture.request('/data', { cookie: owner.cookie });
    assert.equal(data.payload.accounts.length, 1);
    assert.equal(fixture.database.pragma('integrity_check', { simple: true }), 'ok');
  });
});

test('Instagram verification detects revocation, preserves connection state on transient failures and can recover', async () => {
  await withInstagram(async (fixture) => {
    const owner = fixture.seedOwner('instagram-owner');
    const other = fixture.seedOwner('instagram-other');
    const connection = await connectOne(fixture, owner);
    assert.ok(connection);
    assert.equal((await fixture.request(`/connections/${connection.id}/verify`, { cookie: other.cookie, method: 'POST' })).response.status, 404);
    let verified = await fixture.request(`/connections/${connection.id}/verify`, { cookie: owner.cookie, method: 'POST' });
    assert.equal(verified.response.status, 200);
    assert.equal(verified.payload.status, 'connected');
    assert.equal(verified.payload.verified, true);
    assert.ok(verified.payload.verifiedAt);
    fixture.provider.tokenMode = 'transient';
    verified = await fixture.request(`/connections/${connection.id}/verify`, { cookie: owner.cookie, method: 'POST' });
    assert.equal(verified.response.status, 502);
    assert.equal(fixture.database.prepare('SELECT status FROM instagram_connections WHERE id = ?').get(connection.id).status, 'connected');
    fixture.provider.tokenMode = 'revoked';
    verified = await fixture.request(`/connections/${connection.id}/verify`, { cookie: owner.cookie, method: 'POST' });
    assert.equal(verified.response.status, 200);
    assert.equal(verified.payload.status, 'expired');
    assert.equal(verified.payload.verified, false);
    assert.equal(fixture.database.prepare('SELECT status FROM instagram_connections WHERE id = ?').get(connection.id).status, 'expired');
    const summary = await fixture.request(`/connections/summary?workspaceId=${owner.workspaceId}`, { cookie: owner.cookie });
    assert.equal(summary.payload.officialConnections, 0);
    fixture.provider.tokenMode = 'valid';
    verified = await fixture.request(`/connections/${connection.id}/verify`, { cookie: owner.cookie, method: 'POST' });
    assert.equal(verified.response.status, 200);
    assert.equal(verified.payload.status, 'connected');
    assert.equal(verified.payload.verified, true);
    assert.equal(JSON.stringify(verified.payload).includes('test-instagram-page-token'), false);
  });
});

test('Instagram migration and brand deletion preserve existing Facebook and Instagram credentials', async () => {
  await withInstagram(async (fixture) => {
    const owner = fixture.seedOwner('instagram-owner');
    fixture.database.prepare(`
      INSERT INTO social_accounts (id, user_id, name, network_id, status, workspace_id, brand_id)
      VALUES ('preserved-facebook-account', ?, 'Facebook existente', 'facebook', 'demo', ?, ?)
    `).run(owner.id, owner.workspaceId, owner.brandId);
    fixture.database.prepare(`
      INSERT INTO social_connections (
        id, user_id, account_id, workspace_id, brand_id, network_id, provider_account_id,
        provider_user_id, status, access_token_encrypted, granted_scopes_json
      ) VALUES ('preserved-facebook-connection', ?, 'preserved-facebook-account', ?, ?, 'facebook',
        'existing-facebook-page', 'existing-facebook-user', 'connected', 'unchanged-facebook-ciphertext', '[]')
    `).run(owner.id, owner.workspaceId, owner.brandId);
    const instagram = await connectOne(fixture, owner);
    const instagramToken = fixture.database.prepare('SELECT access_token_encrypted AS token FROM instagram_connections WHERE id = ?').get(instagram.id).token;
    await fixture.restart();
    assert.equal(fixture.database.prepare("SELECT access_token_encrypted AS token FROM social_connections WHERE id = 'preserved-facebook-connection'").get().token, 'unchanged-facebook-ciphertext');
    assert.equal(fixture.database.prepare('SELECT access_token_encrypted AS token FROM instagram_connections WHERE id = ?').get(instagram.id).token, instagramToken);
    const replacement = await fixture.request(`/workspaces/${owner.workspaceId}/brands`, { cookie: owner.cookie, method: 'POST', body: { name: 'Marca conservada' } });
    const deleted = await fixture.request(`/brands/${owner.brandId}`, { cookie: owner.cookie, method: 'DELETE' });
    assert.equal(deleted.response.status, 204);
    assert.equal(fixture.database.prepare("SELECT brand_id AS brandId FROM social_connections WHERE id = 'preserved-facebook-connection'").get().brandId, replacement.payload.id);
    assert.equal(fixture.database.prepare('SELECT brand_id AS brandId, access_token_encrypted AS token FROM instagram_connections WHERE id = ?').get(instagram.id).brandId, replacement.payload.id);
    assert.equal(fixture.database.prepare('SELECT access_token_encrypted AS token FROM instagram_connections WHERE id = ?').get(instagram.id).token, instagramToken);
    const summary = await fixture.request(`/connections/summary?workspaceId=${owner.workspaceId}&brandId=${replacement.payload.id}`, { cookie: owner.cookie });
    assert.equal(summary.payload.officialConnections, 2);
    assert.equal(summary.payload.registeredAccounts, 2);
    assert.equal(fixture.database.pragma('integrity_check', { simple: true }), 'ok');
  });
});

test('Instagram reconstructs paginated Graph requests without copying credentials from next URLs and accepts zero provider expiry', async () => {
  await withInstagram(async (fixture) => {
    const owner = fixture.seedOwner('instagram-owner');
    fixture.provider.businessDenied = true;
    fixture.provider.paginated = true;
    fixture.provider.zeroExpiry = true;
    const connection = await connectOne(fixture, owner);
    assert.ok(connection);
    assert.ok(fixture.provider.calls.some(({ path, after }) => path === 'me/accounts' && after === 'cursor-two'));
    const record = fixture.database.prepare('SELECT expires_at AS expiresAt, status FROM instagram_connections WHERE id = ?').get(connection.id);
    assert.equal(record.expiresAt, null, 'zero means the provider supplied no expiration timestamp');
    assert.equal(record.status, 'connected');
    const verified = await fixture.request(`/connections/${connection.id}/verify`, { cookie: owner.cookie, method: 'POST' });
    assert.equal(verified.response.status, 200);
    assert.equal(verified.payload.verified, true);
    assert.equal(fixture.database.prepare('SELECT expires_at AS expiresAt FROM instagram_connections WHERE id = ?').get(connection.id).expiresAt, null);
  });
});

test('Instagram callback cannot persist a selection after logout while Meta is responding', async () => {
  await withInstagram(async (fixture) => {
    const owner = fixture.seedOwner('instagram-owner');
    const authorization = await authorize(fixture, owner);
    const paused = pauseResponse(fixture.provider, isPageDebug);
    const pending = fixture.request(`/connections/instagram/callback?code=test-authorization-code&state=${encodeURIComponent(authorization.searchParams.get('state'))}`, { cookie: owner.cookie });
    try {
      await paused.started;
      assert.equal((await fixture.request('/auth/logout', { cookie: owner.cookie, method: 'POST' })).response.status, 204);
    } finally { paused.release(); }
    const result = await pending;
    assert.equal(result.response.status, 302);
    const redirect = new URL(result.response.headers.get('location'), origin);
    assert.equal(redirect.searchParams.get('reason'), 'session-expired');
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM instagram_account_selections').get().n, 0);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM instagram_connections').get().n, 0);
  });
});

test('Instagram selection cannot save connections after logout during its final provider check', async () => {
  await withInstagram(async (fixture) => {
    const owner = fixture.seedOwner('instagram-owner');
    const selection = await discover(fixture, owner);
    const paused = pauseResponse(fixture.provider, isPageDebug);
    const pending = fixture.request(`/connections/instagram/selections/${selection.id}`, {
      cookie: owner.cookie,
      method: 'POST',
      body: { accounts: [{ providerAccountId: selection.accounts[0].id, workspaceId: owner.workspaceId, brandId: owner.brandId }] },
    });
    try {
      await paused.started;
      assert.equal((await fixture.request('/auth/logout', { cookie: owner.cookie, method: 'POST' })).response.status, 204);
    } finally { paused.release(); }
    const result = await pending;
    assert.equal(result.response.status, 401);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM instagram_connections').get().n, 0);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM social_accounts').get().n, 0);
  });
});

test('Instagram ignores delayed verification results for a connection that was reauthorized meanwhile', async () => {
  await withInstagram(async (fixture) => {
    const owner = fixture.seedOwner('instagram-owner');
    const connection = await connectOne(fixture, owner);
    for (const outcome of ['valid', 'revoked']) {
      const before = fixture.database.prepare('SELECT access_token_encrypted AS token FROM instagram_connections WHERE id = ?').get(connection.id).token;
      const override = outcome === 'revoked'
        ? { payload: { error: { code: 190, message: 'The old token was revoked' } }, status: 400 }
        : undefined;
      const paused = pauseResponse(fixture.provider, isPageDebug, override);
      const pending = fixture.request(`/connections/${connection.id}/verify`, { cookie: owner.cookie, method: 'POST' });
      let replacement;
      try {
        await paused.started;
        const reconnected = await connectOne(fixture, owner);
        assert.equal(reconnected.id, connection.id);
        replacement = fixture.database.prepare('SELECT access_token_encrypted AS token FROM instagram_connections WHERE id = ?').get(connection.id).token;
        assert.notEqual(replacement, before, 'reauthorization writes a new encrypted credential');
      } finally { paused.release(); }
      const result = await pending;
      assert.equal(result.response.status, 409, `the delayed ${outcome} result cannot update the replacement credential`);
      const current = fixture.database.prepare('SELECT status, access_token_encrypted AS token FROM instagram_connections WHERE id = ?').get(connection.id);
      assert.equal(current.status, 'connected');
      assert.equal(current.token, replacement);
    }
  });
});
