import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../server/index.js';
import { createTikTokOAuthConfig } from '../server/tiktok.js';

const redirectUri = 'https://lop.example.test/api/connections/tiktok/callback';
const configuration = { TIKTOK_CLIENT_KEY: 'test-key', TIKTOK_CLIENT_SECRET: 'test-secret', TIKTOK_REDIRECT_URI: redirectUri };

test('TikTok stays disabled without credentials and requires a static public HTTPS callback', () => {
  assert.equal(createTikTokOAuthConfig({}).configured, false);
  assert.equal(createTikTokOAuthConfig(configuration).configured, true);
  for (const uri of ['http://localhost:5173/api/connections/tiktok/callback', 'https://localhost/api/connections/tiktok/callback', redirectUri + '?x=1', redirectUri + '#x', 'https://lop.example.test/wrong']) {
    assert.throws(() => createTikTokOAuthConfig({ ...configuration, TIKTOK_REDIRECT_URI: uri }));
  }
});

async function withTikTok(callback) {
  const directory = mkdtempSync(join(tmpdir(), 'lop-tiktok-test-'));
  const provider = { mode: 'valid', calls: [], tokenCount: 0, beforeProfile: null };
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    provider.calls.push(url.pathname);
    assert.equal(url.origin, 'https://open.tiktokapis.com');
    let payload;
    if (url.pathname === '/v2/oauth/token/') {
      assert.equal(options.method, 'POST');
      assert.equal(options.body.get('client_secret'), 'test-secret');
      provider.tokenCount += 1;
      if (provider.mode === 'transient') return { ok: false, status: 503, json: async () => ({ error: 'temporarily_unavailable' }) };
      payload = { open_id: 'test-tiktok-open-id', access_token: 'test-tiktok-access-' + provider.tokenCount,
        refresh_token: 'test-tiktok-refresh-' + provider.tokenCount, expires_in: 86400, refresh_expires_in: 31536000,
        scope: provider.mode === 'missing-scope' ? 'video.list' : 'user.info.basic' };
    } else {
      assert.equal(url.pathname, '/v2/user/info/');
      assert.match(options.headers.Authorization, /^Bearer test-tiktok-access-/);
      await provider.beforeProfile?.();
      payload = { data: { user: { open_id: provider.mode === 'wrong-user' ? 'different-user' : 'test-tiktok-open-id', display_name: 'Cuenta TikTok' } }, error: { code: 'ok' } };
    }
    return { ok: true, status: 200, json: async () => payload };
  };
  const options = { databasePath: join(directory, 'test.sqlite'), mailer: null, googleClient: null,
    facebookOAuthConfig: { configured: false, missing: [] }, instagramOAuthConfig: { configured: false, missing: [] }, youtubeOAuthConfig: { configured: false, missing: [] },
    tiktokOAuthConfig: createTikTokOAuthConfig(configuration), socialTokenEncryptionKey: Buffer.alloc(32, 7), fetchImpl };
  let app, server;
  const start = async () => { app = createApp(options); server = app.listen(0, '127.0.0.1'); await new Promise((done) => server.once('listening', done)); };
  const stop = async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); app.locals.database.close(); };
  await start();
  const fixture = {
    provider,
    get db() { return app.locals.database; },
    async restart() { await stop(); await start(); },
    seed(id) {
      const token = 'test-session-' + id;
      const workspaceId = 'workspace-' + id, brandId = 'brand-' + id;
      fixture.db.prepare('INSERT INTO users (id,name,email,password_hash,email_verified) VALUES (?,?,?,?,1)').run(id, id, id + '@example.test', 'unused');
      fixture.db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), id, Date.now() + 300000);
      fixture.db.prepare('INSERT INTO workspaces (id,user_id,name) VALUES (?,?,?)').run(workspaceId, id, id);
      fixture.db.prepare('INSERT INTO brands (id,workspace_id,name) VALUES (?,?,?)').run(brandId, workspaceId, id);
      fixture.db.prepare('INSERT INTO user_workspace_settings VALUES (?,?)').run(id, workspaceId);
      return { id, workspaceId, brandId, cookie: 'lop_session=' + token };
    },
    async request(owner, path, method = 'GET', body) {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api' + path, { method, redirect: 'manual',
        headers: { Cookie: owner?.cookie || '', Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await response.text();
      return { status: response.status, location: response.headers.get('location'), body: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
    },
    async authorize(owner) {
      const result = await fixture.request(owner, '/connections/tiktok/authorize?brandId=' + owner.brandId);
      assert.equal(result.status, 302);
      const url = new URL(result.location);
      assert.equal(url.searchParams.get('scope'), 'user.info.basic');
      assert.equal(url.searchParams.get('redirect_uri'), redirectUri);
      return url.searchParams.get('state');
    },
    async callback(owner, state) { return fixture.request(owner, '/connections/tiktok/callback?code=test-code&state=' + state); },
  };
  try { await callback(fixture); } finally {
    await stop();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected test directory');
    rmSync(directory, { recursive: true, force: true });
  }
}

test('TikTok state rejects foreign sessions, reuse, expiry and missing scopes without storing a connection', async () => {
  await withTikTok(async (f) => {
    const owner = f.seed('owner'), other = f.seed('other');
    assert.equal((await f.request(null, '/connections/tiktok/authorize')).status, 401);
    assert.equal((await f.request(other, '/connections/tiktok/authorize?brandId=' + owner.brandId)).status, 400);
    const state = await f.authorize(owner);
    assert.match((await f.callback(other, state)).location, /tiktok-error/);
    assert.match((await f.callback(owner, state)).location, /tiktok-error/);
    assert.equal(f.provider.calls.length, 0);
    const expired = await f.authorize(owner);
    f.db.prepare('UPDATE tiktok_oauth_states SET expires_at = 0').run();
    assert.match((await f.callback(owner, expired)).location, /tiktok-error/);
    for (const mode of ['missing-scope', 'wrong-user']) {
      f.provider.mode = mode;
      assert.match((await f.callback(owner, await f.authorize(owner))).location, /tiktok-error/);
    }
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM tiktok_connections').get().n, 0);
  });
});

test('TikTok saves encrypted credentials, refreshes, reconnects without duplication and supports existing account management', async () => {
  await withTikTok(async (f) => {
    const owner = f.seed('owner'), other = f.seed('other');
    assert.match((await f.callback(owner, await f.authorize(owner))).location, /tiktok-connected/);
    const original = f.db.prepare('SELECT * FROM tiktok_connections').get();
    assert.equal(original.credentials_encrypted.includes('test-tiktok'), false);
    await f.restart();
    assert.equal(f.db.prepare('SELECT credentials_encrypted AS token FROM tiktok_connections').get().token, original.credentials_encrypted);
    const data = (await f.request(owner, '/data')).body;
    assert.equal(data.accounts[0].connectionNetwork, 'tiktok');
    assert.equal(JSON.stringify(data).includes('test-tiktok-access'), false);
    assert.equal((await f.request(owner, '/connections/methods')).body.tiktok.available, true);
    assert.equal((await f.request(owner, '/connections/summary')).body.officialConnections, 1);
    assert.equal((await f.request(other, '/data')).body.accounts.length, 0);
    assert.equal((await f.request(other, '/connections/' + original.id + '/verify', 'POST')).status, 404);
    const result = await f.request(owner, '/connections/' + original.id + '/verify', 'POST');
    assert.equal(result.body.verified, true);
    assert.notEqual(f.db.prepare('SELECT credentials_encrypted AS token FROM tiktok_connections').get().token, original.credentials_encrypted);
    const before = f.db.prepare('SELECT * FROM tiktok_connections').get();
    f.provider.mode = 'transient';
    assert.equal((await f.request(owner, '/connections/' + original.id + '/verify', 'POST')).status, 502);
    assert.deepEqual(f.db.prepare('SELECT * FROM tiktok_connections').get(), before);
    f.provider.mode = 'valid';
    assert.match((await f.callback(owner, await f.authorize(owner))).location, /tiktok-connected/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM tiktok_connections').get().n, 1);
    assert.equal(f.db.prepare('SELECT id FROM tiktok_connections').get().id, original.id);
    assert.equal((await f.request(owner, '/data/accounts/' + original.account_id, 'PUT', { name: 'Overwrite', networkId: 'tiktok', status: 'demo' })).status, 409);
    f.db.prepare('INSERT INTO brands (id,workspace_id,name) VALUES (?,?,?)').run('destination', owner.workspaceId, 'Destino');
    assert.equal((await f.request(owner, '/connections/' + original.id, 'PATCH', { workspaceId: owner.workspaceId, brandId: 'destination' })).status, 204);
    assert.equal(f.db.prepare('SELECT brand_id AS brand FROM tiktok_connections').get().brand, 'destination');
    assert.equal((await f.request(owner, '/connections/' + original.id, 'DELETE')).status, 204);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM tiktok_connections').get().n, 0);
    assert.ok(f.provider.calls.every((path) => ['/v2/oauth/token/', '/v2/user/info/'].includes(path)));
  });
});

test('TikTok callback cannot save access after logout while the provider responds', async () => {
  await withTikTok(async (f) => {
    const owner = f.seed('owner');
    f.provider.beforeProfile = async () => { f.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(owner.id); };
    assert.match((await f.callback(owner, await f.authorize(owner))).location, /tiktok-error/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM tiktok_connections').get().n, 0);
  });
});
