import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OAuth2Client } from 'google-auth-library';
import { createServer as createViteServer } from 'vite';
import { createApp, listenOnFixedPort } from '../server/index.js';
import viteConfig from '../vite.config.js';

const origin = 'http://localhost:5173';

test('local OAuth credentials in .env override stale inherited terminal values', {
  skip: !existsSync(join(process.cwd(), '.env')),
}, () => {
  const script = `
    const fs = require('node:fs');
    const dotenv = require('dotenv');
    const expected = dotenv.parse(fs.readFileSync('.env'));
    const keys = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'];
    console.log(JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key] === expected[key]]))));
  `;
  const child = spawnSync(process.execPath, ['-r', './server/load-env.cjs', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      GOOGLE_CLIENT_ID: 'stale-test-client-id',
      GOOGLE_CLIENT_SECRET: 'stale-test-secret',
      GOOGLE_REDIRECT_URI: 'http://localhost:3002/stale-callback',
    },
  });

  assert.equal(child.status, 0, 'the environment loader starts successfully');
  assert.deepEqual(JSON.parse(child.stdout.trim()), {
    GOOGLE_CLIENT_ID: true,
    GOOGLE_CLIENT_SECRET: true,
    GOOGLE_REDIRECT_URI: true,
  });
  assert.equal(child.stdout.includes('stale-test-secret'), false);
});

async function withServer(options, callback) {
  const directory = mkdtempSync(join(tmpdir(), 'lop-backend-test-'));
  const app = createApp({ databasePath: join(directory, 'test.sqlite'), ...options });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    await callback({
      app,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      directory,
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    app.locals.database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function send(baseUrl, path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      Origin: origin,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = response.status === 204 ? null : await response.json();
  return { response, payload, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

function extractCode(message) {
  const match = message.text.match(/código[^:]* es (\d{6})/i);
  assert.ok(match, 'email must contain a six-digit code');
  return match[1];
}

test('email verification, login, recovery, data isolation and record-level persistence', async () => {
  const sentMessages = [];
  await withServer({
    mailer: { async sendMail(message) { sentMessages.push(message); } },
    googleClient: null,
  }, async ({ app, baseUrl }) => {
    const methods = await send(baseUrl, '/auth/methods');
    assert.deepEqual(methods.payload, { emailDelivery: true, google: false });

    const registration = await send(baseUrl, '/auth/register', {
      method: 'POST',
      body: { name: 'Ana', email: 'ana@example.test', password: 'Frase segura larga 2026' },
    });
    assert.equal(registration.response.status, 201);
    assert.equal(registration.cookie, undefined);
    assert.equal(sentMessages.length, 1);
    const storedUser = app.locals.database.prepare('SELECT * FROM users WHERE email = ?').get('ana@example.test');
    assert.equal(storedUser.email_verified, 0);
    assert.match(storedUser.password_hash, /^scrypt\$32768\$8\$1\$/);
    assert.notEqual(storedUser.password_hash, 'Frase segura larga 2026');
    assert.equal(Object.hasOwn(storedUser, 'phone'), false);
    const storedCode = app.locals.database.prepare('SELECT code_hash, salt, attempts FROM verification_codes WHERE user_id = ?')
      .get(storedUser.id);
    assert.notEqual(storedCode.code_hash, extractCode(sentMessages[0]));
    assert.equal(storedCode.attempts, 0);

    const duplicate = await send(baseUrl, '/auth/register', {
      method: 'POST',
      body: { name: 'Ana duplicada', email: 'ANA@example.test', password: 'Otra frase segura 2026' },
    });
    assert.equal(duplicate.response.status, 409);

    const resendTooSoon = await send(baseUrl, '/auth/verification/send', {
      method: 'POST',
      body: { email: 'ana@example.test' },
    });
    assert.equal(resendTooSoon.response.status, 429);

    const verified = await send(baseUrl, '/auth/verify-email', {
      method: 'POST',
      body: { email: 'ana@example.test', code: extractCode(sentMessages[0]) },
    });
    assert.equal(verified.response.status, 200);
    assert.match(verified.response.headers.get('set-cookie'), /HttpOnly/);
    assert.match(verified.response.headers.get('set-cookie'), /SameSite=Lax/);
    let anaCookie = verified.cookie;

    const profile = await send(baseUrl, '/data/profile', {
      method: 'PUT',
      cookie: anaCookie,
      body: { name: 'Ana Pérez' },
    });
    assert.equal(profile.response.status, 200);

    const draft = {
      text: 'Primer borrador',
      networkId: 'instagram',
      networkIds: ['instagram'],
      status: 'published',
      date: '2026-10-25T12:00:00.000Z',
    };
    const firstDraft = await send(baseUrl, '/data/posts/post-1', {
      method: 'PUT',
      cookie: anaCookie,
      body: draft,
    });
    assert.equal(firstDraft.response.status, 200);
    assert.equal(firstDraft.payload.status, 'draft');

    const secondDraft = await send(baseUrl, '/data/posts/post-2', {
      method: 'PUT',
      cookie: anaCookie,
      body: { ...draft, text: 'Segundo borrador', status: 'scheduled' },
    });
    assert.equal(secondDraft.payload.status, 'draft');

    const newerDraft = await send(baseUrl, '/data/posts/post-1', {
      method: 'PUT',
      cookie: anaCookie,
      body: { ...draft, text: 'Versión reciente' },
    });
    assert.equal(newerDraft.response.status, 200);

    const account = await send(baseUrl, '/data/accounts/account-1', {
      method: 'PUT',
      cookie: anaCookie,
      body: { name: 'Mi página', networkId: 'instagram', status: 'connected' },
    });
    assert.equal(account.payload.status, 'demo');

    const restoredData = await send(baseUrl, '/data', { cookie: anaCookie });
    const accountSummary = await send(
      baseUrl,
      `/connections/summary?workspaceId=${encodeURIComponent(restoredData.payload.workspaceId)}`,
      { cookie: anaCookie },
    );
    assert.deepEqual(accountSummary.payload, {
      workspaceId: restoredData.payload.workspaceId,
      brandId: null,
      registeredAccounts: 1,
      officialConnections: 0,
    });
    assert.deepEqual(
      restoredData.payload.posts.map(({ id, text, status }) => ({ id, text, status })).sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: 'post-1', text: 'Versión reciente', status: 'draft' },
        { id: 'post-2', text: 'Segundo borrador', status: 'draft' },
      ],
    );
    assert.equal(restoredData.payload.accounts[0].status, 'demo');
    assert.equal(restoredData.payload.profile.name, 'Ana Pérez');

    const otherRegistration = await send(baseUrl, '/auth/register', {
      method: 'POST',
      body: { name: 'Beto', email: 'beto@example.test', password: 'Otra frase segura 2026' },
    });
    assert.equal(otherRegistration.response.status, 201);
    const otherCode = extractCode(sentMessages.at(-1));
    const otherVerification = await send(baseUrl, '/auth/verify-email', {
      method: 'POST',
      body: { email: 'beto@example.test', code: otherCode },
    });
    const isolated = await send(baseUrl, '/data', { cookie: otherVerification.cookie });
    assert.deepEqual(isolated.payload.posts, []);
    assert.deepEqual(isolated.payload.accounts, []);

    const secondDeviceLogin = await send(baseUrl, '/auth/login', {
      method: 'POST',
      body: { email: 'ana@example.test', password: 'Frase segura larga 2026' },
    });
    assert.equal(secondDeviceLogin.response.status, 200);
    const secondDeviceCookie = secondDeviceLogin.cookie;
    const logout = await send(baseUrl, '/auth/logout', { method: 'POST', cookie: anaCookie });
    assert.equal(logout.response.status, 204);
    assert.match(logout.response.headers.get('set-cookie'), /lop_session=;/);
    assert.match(logout.response.headers.get('set-cookie'), /Path=\//);
    assert.match(logout.response.headers.get('set-cookie'), /HttpOnly/);
    assert.match(logout.response.headers.get('set-cookie'), /SameSite=Lax/);
    assert.match(logout.response.headers.get('set-cookie'), /Expires=/);
    assert.equal(logout.response.headers.get('cache-control'), 'no-store');
    assert.equal(app.locals.database.prepare('SELECT COUNT(*) AS count FROM posts WHERE user_id = ?')
      .get(restoredData.payload.profile.id).count, 2);
    const expiredSession = await send(baseUrl, '/auth/session', { cookie: anaCookie });
    assert.equal(expiredSession.response.status, 401);
    assert.equal((await send(baseUrl, '/auth/session', { cookie: secondDeviceCookie })).response.status, 401);
    assert.equal(app.locals.database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?')
      .get(restoredData.payload.profile.id).count, 0);
    assert.equal((await send(baseUrl, '/data', { cookie: anaCookie })).response.status, 401);
    assert.equal((await send(baseUrl, '/auth/session', { cookie: otherVerification.cookie })).response.status, 200);
    const repeatedLogout = await send(baseUrl, '/auth/logout', { method: 'POST', cookie: anaCookie });
    assert.equal(repeatedLogout.response.status, 204);
    assert.match(repeatedLogout.response.headers.get('set-cookie'), /lop_session=;/);
    assert.equal((await send(baseUrl, '/auth/session', { cookie: otherVerification.cookie })).response.status, 200);

    const login = await send(baseUrl, '/auth/login', {
      method: 'POST',
      body: { email: 'ana@example.test', password: 'Frase segura larga 2026' },
    });
    assert.equal(login.response.status, 200);
    anaCookie = login.cookie;
    const recovery = await send(baseUrl, '/auth/password/recovery', {
      method: 'POST',
      body: { email: 'ana@example.test' },
    });
    assert.equal(recovery.response.status, 200);
    const resetCode = extractCode(sentMessages.at(-1));
    const reset = await send(baseUrl, '/auth/password/reset', {
      method: 'POST',
      body: { email: 'ana@example.test', code: resetCode, password: 'Nueva clave segura 2026' },
    });
    assert.equal(reset.response.status, 200);
    assert.equal((await send(baseUrl, '/data', { cookie: anaCookie })).response.status, 401);
    assert.equal((await send(baseUrl, '/auth/login', {
      method: 'POST',
      body: { email: 'ana@example.test', password: 'Frase segura larga 2026' },
    })).response.status, 401);
    assert.equal((await send(baseUrl, '/auth/login', {
      method: 'POST',
      body: { email: 'ana@example.test', password: 'Nueva clave segura 2026' },
    })).response.status, 200);
  });
});

test('verification codes expire and stop working after five incorrect attempts', async () => {
  const sentMessages = [];
  await withServer({ mailer: { async sendMail(message) { sentMessages.push(message); } } }, async ({ app, baseUrl }) => {
    await send(baseUrl, '/auth/register', {
      method: 'POST',
      body: { name: 'Eva', email: 'eva@example.test', password: 'Frase segura de Eva 2026' },
    });
    const user = app.locals.database.prepare('SELECT id FROM users WHERE email = ?').get('eva@example.test');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await send(baseUrl, '/auth/verify-email', {
        method: 'POST',
        body: { email: 'eva@example.test', code: '000000' },
      });
      assert.equal(response.response.status, 400);
    }
    const correctButLocked = await send(baseUrl, '/auth/verify-email', {
      method: 'POST',
      body: { email: 'eva@example.test', code: extractCode(sentMessages[0]) },
    });
    assert.equal(correctButLocked.response.status, 400);

    app.locals.database.prepare('UPDATE verification_throttles SET next_allowed_at = 0 WHERE email = ?').run('eva@example.test');
    const resent = await send(baseUrl, '/auth/verification/send', {
      method: 'POST',
      body: { email: 'eva@example.test' },
    });
    assert.equal(resent.response.status, 200);
    app.locals.database.prepare('UPDATE verification_codes SET expires_at = 0 WHERE user_id = ?').run(user.id);
    const expired = await send(baseUrl, '/auth/verify-email', {
      method: 'POST',
      body: { email: 'eva@example.test', code: extractCode(sentMessages.at(-1)) },
    });
    assert.equal(expired.response.status, 400);
  });
});

test('missing providers are reported unavailable and untrusted origins are rejected', async () => {
  await withServer({ mailer: null, googleClient: null }, async ({ baseUrl }) => {
    const methods = await send(baseUrl, '/auth/methods');
    assert.deepEqual(methods.payload, { emailDelivery: false, google: false });
    const registration = await send(baseUrl, '/auth/register', {
      method: 'POST',
      body: { name: 'No SMTP', email: 'no-smtp@example.test', password: 'Frase segura larga 2026' },
    });
    assert.equal(registration.response.status, 503);
    const forbidden = await fetch(`${baseUrl}/api/auth/methods`, { headers: { Origin: 'https://example.com' } });
    assert.equal(forbidden.status, 403);
    const unauthorized = await send(baseUrl, '/data');
    assert.equal(unauthorized.response.status, 401);
  });
});

test('Google sign-in redirects to the official OAuth endpoint with state protection', async () => {
  await withServer({
    mailer: null,
    googleClient: new OAuth2Client('test-client.apps.googleusercontent.com', 'test-secret', 'http://localhost:5173/api/auth/google/callback'),
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/auth/google`, {
      headers: { Origin: origin },
      redirect: 'manual',
    });
    assert.equal(response.status, 302);
    const authorizationUrl = new URL(response.headers.get('location'));
    assert.equal(authorizationUrl.origin, 'https://accounts.google.com');
    assert.equal(authorizationUrl.searchParams.get('client_id'), 'test-client.apps.googleusercontent.com');
    assert.equal(authorizationUrl.searchParams.get('redirect_uri'), 'http://localhost:5173/api/auth/google/callback');
    assert.ok(authorizationUrl.searchParams.get('state'));
    assert.ok(authorizationUrl.searchParams.get('nonce'));
    assert.match(response.headers.get('set-cookie'), /HttpOnly/);
    assert.match(response.headers.get('set-cookie'), /SameSite=Lax/);
  });
});

test('Google token exchange reports safe invalid-client diagnostics without logging secrets', async () => {
  const exchangeError = Object.assign(new Error('sensitive provider response'), {
    code: 401,
    response: {
      status: 401,
      data: { error: 'invalid_client', error_description: 'do-not-log-this-secret' },
    },
  });
  const googleClient = {
    generateAuthUrl(options) {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('state', options.state);
      url.searchParams.set('nonce', options.nonce);
      return url.toString();
    },
    async getToken() {
      throw exchangeError;
    },
  };

  await withServer({ mailer: null, googleClient }, async ({ baseUrl }) => {
    const start = await fetch(`${baseUrl}/api/auth/google`, {
      headers: { Origin: origin },
      redirect: 'manual',
    });
    const cookie = start.headers.get('set-cookie').split(';')[0];
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const logged = [];
    const originalError = console.error;
    console.error = (...args) => logged.push(args.join(' '));
    let callback;
    try {
      callback = await fetch(
        `${baseUrl}/api/auth/google/callback?state=${encodeURIComponent(state)}&code=test-code`,
        { headers: { Cookie: cookie }, redirect: 'manual' },
      );
    } finally {
      console.error = originalError;
    }
    assert.equal(new URL(callback.headers.get('location'), origin).searchParams.get('auth'), 'google-config-error');
    assert.ok(logged.some((message) => message.endsWith('invalid_client')));
    assert.equal(logged.join('\n').includes('do-not-log-this-secret'), false);
  });
});

test('Google OAuth configuration reads local credentials and uses the exact callback URI', async () => {
  const keys = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'];
  const previousValues = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.GOOGLE_CLIENT_ID = 'lop-config-test.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret-not-for-production';
  process.env.GOOGLE_REDIRECT_URI = 'http://localhost:5173/api/auth/google/callback';
  const directory = mkdtempSync(join(tmpdir(), 'lop-google-config-test-'));
  const app = createApp({ databasePath: join(directory, 'test.sqlite'), mailer: null });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const methods = await send(baseUrl, '/auth/methods');
    assert.equal(methods.payload.google, true);
    const authorization = await fetch(`${baseUrl}/api/auth/google`, {
      headers: { Origin: origin },
      redirect: 'manual',
    });
    const authorizationUrl = new URL(authorization.headers.get('location'));
    assert.equal(authorizationUrl.searchParams.get('client_id'), 'lop-config-test.apps.googleusercontent.com');
    assert.equal(authorizationUrl.searchParams.get('redirect_uri'), 'http://localhost:5173/api/auth/google/callback');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    app.locals.database.close();
    rmSync(directory, { recursive: true, force: true });
    for (const key of keys) {
      if (previousValues[key] === undefined) delete process.env[key];
      else process.env[key] = previousValues[key];
    }
  }
});

test('Google cannot take over an email account without an authenticated explicit link', async () => {
  const sentMessages = [];
  let googleNonce = '';
  let googlePicture = 'https://lh3.googleusercontent.com/first-profile-photo';
  let googleSubject = 'google-account-1';
  let googleEmail = 'ana@example.test';
  const googleClientId = 'lop-test.apps.googleusercontent.com';
  const googleClient = {
    generateAuthUrl(options) {
      googleNonce = options.nonce;
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      for (const [key, value] of Object.entries(options)) url.searchParams.set(key, value);
      return url.toString();
    },
    async getToken() {
      return { tokens: { id_token: 'test-id-token' } };
    },
    async verifyIdToken({ idToken, audience }) {
      assert.equal(idToken, 'test-id-token');
      assert.equal(audience, googleClientId);
      return {
        getPayload: () => ({
          sub: googleSubject,
          email: googleEmail,
          email_verified: true,
          name: 'Ana Google',
          picture: googlePicture,
          nonce: googleNonce,
        }),
      };
    },
  };

  await withServer({
    mailer: { async sendMail(message) { sentMessages.push(message); } },
    googleClient,
    googleClientId,
  }, async ({ app, baseUrl }) => {
    await send(baseUrl, '/auth/register', {
      method: 'POST',
      body: { name: 'Ana', email: 'ana@example.test', password: 'Frase segura larga 2026' },
    });
    const verification = await send(baseUrl, '/auth/verify-email', {
      method: 'POST',
      body: { email: 'ana@example.test', code: extractCode(sentMessages[0]) },
    });
    const userId = app.locals.database.prepare('SELECT id FROM users WHERE email = ?')
      .get('ana@example.test').id;

    const googleLoginStart = await fetch(`${baseUrl}/api/auth/google`, {
      headers: { Origin: origin },
      redirect: 'manual',
    });
    const loginStateCookie = googleLoginStart.headers.get('set-cookie').split(';')[0];
    const loginState = new URL(googleLoginStart.headers.get('location')).searchParams.get('state');
    const unlinkedLogin = await fetch(
      `${baseUrl}/api/auth/google/callback?state=${encodeURIComponent(loginState)}&code=google-code`,
      { headers: { Cookie: loginStateCookie }, redirect: 'manual' },
    );
    assert.equal(new URL(unlinkedLogin.headers.get('location'), origin).searchParams.get('auth'), 'google-link-required');
    assert.equal(app.locals.database.prepare('SELECT google_sub FROM users WHERE id = ?').get(userId).google_sub, null);
    assert.equal(unlinkedLogin.headers.get('set-cookie').includes('lop_session='), false);

    const unauthorizedLink = await fetch(`${baseUrl}/api/auth/google/link`, { redirect: 'manual' });
    assert.equal(unauthorizedLink.status, 401);

    const linkStart = await fetch(`${baseUrl}/api/auth/google/link`, {
      headers: { Origin: origin, Cookie: verification.cookie },
      redirect: 'manual',
    });
    assert.equal(linkStart.status, 302);
    const linkStateCookie = linkStart.headers.get('set-cookie').split(';')[0];
    const linkState = new URL(linkStart.headers.get('location')).searchParams.get('state');
    const linked = await fetch(
      `${baseUrl}/api/auth/google/callback?state=${encodeURIComponent(linkState)}&code=google-code`,
      { headers: { Cookie: `${linkStateCookie}; ${verification.cookie}` }, redirect: 'manual' },
    );
    assert.equal(new URL(linked.headers.get('location'), origin).searchParams.get('auth'), 'google-linked');
    assert.equal(app.locals.database.prepare('SELECT google_sub FROM users WHERE id = ?').get(userId).google_sub, 'google-account-1');
    assert.equal(app.locals.database.prepare('SELECT google_picture FROM users WHERE id = ?').get(userId).google_picture, googlePicture);
    assert.equal(linked.headers.get('set-cookie').includes('lop_session='), false);

    const linkedProfile = await send(baseUrl, '/auth/session', { cookie: verification.cookie });
    assert.equal(linkedProfile.payload.user.image, googlePicture);
    const privateProfile = await send(baseUrl, '/data', { cookie: verification.cookie });
    assert.equal(privateProfile.payload.profile.image, googlePicture);

    googlePicture = 'https://lh3.googleusercontent.com/updated-profile-photo';
    const reloginStart = await fetch(`${baseUrl}/api/auth/google`, {
      headers: { Origin: origin },
      redirect: 'manual',
    });
    const reloginStateCookie = reloginStart.headers.get('set-cookie').split(';')[0];
    const reloginState = new URL(reloginStart.headers.get('location')).searchParams.get('state');
    const relogin = await fetch(
      `${baseUrl}/api/auth/google/callback?state=${encodeURIComponent(reloginState)}&code=google-code`,
      { headers: { Cookie: reloginStateCookie }, redirect: 'manual' },
    );
    assert.equal(relogin.status, 302);
    assert.match(relogin.headers.get('set-cookie'), /lop_session=/);
    assert.equal(app.locals.database.prepare('SELECT user_id FROM sessions WHERE user_id = ?').get(userId).user_id, userId);
    assert.equal(app.locals.database.prepare('SELECT google_picture FROM users WHERE id = ?').get(userId).google_picture, googlePicture);
    const reloginCookie = relogin.headers.get('set-cookie').match(/(?:^|,\s*)(lop_session=[^;,]+)/)?.[1];
    assert.ok(reloginCookie);
    const updatedProfile = await send(baseUrl, '/auth/session', { cookie: reloginCookie });
    assert.equal(updatedProfile.payload.user.image, googlePicture);
    const secondGoogleDeviceStart = await fetch(`${baseUrl}/api/auth/google`, {
      headers: { Origin: origin },
      redirect: 'manual',
    });
    const secondGoogleStateCookie = secondGoogleDeviceStart.headers.get('set-cookie').split(';')[0];
    const secondGoogleState = new URL(secondGoogleDeviceStart.headers.get('location')).searchParams.get('state');
    const secondGoogleLogin = await fetch(
      `${baseUrl}/api/auth/google/callback?state=${encodeURIComponent(secondGoogleState)}&code=google-code`,
      { headers: { Cookie: secondGoogleStateCookie }, redirect: 'manual' },
    );
    assert.equal(secondGoogleLogin.status, 302);
    const secondGoogleCookie = secondGoogleLogin.headers.get('set-cookie').match(/(?:^|,\s*)(lop_session=[^;,]+)/)?.[1];
    assert.ok(secondGoogleCookie);
    const googleLogout = await send(baseUrl, '/auth/logout', { method: 'POST', cookie: reloginCookie });
    assert.equal(googleLogout.response.status, 204);
    assert.match(googleLogout.response.headers.get('set-cookie'), /lop_session=;/);
    assert.equal((await send(baseUrl, '/auth/session', { cookie: reloginCookie })).response.status, 401);
    assert.equal((await send(baseUrl, '/auth/session', { cookie: secondGoogleCookie })).response.status, 401);
    assert.equal(app.locals.database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?')
      .get(userId).count, 0);
    assert.ok(app.locals.database.prepare('SELECT id FROM users WHERE id = ?').get(userId));

    googlePicture = 'http://untrusted.example/photo.png';
    googleSubject = 'google-account-2';
    googleEmail = 'sofia@example.test';
    const noPhotoStart = await fetch(`${baseUrl}/api/auth/google`, {
      headers: { Origin: origin },
      redirect: 'manual',
    });
    const noPhotoStateCookie = noPhotoStart.headers.get('set-cookie').split(';')[0];
    const noPhotoState = new URL(noPhotoStart.headers.get('location')).searchParams.get('state');
    const noPhotoLogin = await fetch(
      `${baseUrl}/api/auth/google/callback?state=${encodeURIComponent(noPhotoState)}&code=google-code`,
      { headers: { Cookie: noPhotoStateCookie }, redirect: 'manual' },
    );
    assert.equal(noPhotoLogin.status, 302);
    const newGoogleUser = app.locals.database.prepare('SELECT id, google_picture FROM users WHERE google_sub = ?')
      .get('google-account-2');
    assert.ok(newGoogleUser);
    assert.equal(newGoogleUser.google_picture, null);
    const noPhotoCookie = noPhotoLogin.headers.get('set-cookie').match(/(?:^|,\s*)(lop_session=[^;,]+)/)?.[1];
    assert.ok(noPhotoCookie);
    const noPhotoSession = await send(baseUrl, '/auth/session', { cookie: noPhotoCookie });
    assert.equal(noPhotoSession.payload.user.image, null);
  });
});

test('API refuses to start a second listener when its fixed port is occupied', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lop-port-test-'));
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const occupiedPort = blocker.address().port;
  const app = createApp({ databasePath: join(directory, 'test.sqlite'), mailer: null, googleClient: null });
  try {
    await assert.rejects(listenOnFixedPort(app, occupiedPort), (error) => error.code === 'EADDRINUSE');
    assert.equal(blocker.listening, true);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    app.locals.database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Vite pins the API proxy to 3001 and forwards API requests', async () => {
  assert.equal(viteConfig.server.proxy['/api'].target, 'http://127.0.0.1:3001');
  const directory = mkdtempSync(join(tmpdir(), 'lop-proxy-test-'));
  const app = createApp({
    databasePath: join(directory, 'test.sqlite'),
    mailer: null,
    googleClient: null,
  });
  const backend = app.listen(0, '127.0.0.1');
  let vite;
  try {
    await new Promise((resolveListen, rejectListen) => {
      backend.once('listening', resolveListen);
      backend.once('error', rejectListen);
    });
    vite = await createViteServer({
      configFile: false,
      plugins: viteConfig.plugins,
      logLevel: 'silent',
      server: {
        host: '127.0.0.1',
        port: 0,
        strictPort: true,
        proxy: { '/api': { target: `http://127.0.0.1:${backend.address().port}` } },
      },
    });
    await vite.listen();
    const response = await fetch(`http://127.0.0.1:${vite.httpServer.address().port}/api/auth/methods`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { emailDelivery: false, google: false });
  } finally {
    if (vite) await vite.close();
    await new Promise((resolveClose) => backend.close(resolveClose));
    app.locals.database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy phone fields are removed and false publication states are normalized', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lop-migration-test-'));
  const databasePath = join(directory, 'legacy.sqlite');
  const oldDatabase = new Database(databasePath);
  oldDatabase.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE social_accounts (id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, network_id TEXT NOT NULL, status TEXT NOT NULL, preference_enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (user_id, id));
    CREATE TABLE posts (id TEXT NOT NULL, user_id TEXT NOT NULL, text TEXT NOT NULL, network_id TEXT, network_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, scheduled_at TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, id));
    INSERT INTO users (id, name, email, password_hash, phone) VALUES ('legacy', 'Legacy', 'legacy@example.test', 'hash', '555');
    INSERT INTO social_accounts (id, user_id, name, network_id, status) VALUES ('a1', 'legacy', 'Cuenta', 'instagram', 'connected');
    INSERT INTO posts (id, user_id, text, network_id, status, scheduled_at) VALUES ('p1', 'legacy', 'Publicado falso', 'instagram', 'published', '2026-10-25T12:00:00.000Z');
  `);
  oldDatabase.close();
  const app = createApp({ databasePath, mailer: null, googleClient: null });
  try {
    const columns = app.locals.database.pragma('table_info(users)').map((column) => column.name);
    assert.equal(columns.includes('phone'), false);
    assert.equal(columns.includes('google_picture'), true);
    assert.equal(app.locals.database.prepare('SELECT status FROM social_accounts WHERE id = ?').get('a1').status, 'demo');
    assert.equal(app.locals.database.prepare('SELECT status FROM posts WHERE id = ?').get('p1').status, 'draft');
    assert.equal(app.locals.database.pragma('table_info(posts)').find(({ name }) => name === 'scheduled_at').notnull, 0);
    assert.equal(app.locals.database.prepare('SELECT format FROM posts WHERE id = ?').get('p1').format, 'text');
    assert.equal(app.locals.database.prepare('SELECT scheduled_at FROM posts WHERE id = ?').get('p1').scheduled_at, '2026-10-25T12:00:00.000Z');
    assert.deepEqual(
      app.locals.database.prepare('SELECT title, description, hashtags, network_content AS networkContent FROM posts WHERE id = ?').get('p1'),
      { title: '', description: '', hashtags: '', networkContent: '{}' },
    );
    const legacyAccount = app.locals.database.prepare('SELECT workspace_id AS workspaceId, brand_id AS brandId FROM social_accounts WHERE id = ?').get('a1');
    const legacyPost = app.locals.database.prepare('SELECT workspace_id AS workspaceId, brand_id AS brandId FROM posts WHERE id = ?').get('p1');
    assert.ok(legacyAccount.workspaceId);
    assert.ok(legacyAccount.brandId);
    assert.deepEqual(legacyPost, legacyAccount);
    assert.equal(app.locals.database.prepare('SELECT COUNT(*) AS count FROM workspaces WHERE user_id = ?').get('legacy').count, 1);
    app.locals.database.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run('google-account-1', 'legacy');
    assert.throws(() => {
      app.locals.database.prepare('INSERT INTO users (id, name, email, password_hash, google_sub) VALUES (?, ?, ?, ?, ?)')
        .run('legacy-2', 'Legacy 2', 'legacy-2@example.test', 'hash', 'google-account-1');
    }, /UNIQUE constraint failed/);
  } finally {
    app.locals.database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('publication drafts persist customized content for all seven networks without exceeding API body limits', async () => {
  await withServer({ mailer: null, googleClient: null }, async ({ app, baseUrl }) => {
    const database = app.locals.database;
    database.prepare('INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)')
      .run('multi-network-owner', 'Multi Network', 'multi-network@example.test', 'test-hash');
    const token = 'multi-network-session';
    database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(createHash('sha256').update(token).digest('hex'), 'multi-network-owner', Date.now() + 600_000);
    const cookie = `lop_session=${token}`;
    const workspaceResponse = await send(baseUrl, '/workspaces', { cookie });
    const brandId = workspaceResponse.payload.workspaces[0].brands[0].id;
    const networkIds = ['facebook', 'instagram', 'threads', 'tiktok', 'youtube', 'linkedin', 'x'];
    const networkContent = Object.fromEntries(networkIds.map((networkId) => [networkId, {
      title: 'T'.repeat(200),
      description: 'D'.repeat(2000),
      text: networkId.repeat(Math.ceil(5000 / networkId.length)).slice(0, 5000),
      hashtags: 'H'.repeat(1000),
      settings: { link: 'https://example.test/post', altText: 'A'.repeat(500), callToAction: 'C'.repeat(500) },
    }]));
    const post = {
      text: 'Texto global',
      title: 'Título global',
      description: 'Descripción global',
      hashtags: '#global',
      date: null,
      networkIds,
      networkContent,
      format: 'text',
      brandId,
    };
    assert.ok(Buffer.byteLength(JSON.stringify(post)) > 64 * 1024);
    const created = await send(baseUrl, '/data/posts/all-network-draft', {
      method: 'PUT',
      cookie,
      body: post,
    });
    assert.equal(created.response.status, 200);
    assert.equal(created.payload.status, 'draft');
    assert.deepEqual(created.payload.networkIds, networkIds);
    assert.equal(created.payload.networkContent.youtube.text.length, 5000);
    const persisted = await send(baseUrl, '/data', { cookie });
    assert.equal(persisted.payload.posts[0].title, 'Título global');
    assert.equal(Object.keys(persisted.payload.posts[0].networkContent).length, 7);
  });
});

test('calendar post CRUD, date changes, reminders and workspace/brand isolation survive an app restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lop-calendar-persistence-test-'));
  const databasePath = join(directory, 'calendar.sqlite');
  let app;
  let server;
  let baseUrl;
  const start = async () => {
    app = createApp({ databasePath, mailer: null, googleClient: null });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    app.locals.database.close();
  };
  try {
    await start();
    const database = app.locals.database;
    database.prepare('INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)')
      .run('calendar-owner', 'Calendar Owner', 'calendar-owner@example.test', 'test-hash');
    database.prepare('INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)')
      .run('calendar-other', 'Calendar Other', 'calendar-other@example.test', 'test-hash');
    const ownerToken = 'calendar-owner-session';
    const otherToken = 'calendar-other-session';
    const insertSession = database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)');
    insertSession.run(createHash('sha256').update(ownerToken).digest('hex'), 'calendar-owner', Date.now() + 600_000);
    insertSession.run(createHash('sha256').update(otherToken).digest('hex'), 'calendar-other', Date.now() + 600_000);
    const ownerCookie = `lop_session=${ownerToken}`;
    const otherCookie = `lop_session=${otherToken}`;

    const initialWorkspaces = await send(baseUrl, '/workspaces', { cookie: ownerCookie });
    assert.equal(initialWorkspaces.response.status, 200);
    const primaryWorkspace = initialWorkspaces.payload.workspaces[0];
    const primaryBrand = primaryWorkspace.brands[0];
    const otherWorkspaces = await send(baseUrl, '/workspaces', { cookie: otherCookie });
    assert.equal(otherWorkspaces.response.status, 200);
    const otherBrandId = otherWorkspaces.payload.workspaces[0].brands[0].id;
    const secondBrand = await send(baseUrl, `/workspaces/${encodeURIComponent(primaryWorkspace.id)}/brands`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        name: 'Calendario Brand 2',
        settings: {
          timezone: 'Europe/Madrid',
          description: '',
          website: '',
          primaryColor: '#087fb7',
          accentColor: '#44b9e2',
        },
      },
    });
    assert.equal(secondBrand.response.status, 201);
    assert.equal(secondBrand.payload.settings.timezone, 'Europe/Madrid');

    const createdPost = await send(baseUrl, '/data/posts/calendar-post', {
      method: 'PUT',
      cookie: ownerCookie,
      body: {
        text: 'Borrador inicial',
        title: 'Título inicial',
        description: 'Descripción inicial',
        hashtags: '#lop #contenido',
        date: '2026-11-02T18:30:00.000Z',
        networkId: 'instagram',
        networkIds: ['instagram', 'threads'],
        networkContent: {
          instagram: {
            text: 'Texto específico para Instagram',
            hashtags: '#instagram',
            settings: { altText: 'Descripción accesible', callToAction: 'Ver más' },
          },
          threads: { text: 'Texto breve para Threads' },
        },
        format: 'video',
        brandId: primaryBrand.id,
      },
    });
    assert.equal(createdPost.response.status, 200);
    assert.equal(createdPost.payload.status, 'draft');
    assert.equal(createdPost.payload.format, 'video');
    assert.equal(createdPost.payload.date, '2026-11-02T18:30:00.000Z');
    assert.equal(createdPost.payload.title, 'Título inicial');
    assert.equal(createdPost.payload.description, 'Descripción inicial');
    assert.equal(createdPost.payload.hashtags, '#lop #contenido');
    assert.deepEqual(createdPost.payload.networkContent.instagram.settings, {
      altText: 'Descripción accesible',
      callToAction: 'Ver más',
    });
    const falsePublishedState = await send(baseUrl, '/data/posts/invalid-status', {
      method: 'PUT',
      cookie: ownerCookie,
      body: {
        text: 'No debe aparentar estar publicado',
        date: null,
        networkIds: [],
        status: 'published',
        format: 'text',
        brandId: primaryBrand.id,
      },
    });
    assert.equal(falsePublishedState.response.status, 200);
    assert.equal(falsePublishedState.payload.status, 'draft');
    await send(baseUrl, '/data/posts/invalid-status', { method: 'DELETE', cookie: ownerCookie });
    assert.equal((await send(baseUrl, '/data/posts/invalid-network-content', {
      method: 'PUT',
      cookie: ownerCookie,
      body: {
        text: 'No debe personalizar una red no seleccionada',
        date: null,
        networkIds: ['instagram'],
        networkContent: { youtube: { text: 'Texto ajeno' } },
        format: 'text',
        brandId: primaryBrand.id,
      },
    })).response.status, 400);

    const editedPost = await send(baseUrl, '/data/posts/calendar-post', {
      method: 'PUT',
      cookie: ownerCookie,
      body: {
        text: 'Borrador actualizado',
        title: 'Título actualizado',
        description: 'Descripción actualizada',
        hashtags: '#actualizado',
        date: '2026-11-03T20:15:00.000Z',
        networkId: 'instagram',
        networkIds: ['instagram'],
        networkContent: { instagram: { text: 'Copy actualizado', settings: { link: 'https://example.test/campana' } } },
        format: 'carousel',
        brandId: primaryBrand.id,
      },
    });
    assert.equal(editedPost.response.status, 200);
    assert.equal(editedPost.payload.date, '2026-11-03T20:15:00.000Z');
    assert.equal(editedPost.payload.format, 'carousel');
    assert.equal(editedPost.payload.title, 'Título actualizado');
    assert.equal(editedPost.payload.hashtags, '#actualizado');
    assert.equal(editedPost.payload.networkContent.instagram.text, 'Copy actualizado');

    const independentCopy = await send(baseUrl, '/data/posts/brand-copy', {
      method: 'PUT',
      cookie: ownerCookie,
      body: { ...editedPost.payload, brandId: secondBrand.payload.id },
    });
    assert.equal(independentCopy.response.status, 200);
    assert.equal(independentCopy.payload.brandId, secondBrand.payload.id);
    assert.equal(independentCopy.payload.title, editedPost.payload.title);
    const withCopy = await send(baseUrl, '/data', { cookie: ownerCookie });
    assert.equal(withCopy.payload.posts.find(({ id }) => id === 'calendar-post').brandId, primaryBrand.id);
    assert.equal(withCopy.payload.posts.find(({ id }) => id === 'calendar-post').title, 'Título actualizado');
    assert.equal(withCopy.payload.posts.find(({ id }) => id === 'brand-copy').brandId, secondBrand.payload.id);
    await send(baseUrl, '/data/posts/brand-copy', { method: 'DELETE', cookie: ownerCookie });

    const secondBrandPost = await send(baseUrl, '/data/posts/brand-post', {
      method: 'PUT',
      cookie: ownerCookie,
      body: {
        text: 'Borrador de otra marca',
        date: '2026-11-04T09:00:00.000Z',
        networkId: 'youtube',
        networkIds: ['youtube'],
        format: 'short',
        brandId: secondBrand.payload.id,
      },
    });
    assert.equal(secondBrandPost.response.status, 200);
    const undatedPost = await send(baseUrl, '/data/posts/undated-post', {
      method: 'PUT',
      cookie: ownerCookie,
      body: { text: 'Idea sin fecha', date: null, networkIds: [], format: 'text', brandId: primaryBrand.id },
    });
    assert.equal(undatedPost.response.status, 200);
    assert.equal(undatedPost.payload.date, null);

    const firstNote = await send(baseUrl, '/calendar/notes', {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        brandId: primaryBrand.id,
        date: '2026-11-03',
        text: 'Revisar copy',
        reminderAt: '2026-11-03T17:00:00.000Z',
      },
    });
    assert.equal(firstNote.response.status, 201);
    const updatedNote = await send(baseUrl, `/calendar/notes/${encodeURIComponent(firstNote.payload.id)}`, {
      method: 'PATCH',
      cookie: ownerCookie,
      body: { date: '2026-11-04', text: 'Enviar borrador a revisión', reminderAt: null },
    });
    assert.equal(updatedNote.response.status, 200);
    assert.equal(updatedNote.payload.date, '2026-11-04');
    assert.equal(updatedNote.payload.reminderAt, null);

    const secondWorkspace = await send(baseUrl, '/workspaces', {
      method: 'POST',
      cookie: ownerCookie,
      body: { name: 'Espacio de calendario separado' },
    });
    assert.equal(secondWorkspace.response.status, 201);
    assert.equal((await send(baseUrl, '/data', { cookie: ownerCookie })).payload.posts.length, 0);
    assert.equal((await send(baseUrl, '/data', { cookie: otherCookie })).payload.posts.length, 0);
    assert.equal((await send(baseUrl, `/calendar/notes?brandId=${encodeURIComponent(primaryBrand.id)}`, { cookie: otherCookie })).response.status, 404);
    assert.notEqual(otherBrandId, primaryBrand.id);

    await send(baseUrl, '/workspaces/active', {
      method: 'PUT',
      cookie: ownerCookie,
      body: { workspaceId: primaryWorkspace.id },
    });
    const firstWorkspaceData = await send(baseUrl, '/data', { cookie: ownerCookie });
    assert.equal(firstWorkspaceData.payload.posts.length, 3);
    assert.equal(firstWorkspaceData.payload.posts.find(({ id }) => id === 'calendar-post').date, '2026-11-03T20:15:00.000Z');
    assert.equal(firstWorkspaceData.payload.posts.find(({ id }) => id === 'undated-post').date, null);
    assert.equal(firstWorkspaceData.payload.posts.find(({ id }) => id === 'brand-post').brandId, secondBrand.payload.id);
    const persistedNotes = await send(baseUrl, `/calendar/notes?brandId=${encodeURIComponent(primaryBrand.id)}&from=2026-11-01&to=2026-11-30`, { cookie: ownerCookie });
    assert.equal(persistedNotes.payload.notes[0].text, 'Enviar borrador a revisión');

    await stop();
    await start();
    const restartedData = await send(baseUrl, '/data', { cookie: ownerCookie });
    assert.equal(restartedData.response.status, 200);
    assert.equal(restartedData.payload.posts.length, 3);
    assert.equal(restartedData.payload.posts.find(({ id }) => id === 'calendar-post').text, 'Borrador actualizado');
    assert.equal(restartedData.payload.posts.find(({ id }) => id === 'calendar-post').title, 'Título actualizado');
    assert.equal(restartedData.payload.posts.find(({ id }) => id === 'calendar-post').description, 'Descripción actualizada');
    assert.equal(restartedData.payload.posts.find(({ id }) => id === 'calendar-post').hashtags, '#actualizado');
    assert.deepEqual(restartedData.payload.posts.find(({ id }) => id === 'calendar-post').networkContent.instagram, {
      text: 'Copy actualizado',
      settings: { link: 'https://example.test/campana' },
    });
    assert.equal(restartedData.payload.posts.find(({ id }) => id === 'calendar-post').date, '2026-11-03T20:15:00.000Z');
    assert.equal(restartedData.payload.posts.find(({ id }) => id === 'undated-post').date, null);
    const restartedNotes = await send(baseUrl, `/calendar/notes?brandId=${encodeURIComponent(primaryBrand.id)}&from=2026-11-01&to=2026-11-30`, { cookie: ownerCookie });
    assert.equal(restartedNotes.payload.notes[0].text, 'Enviar borrador a revisión');
    const restartedWorkspaces = await send(baseUrl, '/workspaces', { cookie: ownerCookie });
    assert.equal(restartedWorkspaces.payload.workspaces.length, 2);
    assert.equal(restartedWorkspaces.payload.workspaces.find(({ id }) => id === primaryWorkspace.id).brands.find(({ id }) => id === secondBrand.payload.id).settings.timezone, 'Europe/Madrid');
    const deletedNote = await send(baseUrl, `/calendar/notes/${encodeURIComponent(firstNote.payload.id)}`, {
      method: 'DELETE',
      cookie: ownerCookie,
    });
    assert.equal(deletedNote.response.status, 204);
    assert.equal((await send(baseUrl, `/calendar/notes?brandId=${encodeURIComponent(primaryBrand.id)}&from=2026-11-01&to=2026-11-30`, { cookie: ownerCookie })).payload.notes.length, 0);

    const movedPost = await send(baseUrl, '/data/posts/calendar-post', {
      method: 'PUT',
      cookie: ownerCookie,
      body: {
        ...restartedData.payload.posts.find(({ id }) => id === 'calendar-post'),
        date: '2026-11-05T11:45:00.000Z',
      },
    });
    assert.equal(movedPost.response.status, 200);
    assert.equal(movedPost.payload.date, '2026-11-05T11:45:00.000Z');
    assert.equal((await send(baseUrl, '/data/posts/brand-post', {
      method: 'PUT',
      cookie: otherCookie,
      body: {
        text: 'Mal asignado',
        date: '2026-11-06T09:00:00.000Z',
        networkIds: [],
        format: 'text',
        brandId: secondBrand.payload.id,
      },
    })).response.status, 404);

    const deletedPost = await send(baseUrl, '/data/posts/calendar-post', { method: 'DELETE', cookie: ownerCookie });
    assert.equal(deletedPost.response.status, 204);
    assert.equal((await send(baseUrl, '/data', { cookie: ownerCookie })).payload.posts.some(({ id }) => id === 'calendar-post'), false);
    assert.equal(app.locals.database.prepare('SELECT COUNT(*) AS count FROM posts WHERE id = ?').get('calendar-post').count, 0);
    assert.equal(app.locals.database.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    if (server?.listening) await stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('workspaces, brands and social account references are persistent and owner-isolated', async () => {
  await withServer({ mailer: null, googleClient: null }, async ({ app, baseUrl }) => {
    const database = app.locals.database;
    const insertUser = database.prepare('INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)');
    const insertSession = database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)');
    const ownerToken = 'workspace-owner-test-token';
    const otherToken = 'workspace-other-test-token';
    insertUser.run('workspace-owner', 'Owner', 'owner@example.test', 'test-only-hash');
    insertUser.run('workspace-other', 'Other', 'other@example.test', 'test-only-hash');
    for (const [token, userId] of [[ownerToken, 'workspace-owner'], [otherToken, 'workspace-other']]) {
      insertSession.run(createHash('sha256').update(token).digest('hex'), userId, Date.now() + 60_000);
    }
    const ownerCookie = `lop_session=${ownerToken}`;
    const otherCookie = `lop_session=${otherToken}`;

    const initial = await send(baseUrl, '/workspaces', { cookie: ownerCookie });
    assert.equal(initial.response.status, 200);
    assert.equal(initial.payload.workspaces.length, 1);
    assert.equal(initial.payload.activeWorkspaceId, initial.payload.workspaces[0].id);
    const firstWorkspace = initial.payload.workspaces[0];
    assert.equal(firstWorkspace.brands.length, 1);

    const created = await send(baseUrl, '/workspaces', {
      method: 'POST',
      cookie: ownerCookie,
      body: { name: 'Campaña primavera' },
    });

    assert.equal(created.response.status, 201);
    const secondWorkspace = created.payload.workspaces.find(({ name }) => name === 'Campaña primavera');
    assert.ok(secondWorkspace);
    assert.equal(created.payload.activeWorkspaceId, secondWorkspace.id);
    assert.equal(secondWorkspace.brands.length, 1);

    const createdBrand = await send(baseUrl, `/workspaces/${encodeURIComponent(secondWorkspace.id)}/brands`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        name: 'Marca Norte',
        logoUrl: 'https://assets.example.test/norte.png',
        settings: {
          description: 'Contenido de la campaña',
          website: 'https://norte.example.test',
          primaryColor: '#112233',
          accentColor: '#aabbcc',
        },
      },
    });
    assert.equal(createdBrand.response.status, 201);
    assert.equal(createdBrand.payload.settings.primaryColor, '#112233');
    const brandId = createdBrand.payload.id;
    const account = await send(baseUrl, '/data/accounts/brand-account', {
      method: 'PUT',
      cookie: ownerCookie,
      body: { name: 'Página oficial', networkId: 'facebook', status: 'connected', brandId },
    });
    assert.equal(account.response.status, 200);
    assert.equal(account.payload.status, 'demo');
    assert.equal(account.payload.brandId, brandId);
    assert.equal(account.payload.workspaceId, secondWorkspace.id);
    const workspacePost = await send(baseUrl, '/data/posts/space-draft', {
      method: 'PUT',
      cookie: ownerCookie,
      body: {
        text: 'Borrador de espacio',
        networkId: 'facebook',
        networkIds: ['facebook'],
        date: '2026-10-25T12:00:00.000Z',
      },
    });
    assert.equal(workspacePost.response.status, 200);
    const workspaceData = await send(baseUrl, '/data', { cookie: ownerCookie });
    assert.equal(workspaceData.payload.workspaceId, secondWorkspace.id);
    assert.deepEqual(workspaceData.payload.accounts.map(({ id, brandId: assignedBrand }) => ({ id, brandId: assignedBrand })), [
      { id: 'brand-account', brandId },
    ]);

    const anotherAccount = await send(baseUrl, '/data/accounts/default-brand-account', {
      method: 'PUT',
      cookie: ownerCookie,
      body: { name: 'Otra cuenta', networkId: 'instagram', brandId: secondWorkspace.brands[0].id },
    });
    assert.equal(anotherAccount.response.status, 200);
    const updatedBrand = await send(baseUrl, `/brands/${encodeURIComponent(brandId)}`, {
      method: 'PATCH',
      cookie: ownerCookie,
      body: { name: 'Marca Norte actualizada' },
    });
    assert.equal(updatedBrand.response.status, 200);
    assert.equal(updatedBrand.payload.name, 'Marca Norte actualizada');
    const renamedWorkspace = await send(baseUrl, `/workspaces/${encodeURIComponent(secondWorkspace.id)}`, {
      method: 'PATCH',
      cookie: ownerCookie,
      body: { name: 'Campaña primavera editada' },
    });
    assert.equal(renamedWorkspace.response.status, 200);
    assert.equal(renamedWorkspace.payload.workspaces.find(({ id }) => id === secondWorkspace.id).name, 'Campaña primavera editada');

    const otherWorkspaces = await send(baseUrl, '/workspaces', { cookie: otherCookie });
    assert.equal(otherWorkspaces.payload.workspaces.length, 1);
    assert.notEqual(otherWorkspaces.payload.workspaces[0].id, secondWorkspace.id);
    assert.equal((await send(baseUrl, '/data', { cookie: otherCookie })).payload.accounts.length, 0);
    assert.equal((await send(baseUrl, `/workspaces/${encodeURIComponent(secondWorkspace.id)}/brands`, {
      method: 'POST',
      cookie: otherCookie,
      body: { name: 'Inyección de marca' },
    })).response.status, 404);
    assert.equal((await send(baseUrl, `/workspaces/${encodeURIComponent(secondWorkspace.id)}`, {
      method: 'PATCH',
      cookie: otherCookie,
      body: { name: 'Acceso cruzado' },
    })).response.status, 404);
    assert.equal((await send(baseUrl, `/brands/${encodeURIComponent(brandId)}`, {
      method: 'PATCH',
      cookie: otherCookie,
      body: { name: 'Acceso cruzado' },
    })).response.status, 404);
    assert.equal((await send(baseUrl, '/workspaces/active', {
      method: 'PUT',
      cookie: otherCookie,
      body: { workspaceId: secondWorkspace.id },
    })).response.status, 404);
    assert.equal((await send(baseUrl, '/data/accounts/foreign-brand-account', {
      method: 'PUT',
      cookie: otherCookie,
      body: { name: 'No autorizado', networkId: 'instagram', brandId },
    })).response.status, 400);

    const persisted = await send(baseUrl, '/workspaces', { cookie: ownerCookie });
    assert.equal(persisted.payload.workspaces.find(({ id }) => id === secondWorkspace.id).brands.length, 2);
    assert.equal(persisted.payload.workspaces.find(({ id }) => id === secondWorkspace.id).brands.find(({ id }) => id === brandId).name, 'Marca Norte actualizada');
    assert.equal((await send(baseUrl, '/data', { cookie: ownerCookie })).payload.accounts.length, 2);
    assert.equal((await send(baseUrl, `/brands/${encodeURIComponent(brandId)}`, {
      method: 'DELETE',
      cookie: ownerCookie,
    })).response.status, 204);
    const accountsAfterBrandDelete = await send(baseUrl, '/data', { cookie: ownerCookie });
    assert.equal(accountsAfterBrandDelete.payload.accounts.length, 2);
    assert.equal(accountsAfterBrandDelete.payload.accounts.find(({ id }) => id === 'brand-account').brandId, secondWorkspace.brands[0].id);
    assert.equal(database.prepare('SELECT brand_id AS brandId FROM posts WHERE id = ?').get('space-draft').brandId, secondWorkspace.brands[0].id);

    const switchBack = await send(baseUrl, '/workspaces/active', {
      method: 'PUT',
      cookie: ownerCookie,
      body: { workspaceId: firstWorkspace.id },
    });
    assert.equal(switchBack.response.status, 200);
    const isolatedData = await send(baseUrl, '/data', { cookie: ownerCookie });
    assert.equal(isolatedData.payload.accounts.length, 0);
    const deleteWorkspace = await send(baseUrl, `/workspaces/${encodeURIComponent(secondWorkspace.id)}`, {
      method: 'DELETE',
      cookie: ownerCookie,
    });
    assert.equal(deleteWorkspace.response.status, 200);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM social_accounts WHERE user_id = ? AND workspace_id = ?')
      .get('workspace-owner', secondWorkspace.id).count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM posts WHERE user_id = ? AND workspace_id = ?')
      .get('workspace-owner', secondWorkspace.id).count, 0);
    const lastWorkspaceDelete = await send(baseUrl, `/workspaces/${encodeURIComponent(firstWorkspace.id)}`, {
      method: 'DELETE',
      cookie: ownerCookie,
    });
    assert.equal(lastWorkspaceDelete.response.status, 409);
  });
});

test('Facebook OAuth state is session-bound and page tokens are encrypted and isolated in SQLite', async () => {
  const providerCalls = [];
  let businessDiscoveryMode = 'empty';
  let emptyFallback = false;
  const fetchImpl = async (input) => {
    const url = new URL(input);
    providerCalls.push(url.pathname);
    let payload;
    if (url.pathname.endsWith('/oauth/access_token')) {
      if (url.searchParams.get('code') === 'provider-error-code') {
        return new Response(JSON.stringify({
          error: {
            code: 190,
            message: 'Invalid access_token=EAA123456789012345678901234567890 client_secret=test-only-secret code=provider-error-code',
          },
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      payload = url.searchParams.has('fb_exchange_token')
        ? { access_token: 'facebook-long-user-token', expires_in: 5_184_000 }
        : { access_token: 'facebook-short-user-token', expires_in: 3600 };
    } else if (url.pathname.endsWith('/me/businesses')) {
      if (businessDiscoveryMode === 'denied') {
        return new Response(JSON.stringify({
          error: { code: 200, type: 'OAuthException', message: 'Permissions error' },
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      payload = businessDiscoveryMode === 'pages'
        ? { data: [{ id: '123456', name: 'Portafolio de prueba' }] }
        : { data: [] };
    } else if (url.pathname.endsWith('/123456/owned_pages')) {
      payload = businessDiscoveryMode === 'pages'
        ? { data: [{ id: '700001', name: 'Página del portafolio', tasks: ['CREATE_CONTENT'] }] }
        : { data: [] };
    } else if (url.pathname.endsWith('/123456/client_pages')) {
      payload = businessDiscoveryMode === 'pages'
        ? { data: [{ id: '700002', name: 'Página cliente', access_token: 'client-page-token', permitted_tasks: ['ANALYZE'] }] }
        : { data: [] };
    } else if (url.pathname.endsWith('/700001')) {
      payload = {
        id: '700001',
        name: 'Página del portafolio',
        access_token: 'business-page-token',
        tasks: ['CREATE_CONTENT'],
      };
    } else if (url.pathname.endsWith('/me/permissions')) {
      payload = { data: [
        { permission: 'pages_show_list', status: 'granted' },
        { permission: 'pages_read_engagement', status: 'granted' },
        { permission: 'pages_manage_posts', status: 'granted' },
        { permission: 'business_management', status: 'granted' },
      ] };
    } else if (url.pathname.endsWith('/me/accounts')) {
      payload = emptyFallback
        ? { data: [] }
        : url.searchParams.has('after')
        ? {
          data: [{ id: 'page-3', name: 'Tercera página', access_token: 'page-token-secret-3', tasks: ['CREATE_CONTENT'] }],
        }
        : {
          data: [
            { id: 'page-1', name: 'Primera página', access_token: 'page-token-secret-1', tasks: ['ANALYZE'] },
            { id: 'page-2', name: 'Segunda página', access_token: 'page-token-secret-2', tasks: ['ANALYZE'] },
          ],
          paging: {
            next: 'https://graph.facebook.com/v24.0/me/accounts?after=next-page&access_token=facebook-long-user-token',
          },
        };
    } else if (url.pathname.endsWith('/me')) {
      payload = { id: 'facebook-user-1', name: 'Usuario Facebook' };
    } else {
      throw new Error(`Unexpected Meta API path: ${url.pathname}`);
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await withServer({
    mailer: null,
    googleClient: null,
    facebookOAuthConfig: {
      configured: true,
      appId: 'test-facebook-app',
      appSecret: 'test-only-secret',
      redirectUri: 'http://localhost:5173/api/connections/facebook/callback',
      graphVersion: 'v24.0',
    },
    socialTokenEncryptionKey: Buffer.alloc(32, 7),
    fetchImpl,
  }, async ({ app, baseUrl, directory }) => {
    const database = app.locals.database;
    database.prepare('INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)')
      .run('facebook-owner', 'Facebook Owner', 'facebook-owner@example.test', 'test-hash');
    database.prepare('INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)')
      .run('facebook-other', 'Facebook Other', 'facebook-other@example.test', 'test-hash');
    const ownerToken = 'facebook-owner-session';
    const otherToken = 'facebook-other-session';
    const insertSession = database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)');
    insertSession.run(createHash('sha256').update(ownerToken).digest('hex'), 'facebook-owner', Date.now() + 600_000);
    insertSession.run(createHash('sha256').update(otherToken).digest('hex'), 'facebook-other', Date.now() + 600_000);
    const ownerCookie = `lop_session=${ownerToken}`;
    const ownerWorkspaces = await send(baseUrl, '/workspaces', { cookie: ownerCookie });
    const ownerWorkspace = ownerWorkspaces.payload.workspaces[0];
    const brand = ownerWorkspace.brands[0];
    const methods = await send(baseUrl, '/connections/methods', { cookie: ownerCookie });
    assert.equal(methods.payload.facebook.available, true);
    assert.deepEqual(methods.payload.facebook.requiredPermissions, [
      'pages_show_list',
      'pages_read_engagement',
      'pages_manage_posts',
    ]);
    assert.deepEqual(methods.payload.facebook.optionalPermissions, ['business_management']);

    const authorize = await fetch(`${baseUrl}/api/connections/facebook/authorize?brandId=${brand.id}`, {
      headers: { Cookie: ownerCookie, Origin: origin },
      redirect: 'manual',
    });
    assert.equal(authorize.status, 302);
    const authorizationUrl = new URL(authorize.headers.get('location'));
    assert.equal(authorizationUrl.origin, 'https://www.facebook.com');
    assert.equal(authorizationUrl.searchParams.get('client_id'), 'test-facebook-app');
    assert.equal(authorizationUrl.searchParams.get('scope'), 'pages_show_list,pages_read_engagement,pages_manage_posts,business_management');
    const state = authorizationUrl.searchParams.get('state');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM social_oauth_states WHERE state_hash = ?')
      .get(createHash('sha256').update(state).digest('hex')).count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM social_connections').get().count, 0);

    const callback = await fetch(`${baseUrl}/api/connections/facebook/callback?code=provider-code&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: ownerCookie, Origin: origin },
      redirect: 'manual',
    });
    assert.equal(callback.status, 302);
    const selectionUrl = new URL(callback.headers.get('location'), origin);
    assert.equal(selectionUrl.searchParams.get('connection'), 'facebook-select');
    const selectionId = selectionUrl.searchParams.get('selection');
    assert.ok(selectionUrl.searchParams.get('event'));
    assert.deepEqual(providerCalls, [
      '/v24.0/oauth/access_token',
      '/v24.0/oauth/access_token',
      '/v24.0/me/permissions',
      '/v24.0/me',
      '/v24.0/me/businesses',
      '/v24.0/me/accounts',
      '/v24.0/me/accounts',
    ]);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM social_connections').get().count, 0);
    const selectionResponse = await send(baseUrl, `/connections/facebook/page-selections/${selectionId}`, { cookie: ownerCookie });
    assert.equal(selectionResponse.response.status, 200);
    assert.deepEqual(selectionResponse.payload.selection.pages.map(({ id, name }) => ({ id, name })), [
      { id: 'page-1', name: 'Primera página' },
      { id: 'page-2', name: 'Segunda página' },
      { id: 'page-3', name: 'Tercera página' },
    ]);
    assert.deepEqual(selectionResponse.payload.selection.grantedScopes, [
      'pages_show_list',
      'pages_read_engagement',
      'pages_manage_posts',
      'business_management',
    ]);
    assert.equal(JSON.stringify(selectionResponse.payload).includes('page-token-secret'), false);
    const pendingSelections = await send(baseUrl, '/connections/facebook/page-selections/pending', { cookie: ownerCookie });
    assert.deepEqual(pendingSelections.payload.pending.map(({ id }) => id), [selectionId]);
    assert.equal(JSON.stringify(pendingSelections.payload).includes('page-token-secret'), false);
    const otherPendingSelections = await send(baseUrl, '/connections/facebook/page-selections/pending', {
      cookie: `lop_session=${otherToken}`,
    });
    assert.deepEqual(otherPendingSelections.payload.pending, []);
    const readyEvent = database.prepare(`
      SELECT id FROM facebook_oauth_events
      WHERE user_id = ? AND session_token_hash = ? AND event_type = 'pages-ready'
      ORDER BY created_at DESC LIMIT 1
    `).get('facebook-owner', createHash('sha256').update(ownerToken).digest('hex'));
    const eventResponse = await send(baseUrl, `/connections/facebook/oauth-events/${readyEvent.id}`, { cookie: ownerCookie });
    assert.equal(eventResponse.response.status, 200);
    assert.equal(eventResponse.payload.event.stage, 'selection-persistence');
    assert.equal(JSON.stringify(eventResponse.payload).includes('page-token-secret'), false);
    const selectionRecord = database.prepare(`
      SELECT id, user_id AS userId, session_token_hash AS sessionTokenHash,
        provider_user_id AS providerUserId, workspace_id AS workspaceId, brand_id AS brandId,
        granted_scopes_json AS grantedScopes, pages_encrypted AS pagesEncrypted
      FROM facebook_page_selections WHERE id = ?
    `).get(selectionId);
    database.prepare(`
      INSERT INTO facebook_page_selections (
        id, user_id, session_token_hash, provider_user_id, workspace_id, brand_id,
        granted_scopes_json, pages_encrypted, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'expired-test-selection',
      selectionRecord.userId,
      selectionRecord.sessionTokenHash,
      selectionRecord.providerUserId,
      selectionRecord.workspaceId,
      selectionRecord.brandId,
      selectionRecord.grantedScopes,
      selectionRecord.pagesEncrypted,
      Date.now() - 1,
    );
    const expiredSelection = await send(baseUrl, '/connections/facebook/page-selections/expired-test-selection', { cookie: ownerCookie });
    assert.equal(expiredSelection.response.status, 410);
    const expiredSave = await send(baseUrl, '/connections/facebook/page-selections/expired-test-selection', {
      method: 'POST',
      cookie: ownerCookie,
      body: { pages: [{ providerAccountId: 'page-1', workspaceId: ownerWorkspace.id, brandId: brand.id }] },
    });
    assert.equal(expiredSave.response.status, 410);
    const foreignSelection = await send(baseUrl, `/connections/facebook/page-selections/${selectionId}`, {
      cookie: `lop_session=${otherToken}`,
    });
    assert.equal(foreignSelection.response.status, 404);

    const ownerDataBeforeSelection = await send(baseUrl, '/data', { cookie: ownerCookie });
    assert.equal(ownerDataBeforeSelection.payload.accounts.length, 0);
    const emptySummary = await send(
      baseUrl,
      `/connections/summary?workspaceId=${encodeURIComponent(ownerWorkspace.id)}&brandId=${encodeURIComponent(brand.id)}`,
      { cookie: ownerCookie },
    );
    assert.deepEqual(emptySummary.payload, {
      workspaceId: ownerWorkspace.id,
      brandId: brand.id,
      registeredAccounts: 0,
      officialConnections: 0,
    });
    const isolatedData = await send(baseUrl, '/data', { cookie: `lop_session=${otherToken}` });
    assert.deepEqual(isolatedData.payload.accounts, []);
    const foreignWorkspaceSummary = await send(
      baseUrl,
      `/connections/summary?workspaceId=${encodeURIComponent(ownerWorkspace.id)}`,
      { cookie: `lop_session=${otherToken}` },
    );
    assert.equal(foreignWorkspaceSummary.response.status, 404);
    const secondBrand = await send(baseUrl, `/workspaces/${ownerWorkspace.id}/brands`, {
      method: 'POST',
      cookie: ownerCookie,
      body: { name: 'Marca secundaria' },
    });
    assert.equal(secondBrand.response.status, 201);
    const secondWorkspace = await send(baseUrl, '/workspaces', {
      method: 'POST',
      cookie: ownerCookie,
      body: { name: 'Segundo espacio' },
    });
    assert.equal(secondWorkspace.response.status, 201);
    const secondWorkspaceRecord = secondWorkspace.payload.workspaces
      .find(({ id }) => id === secondWorkspace.payload.activeWorkspaceId);
    const switchBack = await send(baseUrl, '/workspaces/active', {
      method: 'PUT',
      cookie: ownerCookie,
      body: { workspaceId: ownerWorkspace.id },
    });
    assert.equal(switchBack.response.status, 200);
    const selected = await send(baseUrl, `/connections/facebook/page-selections/${selectionId}`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        pages: [
          { providerAccountId: 'page-1', workspaceId: ownerWorkspace.id, brandId: ownerWorkspace.brands[0].id },
          { providerAccountId: 'page-2', workspaceId: ownerWorkspace.id, brandId: ownerWorkspace.brands[0].id },
          {
            providerAccountId: 'page-3',
            workspaceId: secondWorkspaceRecord.id,
            brandId: secondWorkspaceRecord.brands[0].id,
          },
        ],
      },
    });
    assert.equal(selected.response.status, 201);
    assert.equal(selected.payload.connectedCount, 3);
    const ownerSummary = await send(
      baseUrl,
      `/connections/summary?workspaceId=${encodeURIComponent(ownerWorkspace.id)}&brandId=${encodeURIComponent(brand.id)}`,
      { cookie: ownerCookie },
    );
    assert.deepEqual(ownerSummary.payload, {
      workspaceId: ownerWorkspace.id,
      brandId: brand.id,
      registeredAccounts: 2,
      officialConnections: 2,
    });
    const secondWorkspaceSummary = await send(
      baseUrl,
      `/connections/summary?workspaceId=${encodeURIComponent(secondWorkspaceRecord.id)}&brandId=${encodeURIComponent(secondWorkspaceRecord.brands[0].id)}`,
      { cookie: ownerCookie },
    );
    assert.deepEqual(secondWorkspaceSummary.payload, {
      workspaceId: secondWorkspaceRecord.id,
      brandId: secondWorkspaceRecord.brands[0].id,
      registeredAccounts: 1,
      officialConnections: 1,
    });
    const otherUserSummary = await send(baseUrl, '/connections/summary', { cookie: `lop_session=${otherToken}` });
    assert.equal(otherUserSummary.payload.registeredAccounts, 0);
    assert.equal(otherUserSummary.payload.officialConnections, 0);
    const storedTokens = database.prepare('SELECT access_token_encrypted AS token FROM social_connections ORDER BY provider_account_id').all();
    assert.equal(storedTokens.length, 3);
    assert.equal(JSON.stringify(storedTokens).includes('page-token-secret'), false);
    assert.ok(storedTokens.every(({ token }) => token.split('.').length === 3));
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM social_accounts WHERE user_id = ?').get('facebook-owner').count, 3);
    const savedEvent = database.prepare(`
      SELECT id FROM facebook_oauth_events
      WHERE user_id = ? AND session_token_hash = ? AND event_type = 'pages-saved'
      ORDER BY created_at DESC LIMIT 1
    `).get('facebook-owner', createHash('sha256').update(ownerToken).digest('hex'));
    const savedEventResponse = await send(baseUrl, `/connections/facebook/oauth-events/${savedEvent.id}`, { cookie: ownerCookie });
    assert.equal(savedEventResponse.payload.event.reason, '3');
    const ownerData = await send(baseUrl, '/data', { cookie: ownerCookie });
    assert.deepEqual(ownerData.payload.accounts.map(({ status, grantedScopes, name }) => ({ status, grantedScopes, name })).sort((a, b) => a.name.localeCompare(b.name)), [
      {
        status: 'connected',
        grantedScopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'business_management'],
        name: 'Primera página',
      },
      {
        status: 'connected',
        grantedScopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'business_management'],
        name: 'Segunda página',
      },
    ]);
    assert.equal(JSON.stringify(ownerData.payload).includes('page-token-secret'), false);
    const activeWorkspaceConnections = (await send(baseUrl, '/connections', { cookie: ownerCookie })).payload.connections;
    assert.equal(activeWorkspaceConnections.length, 2);
    assert.ok(activeWorkspaceConnections.every(({ status }) => status === 'connected'));
    const connection = activeWorkspaceConnections.find(({ providerAccountId }) => providerAccountId === 'page-1');
    assert.equal(Object.hasOwn(connection, 'accessToken'), false);
    const reassigned = await send(baseUrl, `/connections/${connection.id}`, {
      method: 'PATCH',
      cookie: ownerCookie,
      body: { workspaceId: ownerWorkspace.id, brandId: secondBrand.payload.id },
    });
    assert.equal(reassigned.response.status, 204);
    const oldBrandSummary = await send(
      baseUrl,
      `/connections/summary?workspaceId=${encodeURIComponent(ownerWorkspace.id)}&brandId=${encodeURIComponent(brand.id)}`,
      { cookie: ownerCookie },
    );
    assert.deepEqual(oldBrandSummary.payload, {
      workspaceId: ownerWorkspace.id,
      brandId: brand.id,
      registeredAccounts: 1,
      officialConnections: 1,
    });
    const reassignedBrandSummary = await send(
      baseUrl,
      `/connections/summary?workspaceId=${encodeURIComponent(ownerWorkspace.id)}&brandId=${encodeURIComponent(secondBrand.payload.id)}`,
      { cookie: ownerCookie },
    );
    assert.deepEqual(reassignedBrandSummary.payload, {
      workspaceId: ownerWorkspace.id,
      brandId: secondBrand.payload.id,
      registeredAccounts: 1,
      officialConnections: 1,
    });

    const disconnected = await send(baseUrl, `/connections/${connection.id}`, {
      method: 'DELETE',
      cookie: ownerCookie,
    });
    assert.equal(disconnected.response.status, 204);
    const disconnectedSummary = await send(
      baseUrl,
      `/connections/summary?workspaceId=${encodeURIComponent(ownerWorkspace.id)}&brandId=${encodeURIComponent(secondBrand.payload.id)}`,
      { cookie: ownerCookie },
    );
    assert.deepEqual(disconnectedSummary.payload, {
      workspaceId: ownerWorkspace.id,
      brandId: secondBrand.payload.id,
      registeredAccounts: 0,
      officialConnections: 0,
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM social_connections').get().count, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM social_accounts').get().count, 2);
    assert.equal((await send(baseUrl, '/data', { cookie: ownerCookie })).payload.accounts.length, 1);
    const providerErrorState = 'test-facebook-provider-error-state';
    database.prepare(`
      INSERT INTO social_oauth_states
        (state_hash, user_id, session_token_hash, workspace_id, brand_id, network_id, expires_at)
      VALUES (?, ?, ?, ?, ?, 'facebook', ?)
    `).run(
      createHash('sha256').update(providerErrorState).digest('hex'),
      'facebook-owner',
      createHash('sha256').update(ownerToken).digest('hex'),
      ownerWorkspace.id,
      ownerWorkspace.brands[0].id,
      Date.now() + 60_000,
    );
    const providerErrorCallback = await fetch(
      `${baseUrl}/api/connections/facebook/callback?code=provider-error-code&state=${encodeURIComponent(providerErrorState)}`,
      { headers: { Cookie: ownerCookie, Origin: origin }, redirect: 'manual' },
    );
    const providerErrorUrl = new URL(providerErrorCallback.headers.get('location'), origin);
    assert.equal(providerErrorUrl.searchParams.get('reason'), 'provider-error');
    const providerErrorEvent = await send(
      baseUrl,
      `/connections/facebook/oauth-events/${providerErrorUrl.searchParams.get('event')}`,
      { cookie: ownerCookie },
    );
    const diagnosticMessage = providerErrorEvent.payload.event.providerMessage;
    assert.equal(diagnosticMessage.includes('EAA123456789012345678901234567890'), false);
    assert.equal(diagnosticMessage.includes('test-only-secret'), false);
    assert.equal(diagnosticMessage.includes('provider-error-code'), false);
    assert.match(diagnosticMessage, /\[redacted/);
    const expiredState = 'test-facebook-expired-state';
    database.prepare(`
      INSERT INTO social_oauth_states
        (state_hash, user_id, session_token_hash, workspace_id, brand_id, network_id, expires_at)
      VALUES (?, ?, ?, ?, ?, 'facebook', ?)
    `).run(
      createHash('sha256').update(expiredState).digest('hex'),
      'facebook-owner',
      createHash('sha256').update(ownerToken).digest('hex'),
      ownerWorkspace.id,
      ownerWorkspace.brands[0].id,
      Date.now() - 1,
    );
    const expiredCallback = await fetch(
      `${baseUrl}/api/connections/facebook/callback?code=not-used&state=${encodeURIComponent(expiredState)}`,
      { headers: { Cookie: ownerCookie, Origin: origin }, redirect: 'manual' },
    );
    const expiredCallbackUrl = new URL(expiredCallback.headers.get('location'), origin);
    assert.equal(expiredCallbackUrl.searchParams.get('reason'), 'state-expired');
    const expiredEvent = await send(
      baseUrl,
      `/connections/facebook/oauth-events/${expiredCallbackUrl.searchParams.get('event')}`,
      { cookie: ownerCookie },
    );
    assert.equal(expiredEvent.payload.event.stage, 'state-validation');
    assert.equal(expiredEvent.payload.event.reason, 'state-expired');
    assert.equal(JSON.stringify(expiredEvent.payload).includes('not-used'), false);
    const discoveryState = 'test-facebook-business-discovery-state';
    database.prepare(`
      INSERT INTO social_oauth_states
        (state_hash, user_id, session_token_hash, workspace_id, brand_id, network_id, expires_at)
      VALUES (?, ?, ?, ?, ?, 'facebook', ?)
    `).run(
      createHash('sha256').update(discoveryState).digest('hex'),
      'facebook-owner',
      createHash('sha256').update(ownerToken).digest('hex'),
      ownerWorkspace.id,
      ownerWorkspace.brands[0].id,
      Date.now() + 60_000,
    );
    businessDiscoveryMode = 'pages';
    const callIndex = providerCalls.length;
    const businessCallback = await fetch(
      `${baseUrl}/api/connections/facebook/callback?code=business-discovery-code&state=${encodeURIComponent(discoveryState)}`,
      { headers: { Cookie: ownerCookie, Origin: origin }, redirect: 'manual' },
    );
    const businessSelectionId = new URL(businessCallback.headers.get('location'), origin).searchParams.get('selection');
    assert.deepEqual(providerCalls.slice(callIndex), [
      '/v24.0/oauth/access_token',
      '/v24.0/oauth/access_token',
      '/v24.0/me/permissions',
      '/v24.0/me',
      '/v24.0/me/businesses',
      '/v24.0/123456/owned_pages',
      '/v24.0/700001',
      '/v24.0/123456/client_pages',
    ]);
    const businessSelection = await send(
      baseUrl,
      `/connections/facebook/page-selections/${businessSelectionId}`,
      { cookie: ownerCookie },
    );
    assert.deepEqual(businessSelection.payload.selection.pages.map(({ id, name, tasks }) => ({ id, name, tasks })), [
      { id: '700001', name: 'Página del portafolio', tasks: ['CREATE_CONTENT'] },
      { id: '700002', name: 'Página cliente', tasks: ['ANALYZE'] },
    ]);
    assert.equal(JSON.stringify(businessSelection.payload).includes('business-page-token'), false);
    assert.equal(JSON.stringify(businessSelection.payload).includes('client-page-token'), false);
    const discoveryEvent = database.prepare(`
      SELECT reason FROM facebook_oauth_events
      WHERE user_id = ? AND session_token_hash = ? AND event_type = 'pages-discovered'
      ORDER BY created_at DESC LIMIT 1
    `).get('facebook-owner', createHash('sha256').update(ownerToken).digest('hex'));
    assert.equal(discoveryEvent.reason, 'business-manager:2');
    businessDiscoveryMode = 'denied';
    const deniedState = 'test-facebook-business-denied-state';
    database.prepare(`
      INSERT INTO social_oauth_states
        (state_hash, user_id, session_token_hash, workspace_id, brand_id, network_id, expires_at)
      VALUES (?, ?, ?, ?, ?, 'facebook', ?)
    `).run(
      createHash('sha256').update(deniedState).digest('hex'),
      'facebook-owner',
      createHash('sha256').update(ownerToken).digest('hex'),
      ownerWorkspace.id,
      ownerWorkspace.brands[0].id,
      Date.now() + 60_000,
    );
    const deniedCallIndex = providerCalls.length;
    const fallbackCallback = await fetch(
      `${baseUrl}/api/connections/facebook/callback?code=business-denied-code&state=${encodeURIComponent(deniedState)}`,
      { headers: { Cookie: ownerCookie, Origin: origin }, redirect: 'manual' },
    );
    const fallbackSelectionId = new URL(fallbackCallback.headers.get('location'), origin).searchParams.get('selection');
    assert.deepEqual(providerCalls.slice(deniedCallIndex), [
      '/v24.0/oauth/access_token',
      '/v24.0/oauth/access_token',
      '/v24.0/me/permissions',
      '/v24.0/me',
      '/v24.0/me/businesses',
      '/v24.0/me/accounts',
      '/v24.0/me/accounts',
    ]);
    const fallbackSelection = await send(
      baseUrl,
      `/connections/facebook/page-selections/${fallbackSelectionId}`,
      { cookie: ownerCookie },
    );
    assert.equal(fallbackSelection.payload.selection.pages.length, 3);
    const fallbackEvent = database.prepare(`
      SELECT provider_code AS providerCode, provider_message AS providerMessage, reason
      FROM facebook_oauth_events
      WHERE user_id = ? AND session_token_hash = ? AND event_type = 'pages-discovered'
      ORDER BY created_at DESC LIMIT 1
    `).get('facebook-owner', createHash('sha256').update(ownerToken).digest('hex'));
    assert.equal(fallbackEvent.providerCode, '200');
    assert.equal(fallbackEvent.reason, 'me/accounts:3');
    assert.match(fallbackEvent.providerMessage, /Business Manager: Permissions error/);
    businessDiscoveryMode = 'denied';
    emptyFallback = true;
    const noPagesState = 'test-facebook-business-error-state';
    database.prepare(`
      INSERT INTO social_oauth_states
        (state_hash, user_id, session_token_hash, workspace_id, brand_id, network_id, expires_at)
      VALUES (?, ?, ?, ?, ?, 'facebook', ?)
    `).run(
      createHash('sha256').update(noPagesState).digest('hex'),
      'facebook-owner',
      createHash('sha256').update(ownerToken).digest('hex'),
      ownerWorkspace.id,
      ownerWorkspace.brands[0].id,
      Date.now() + 60_000,
    );
    const noPagesCallback = await fetch(
      `${baseUrl}/api/connections/facebook/callback?code=no-pages-code&state=${encodeURIComponent(noPagesState)}`,
      { headers: { Cookie: ownerCookie, Origin: origin }, redirect: 'manual' },
    );
    const noPagesUrl = new URL(noPagesCallback.headers.get('location'), origin);
    assert.equal(noPagesUrl.searchParams.get('reason'), 'no-manageable-pages');
    const noPagesEvent = await send(
      baseUrl,
      `/connections/facebook/oauth-events/${noPagesUrl.searchParams.get('event')}`,
      { cookie: ownerCookie },
    );
    assert.equal(noPagesEvent.payload.event.stage, 'page-discovery');
    assert.equal(noPagesEvent.payload.event.providerCode, '200');
    assert.match(noPagesEvent.payload.event.providerMessage, /Business Manager: Permissions error/);
    assert.match(noPagesEvent.payload.event.providerMessage, /\/me\/accounts tampoco devolvió páginas/);
    businessDiscoveryMode = 'empty';
    emptyFallback = false;
    assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
    const reopenedDatabase = new Database(join(directory, 'test.sqlite'), { readonly: true });
    assert.equal(reopenedDatabase.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(reopenedDatabase.prepare('SELECT COUNT(*) AS count FROM social_connections').get().count, 2);
    assert.equal(reopenedDatabase.prepare('SELECT COUNT(*) AS count FROM social_accounts').get().count, 2);
    assert.equal(reopenedDatabase.prepare('SELECT COUNT(*) AS count FROM social_connections WHERE granted_scopes_json LIKE ?')
      .get('%pages_manage_posts%').count, 2);
    reopenedDatabase.close();
  });
});
