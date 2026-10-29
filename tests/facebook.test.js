import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { createFacebookVerifier } from '../server/facebook.js';
import { createApp } from '../server/index.js';

const scopes = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'];
const config = { configured: true, appId: 'test-facebook-app', appSecret: 'test-facebook-secret', graphVersion: 'v26.0', redirectUri: 'http://localhost:5173/api/connections/facebook/callback' };
const encryptionKey = Buffer.alloc(32, 19);
function provider() {
  const fixture = { mode: 'valid', debug: {}, identity: {}, calls: [] };
  fixture.fetch = async (input, options) => {
    const url = new URL(input); fixture.calls.push(url.pathname);
    assert.equal(options.redirect, 'error');
    assert.ok(options.headers.Authorization.startsWith('Bearer '));
    const debug = url.pathname.endsWith('/debug_token');
    if (fixture.mode === 'blocked' && debug) return new Response(JSON.stringify({ error: { code: 200, message: 'API access blocked.' } }), { status: 400 });
    if (fixture.mode === 'invalid' || (fixture.mode === 'blocked' && !debug)) return new Response(JSON.stringify({ error: { code: 190, message: 'Invalid token' } }), { status: 400 });
    if (fixture.mode === 'transient') return new Response(JSON.stringify({ error: { code: 1 } }), { status: 503 });
    const pageId = url.pathname.split('/').at(-1);
    return new Response(JSON.stringify(debug ? { data: { is_valid: true, app_id: config.appId, type: 'PAGE', scopes, expires_at: 0, ...fixture.debug } }
      : { id: pageId, name: `Página ${pageId}`, ...fixture.identity }));
  };
  return fixture;
}

test('Facebook validates the current app, page identity, permissions and non-expiring Page tokens', async () => {
  const source = provider();
  const verified = await createFacebookVerifier({ config, fetchImpl: source.fetch })('test-page-token', '10001');
  assert.equal(verified.name, 'Página 10001');
  assert.equal(verified.expiresAt, null, 'zero is no fixed expiry, never a promise of permanent authorization');
  assert.deepEqual(verified.scopes, scopes);
  assert.ok(verified.verifiedAt);
  assert.deepEqual(source.calls.sort(), ['/v26.0/10001', '/v26.0/debug_token']);
});

test('Facebook rejects revoked, expired, foreign-app, wrong-type, wrong-page and insufficient grants', async () => {
  for (const debug of [
    { is_valid: false }, { app_id: 'foreign-app' }, { type: 'USER' }, { profile_id: 'another-page' },
    { expires_at: Math.floor(Date.now() / 1000) - 1 }, { data_access_expires_at: 1 },
    { scopes: ['pages_show_list'] }, { granular_scopes: [{ scope: 'pages_manage_posts', target_ids: ['other-page'] }] },
  ]) {
    const source = provider(); source.debug = debug;
    await assert.rejects(createFacebookVerifier({ config, fetchImpl: source.fetch })('test-page-token', '10001'));
  }
  const source = provider(); source.identity = { id: 'wrong-page' };
  await assert.rejects(createFacebookVerifier({ config, fetchImpl: source.fetch })('test-page-token', '10001'));
});

async function withFacebook(callback) {
  const directory = mkdtempSync(join(tmpdir(), 'lop-facebook-test-'));
  const source = provider();
  const options = { databasePath: join(directory, 'test.sqlite'), mailer: null, googleClient: null,
    facebookOAuthConfig: config, youtubeOAuthConfig: { configured: false }, instagramOAuthConfig: { configured: false },
    socialTokenEncryptionKey: encryptionKey, fetchImpl: source.fetch };
  let app; let server;
  const start = async () => { app = createApp(options); server = app.listen(0, '127.0.0.1'); await new Promise((done) => server.once('listening', done)); };
  const stop = async () => { server.closeAllConnections?.(); await new Promise((done) => server.close(done)); app.locals.database.close(); };
  await start();
  const db = app.locals.database;
  db.prepare("INSERT INTO users (id,name,email,password_hash,email_verified) VALUES ('owner','Owner','owner@example.test','unused',1)").run();
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update('test-facebook-session').digest('hex'), 'owner', Date.now() + 300000);
  db.prepare("INSERT INTO workspaces (id,user_id,name) VALUES ('workspace','owner','Espacio')").run();
  db.prepare("INSERT INTO brands (id,workspace_id,name) VALUES ('brand','workspace','Marca')").run();
  db.prepare("INSERT INTO user_workspace_settings (user_id,active_workspace_id) VALUES ('owner','workspace')").run();
  for (const pageId of ['10001', '10002']) {
    const accountId = `account-${pageId}`;
    db.prepare("INSERT INTO social_accounts (id,user_id,name,network_id,status,workspace_id,brand_id) VALUES (?,'owner',?,'facebook','demo','workspace','brand')").run(accountId, `Página ${pageId}`);
    const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
    cipher.setAAD(Buffer.from(`owner:facebook:${accountId}`));
    const ciphertext = Buffer.concat([cipher.update(`test-page-token-${pageId}`, 'utf8'), cipher.final()]);
    const encrypted = [nonce, cipher.getAuthTag(), ciphertext].map((value) => value.toString('base64url')).join('.');
    db.prepare("INSERT INTO social_connections (id,user_id,account_id,workspace_id,brand_id,network_id,provider_account_id,provider_user_id,status,access_token_encrypted,granted_scopes_json) VALUES (?,'owner',?,'workspace','brand','facebook',?,'provider-user','connected',?,?)")
      .run(`connection-${pageId}`, accountId, pageId, encrypted, JSON.stringify(scopes));
  }
  const fixture = {
    source, get db() { return app.locals.database; }, async restart() { await stop(); await start(); },
    async request(path, method = 'GET') {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { Cookie: 'lop_session=test-facebook-session', Origin: 'http://localhost:5173' } });
      return { status: response.status, body: await response.json() };
    },
  };
  try { await callback(fixture); } finally {
    await stop(); const absolute = resolve(directory);
    if (!absolute.startsWith(`${resolve(tmpdir())}${sep}`) || !basename(absolute).startsWith('lop-facebook-test-')) throw new Error('Unexpected test directory');
    rmSync(absolute, { recursive: true, force: true });
  }
}

test('Facebook distinguishes app restrictions from expiry without deleting or rotating either stored Page token', async () => {
  await withFacebook(async (fixture) => {
    const before = fixture.db.prepare('SELECT * FROM social_connections ORDER BY id').all();
    fixture.source.mode = 'blocked';
    for (const row of before) {
      const result = await fixture.request(`/connections/${row.id}/verify`, 'POST');
      assert.equal(result.status, 200); assert.equal(result.body.verified, false);
      assert.equal(result.body.reason, 'api-blocked'); assert.equal(result.body.reconnectRequired, false);
      assert.match(result.body.message, /Meta bloqueó/);
      const after = fixture.db.prepare('SELECT * FROM social_connections WHERE id = ?').get(row.id);
      for (const field of ['id', 'account_id', 'workspace_id', 'brand_id', 'access_token_encrypted', 'status']) assert.equal(after[field], row[field]);
    }
    const data = (await fixture.request('/data')).body;
    assert.equal(data.accounts.length, 2);
    assert.ok(data.accounts.every((account) => account.verificationError === 'api-blocked'));
    assert.equal((await fixture.request('/connections/summary')).body.officialConnections, 0);
    assert.equal(JSON.stringify(data).includes('test-page-token'), false);
  });
});

test('both Facebook Pages survive restart; expired consent and temporary errors have different outcomes', async () => {
  await withFacebook(async (fixture) => {
    const ids = ['connection-10001', 'connection-10002'];
    for (const id of ids) assert.equal((await fixture.request(`/connections/${id}/verify`, 'POST')).body.verified, true);
    await fixture.restart();
    assert.equal((await fixture.request('/connections/summary')).body.officialConnections, 2);
    assert.ok((await fixture.request('/data')).body.accounts.every((account) => account.verifiedAt));
    fixture.source.mode = 'invalid';
    assert.equal((await fixture.request(`/connections/${ids[0]}/verify`, 'POST')).body.reconnectRequired, true);
    assert.equal(fixture.db.prepare('SELECT status FROM social_connections WHERE id = ?').get(ids[0]).status, 'expired');
    fixture.source.mode = 'valid';
    assert.equal((await fixture.request(`/connections/${ids[0]}/verify`, 'POST')).body.verified, true);
    const before = fixture.db.prepare('SELECT * FROM social_connections ORDER BY id').all();
    fixture.source.mode = 'transient';
    assert.equal((await fixture.request(`/connections/${ids[0]}/verify`, 'POST')).status, 502);
    assert.deepEqual(fixture.db.prepare('SELECT * FROM social_connections ORDER BY id').all(), before);
    assert.deepEqual(fixture.db.pragma('foreign_key_check'), []);
  });
});
