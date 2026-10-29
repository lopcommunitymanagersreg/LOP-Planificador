import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../server/index.js';

async function withWorkspace(callback) {
  const directory = mkdtempSync(join(tmpdir(), 'lop-brand-selection-'));
  const options = {
    databasePath: join(directory, 'test.sqlite'), mailer: null, googleClient: null,
    facebookOAuthConfig: { configured: false, missing: [] },
    instagramOAuthConfig: { configured: false, missing: [] },
    youtubeOAuthConfig: { configured: false, missing: [] },
  };
  let app;
  let server;
  const start = async () => {
    app = createApp(options);
    server = app.listen(0, '127.0.0.1');
    await new Promise((done, reject) => { server.once('listening', done); server.once('error', reject); });
  };
  const stop = async () => {
    server.closeAllConnections?.();
    await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
    app.locals.database.close();
  };
  await start();
  const fixture = {
    get database() { return app.locals.database; },
    async restart() { await stop(); await start(); },
    seed(id) {
      const token = `test-brand-session-${id}`;
      const workspaceId = `workspace-${id}`;
      const brandId = `brand-${id}-a`;
      const otherBrandId = `brand-${id}-b`;
      fixture.database.prepare('INSERT INTO users (id, name, email, password_hash, email_verified) VALUES (?, ?, ?, ?, 1)')
        .run(id, id, `${id}@example.test`, 'unused-test-password');
      fixture.database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .run(createHash('sha256').update(token).digest('hex'), id, Date.now() + 300_000);
      fixture.database.prepare('INSERT INTO workspaces (id, user_id, name) VALUES (?, ?, ?)').run(workspaceId, id, `Espacio ${id}`);
      const insertBrand = fixture.database.prepare('INSERT INTO brands (id, workspace_id, name) VALUES (?, ?, ?)');
      insertBrand.run(brandId, workspaceId, 'Marca A');
      insertBrand.run(otherBrandId, workspaceId, 'Marca B');
      fixture.database.prepare('INSERT INTO user_workspace_settings (user_id, active_workspace_id) VALUES (?, ?)').run(id, workspaceId);
      return { id, workspaceId, brandId, otherBrandId, cookie: `lop_session=${token}` };
    },
    async request(owner, path, body) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
        method: body === undefined ? 'GET' : 'PUT',
        headers: { Origin: 'http://localhost:5173', Cookie: owner?.cookie || '', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, payload: await response.json() };
    },
    select(owner, brandId) { return fixture.request(owner, `/workspaces/${owner.workspaceId}/active-brand`, { brandId }); },
  };
  try { await callback(fixture); } finally {
    await stop();
    const absolute = resolve(directory);
    if (!absolute.startsWith(`${resolve(tmpdir())}${sep}`) || !basename(absolute).startsWith('lop-brand-selection-')) throw new Error('Unexpected test directory');
    rmSync(absolute, { recursive: true, force: true });
  }
}

test('active brand defaults to the existing first brand and a change survives a server restart', async () => {
  await withWorkspace(async (fixture) => {
    const owner = fixture.seed('owner');
    assert.equal((await fixture.request(owner, '/data')).payload.activeBrandId, owner.brandId);
    assert.equal((await fixture.request(owner, '/workspaces')).payload.activeBrandId, owner.brandId);
    assert.equal((await fixture.select(owner, owner.otherBrandId)).status, 200);
    await fixture.restart();
    assert.equal((await fixture.request(owner, '/data')).payload.activeBrandId, owner.otherBrandId);
    assert.equal((await fixture.request(owner, '/workspaces')).payload.activeBrandId, owner.otherBrandId);
  });
});

test('no selected brand persists as null, including across workspaces and restarts', async () => {
  await withWorkspace(async (fixture) => {
    const owner = fixture.seed('owner');
    fixture.database.prepare('INSERT INTO workspaces (id, user_id, name) VALUES (?, ?, ?)').run('workspace-second', owner.id, 'Segundo espacio');
    fixture.database.prepare('INSERT INTO brands (id, workspace_id, name) VALUES (?, ?, ?)').run('brand-second', 'workspace-second', 'Segunda marca');
    assert.equal((await fixture.select(owner, null)).status, 200);
    assert.equal((await fixture.request(owner, '/data')).payload.activeBrandId, null);
    assert.equal((await fixture.request(owner, '/workspaces/active', { workspaceId: 'workspace-second' })).payload.activeBrandId, 'brand-second');
    assert.equal((await fixture.request(owner, '/workspaces/active', { workspaceId: owner.workspaceId })).payload.activeBrandId, null);
    await fixture.restart();
    assert.equal((await fixture.request(owner, '/data')).payload.activeBrandId, null);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM brands').get().count, 3, 'selecting none must never remove brands');
  });
});

test('brand selections reject unauthenticated, foreign, invalid and cross-workspace values', async () => {
  await withWorkspace(async (fixture) => {
    const owner = fixture.seed('owner');
    const other = fixture.seed('other');
    assert.equal((await fixture.request(null, `/workspaces/${owner.workspaceId}/active-brand`, { brandId: null })).status, 401);
    assert.equal((await fixture.request(owner, `/workspaces/${other.workspaceId}/active-brand`, { brandId: other.brandId })).status, 404);
    for (const brandId of [other.brandId, '', 'missing-brand', 42, {}, []]) {
      assert.equal((await fixture.select(owner, brandId)).status, 400);
    }
    assert.equal((await fixture.request(owner, `/workspaces/${owner.workspaceId}/active-brand`, {})).status, 400);
    assert.equal((await fixture.select(owner, owner.otherBrandId)).status, 200);
    assert.equal((await fixture.request(other, '/data')).payload.activeBrandId, other.brandId);
    assert.equal((await fixture.request(owner, '/data')).payload.activeBrandId, owner.otherBrandId);
  });
});

test('deleting a selected brand clears its preference without choosing or deleting another brand', async () => {
  await withWorkspace(async (fixture) => {
    const owner = fixture.seed('owner');
    await fixture.select(owner, owner.otherBrandId);
    fixture.database.prepare('DELETE FROM brands WHERE id = ?').run(owner.otherBrandId);
    assert.equal((await fixture.request(owner, '/data')).payload.activeBrandId, null);
    assert.ok(fixture.database.prepare('SELECT id FROM brands WHERE id = ?').get(owner.brandId));
    assert.deepEqual(fixture.database.pragma('foreign_key_check'), []);
  });
});

test('social card ordering is user/workspace scoped, survives restart and never reassigns accounts', async () => {
  await withWorkspace(async (fixture) => {
    const owner = fixture.seed('owner'); const other = fixture.seed('other');
    const insert = fixture.database.prepare("INSERT INTO social_accounts (id,user_id,name,network_id,status,workspace_id,brand_id) VALUES (?, ?, ?, 'facebook', 'demo', ?, ?)");
    insert.run('account-a', owner.id, 'Página A', owner.workspaceId, owner.brandId);
    insert.run('account-b', owner.id, 'Página B', owner.workspaceId, owner.otherBrandId);
    insert.run('account-other', other.id, 'Otra página', other.workspaceId, other.brandId);
    const before = fixture.database.prepare('SELECT * FROM social_accounts ORDER BY id').all();
    const path = `/workspaces/${owner.workspaceId}/account-order`;
    assert.equal((await fixture.request(null, path, { accountIds: [] })).status, 401);
    assert.equal((await fixture.request(other, path, { accountIds: [] })).status, 404);
    for (const accountIds of [['account-other'], ['account-a', 'account-a'], null]) assert.equal((await fixture.request(owner, path, { accountIds })).status, 400);
    assert.equal((await fixture.request(owner, path, { accountIds: ['account-b', 'account-a'] })).status, 200);
    await fixture.restart();
    assert.deepEqual((await fixture.request(owner, '/data')).payload.accountOrder, ['account-b', 'account-a']);
    assert.deepEqual(fixture.database.prepare('SELECT * FROM social_accounts ORDER BY id').all(), before);
    fixture.database.prepare("INSERT INTO social_accounts (id,user_id,name,network_id,status,workspace_id,brand_id) VALUES ('account-new', ?, 'Nueva', 'facebook', 'demo', ?, ?)").run(owner.id, owner.workspaceId, owner.brandId);
    assert.deepEqual((await fixture.request(owner, '/data')).payload.accountOrder, ['account-b', 'account-a', 'account-new']);
    assert.deepEqual((await fixture.request(other, '/data')).payload.accountOrder, ['account-other']);
  });
});

test('new drafts store verified account destinations and retain general and platform content across restart', async () => {
  await withWorkspace(async (fixture) => {
    const owner = fixture.seed('owner');
    fixture.database.prepare("INSERT INTO social_accounts (id,user_id,name,network_id,status,workspace_id,brand_id) VALUES ('youtube-account', ?, 'Canal', 'youtube', 'demo', ?, ?)").run(owner.id, owner.workspaceId, owner.brandId);
    fixture.database.prepare("INSERT INTO youtube_connections (id,user_id,account_id,workspace_id,brand_id,provider_channel_id,status,credentials_encrypted,granted_scopes_json,verified_at) VALUES ('youtube-connection', ?, 'youtube-account', ?, ?, 'UC1111111111111111111111', 'connected', 'test-fixture-encrypted', '[]', ?)").run(owner.id, owner.workspaceId, owner.brandId, new Date().toISOString());
    const body = { text: 'Descripción general', date: null, brandId: owner.brandId, format: 'video', networkId: 'youtube', networkIds: ['youtube'], accountIds: ['youtube-account'], networkContent: { youtube: { title: 'Título de YouTube', description: 'a'.repeat(5000) } } };
    assert.equal((await fixture.request(owner, '/data/posts/verified-draft', body)).status, 200);
    assert.equal((await fixture.request(owner, '/data/posts/wrong-brand', { ...body, brandId: owner.otherBrandId })).status, 400);
    assert.equal((await fixture.request(owner, '/data/posts/wrong-platform', { ...body, networkId: 'facebook', networkIds: ['facebook'], networkContent: {} })).status, 400);
    assert.equal((await fixture.request(owner, '/data/posts/duplicate-target', { ...body, accountIds: ['youtube-account', 'youtube-account'] })).status, 400);
    await fixture.restart();
    const post = (await fixture.request(owner, '/data')).payload.posts.find((item) => item.id === 'verified-draft');
    assert.deepEqual(post.accountIds, ['youtube-account']); assert.equal(post.text, body.text);
    assert.equal(post.networkContent.youtube.description.length, 5000);
    fixture.database.prepare("UPDATE youtube_connections SET status = 'expired'").run();
    assert.equal((await fixture.request(owner, '/data/posts/new-expired-target', body)).status, 400);
    assert.equal((await fixture.request(owner, '/data/posts/verified-draft', { ...post, text: 'Edición privada conservada' })).status, 200);
    assert.deepEqual(fixture.database.pragma('foreign_key_check'), []);
  });
});
