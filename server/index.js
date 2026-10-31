import { promisify } from 'node:util';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { OAuth2Client } from 'google-auth-library';
import express from 'express';
import helmet from 'helmet';
import nodemailer from 'nodemailer';
import { createInstagramOAuthConfig, initializeInstagramDatabase, registerInstagramRoutes } from './instagram.js';
import { initializeYouTubeDatabase, registerYouTubeRoutes, youtubeRequiredScopes } from './youtube.js';
import { createFacebookVerifier, registerFacebookVerification } from './facebook.js';
import { createTikTokOAuthConfig, initializeTikTokDatabase, registerTikTokRoutes, getTikTokConnections, tiktokRequiredScopes } from './tiktok.js';

const scrypt = promisify(scryptCallback);
const sessionCookie = 'lop_session';
const googleStateCookie = 'lop_google_state';
const sessionDurationMs = 14 * 24 * 60 * 60 * 1000;
const socialOAuthStateDurationMs = 30 * 60 * 1000;
const codeLifetimeMs = 10 * 60 * 1000;
const codeCooldownMs = 60 * 1000;
const maxCodeAttempts = 5;
const networkIds = new Set(['facebook', 'instagram', 'threads', 'tiktok', 'youtube', 'linkedin', 'x']);
const postFormats = new Set(['text', 'image', 'video', 'carousel', 'story', 'reel', 'short']);
const facebookPageSelectionDurationMs = 30 * 60 * 1000;
const youtubeChannelSelectionDurationMs = 30 * 60 * 1000;

const hash = (value) => createHash('sha256').update(value).digest('hex');
const jsonError = (response, status, message) => response.status(status).json({ error: message });
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const facebookPagePermissions = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'];
const facebookPermissions = [...facebookPagePermissions, 'business_management'];

function createFacebookOAuthConfig(environment = process.env) {
  const required = ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET', 'FACEBOOK_REDIRECT_URI', 'META_GRAPH_API_VERSION'];
  const missing = required.filter((key) => !environment[key]);
  if (missing.length) return { configured: false, missing };
  const redirectUri = new URL(environment.FACEBOOK_REDIRECT_URI);
  const localHttp = redirectUri.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(redirectUri.hostname);
  if ((!localHttp && redirectUri.protocol !== 'https:')
    || redirectUri.pathname !== '/api/connections/facebook/callback'
    || redirectUri.search || redirectUri.hash) {
    throw new Error('FACEBOOK_REDIRECT_URI debe usar HTTPS (o localhost HTTP) y terminar exactamente en /api/connections/facebook/callback.');
  }
  if (!/^v\d+\.\d+$/.test(environment.META_GRAPH_API_VERSION)) {
    throw new Error('META_GRAPH_API_VERSION debe tener el formato oficial vNN.N.');
  }
  return {
    configured: true,
    appId: environment.FACEBOOK_APP_ID,
    appSecret: environment.FACEBOOK_APP_SECRET,
    redirectUri: redirectUri.href,
    graphVersion: environment.META_GRAPH_API_VERSION,
  };
}

function createTokenEncryptionKey(value) {
  if (!value) return null;
  if (!/^[\da-f]{64}$/i.test(value)) {
    throw new Error('SOCIAL_TOKEN_ENCRYPTION_KEY debe contener exactamente 64 caracteres hexadecimales.');
  }
  return Buffer.from(value, 'hex');
}

function encryptSocialToken(value, key, additionalData) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(additionalData));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decryptSocialToken(value, key, additionalData) {
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('El token social cifrado tiene un formato inválido.');
  const [nonce, authenticationTag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(additionalData));
  decipher.setAuthTag(authenticationTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const separator = part.indexOf('=');
    if (separator === -1) return ['', ''];
    const name = part.slice(0, separator).trim();
    try {
      return [name, decodeURIComponent(part.slice(separator + 1).trim())];
    } catch {
      return [name, ''];
    }
  }).filter(([name]) => name));
}

function validText(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

function validCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizeGooglePicture(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const picture = new URL(value);
    if (picture.protocol !== 'https:' || picture.username || picture.password
      || (picture.hostname !== 'googleusercontent.com' && !picture.hostname.endsWith('.googleusercontent.com'))) {
      return null;
    }
    return picture.href;
  } catch {
    return null;
  }
}

function createDatabase(databasePath) {
  const database = new Database(databasePath);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      google_sub TEXT UNIQUE,
      google_picture TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, id)
    );
    CREATE INDEX IF NOT EXISTS workspaces_user_id ON workspaces(user_id);
    CREATE TABLE IF NOT EXISTS brands (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      logo_url TEXT,
      settings_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(workspace_id, id)
    );
    CREATE INDEX IF NOT EXISTS brands_workspace_id ON brands(workspace_id);
    CREATE TABLE IF NOT EXISTS user_workspace_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      active_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_brand_selections (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      brand_id TEXT REFERENCES brands(id) ON DELETE SET NULL,
      PRIMARY KEY (user_id, workspace_id)
    );
    CREATE TABLE IF NOT EXISTS verification_codes (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'password_reset')),
      code_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, purpose)
    );
    CREATE TABLE IF NOT EXISTS verification_throttles (
      email TEXT NOT NULL,
      purpose TEXT NOT NULL,
      next_allowed_at INTEGER NOT NULL,
      PRIMARY KEY (email, purpose)
    );
    CREATE TABLE IF NOT EXISTS social_accounts (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      network_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'demo' CHECK (status = 'demo'),
      preference_enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, id)
    );
    CREATE TABLE IF NOT EXISTS social_connections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      network_id TEXT NOT NULL CHECK (network_id = 'facebook'),
      provider_account_id TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('connected', 'expired')),
      access_token_encrypted TEXT NOT NULL,
      expires_at INTEGER,
      granted_scopes_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id, account_id) REFERENCES social_accounts(user_id, id) ON DELETE CASCADE,
      UNIQUE (user_id, network_id, provider_account_id)
    );
    CREATE INDEX IF NOT EXISTS social_connections_workspace_brand
      ON social_connections(user_id, workspace_id, brand_id);
    CREATE TABLE IF NOT EXISTS facebook_page_selections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_token_hash TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      granted_scopes_json TEXT NOT NULL,
      pages_encrypted TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS facebook_page_selections_user_expiry
      ON facebook_page_selections(user_id, expires_at);
    CREATE TABLE IF NOT EXISTS facebook_oauth_events (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      session_token_hash TEXT,
      event_type TEXT NOT NULL,
      stage TEXT NOT NULL,
      reason TEXT,
      provider_code TEXT,
      provider_subcode TEXT,
      provider_type TEXT,
      provider_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS facebook_oauth_events_user_created
      ON facebook_oauth_events(user_id, created_at);
    CREATE TABLE IF NOT EXISTS social_oauth_states (
      state_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_token_hash TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      network_id TEXT NOT NULL CHECK (network_id = 'facebook'),
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS youtube_oauth_states (
      state_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_token_hash TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS youtube_oauth_states_expires_at ON youtube_oauth_states(expires_at);
    CREATE TABLE IF NOT EXISTS youtube_channel_selections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_token_hash TEXT NOT NULL,
      channels_encrypted TEXT NOT NULL,
      credentials_encrypted TEXT NOT NULL,
      granted_scopes_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS youtube_channel_selections_user_expiry
      ON youtube_channel_selections(user_id, expires_at);
    CREATE TABLE IF NOT EXISTS youtube_connections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      provider_channel_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('connected', 'expired')),
      credentials_encrypted TEXT NOT NULL,
      granted_scopes_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id, account_id) REFERENCES social_accounts(user_id, id) ON DELETE CASCADE,
      UNIQUE (user_id, provider_channel_id)
    );
    CREATE INDEX IF NOT EXISTS youtube_connections_workspace_brand
      ON youtube_connections(user_id, workspace_id, brand_id);
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      hashtags TEXT NOT NULL DEFAULT '',
      network_id TEXT,
      network_ids TEXT NOT NULL DEFAULT '[]',
      network_content TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status = 'draft'),
      scheduled_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      format TEXT NOT NULL DEFAULT 'text',
      PRIMARY KEY (user_id, id)
    );
    CREATE TABLE IF NOT EXISTS calendar_notes (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      note_date TEXT NOT NULL,
      text TEXT NOT NULL,
      reminder_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, id)
    );
    CREATE INDEX IF NOT EXISTS calendar_notes_date ON calendar_notes(user_id, workspace_id, brand_id, note_date);
  `);

  const columns = new Set(database.pragma('table_info(users)').map((column) => column.name));
  if (!columns.has('email_verified')) database.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('google_sub')) database.exec('ALTER TABLE users ADD COLUMN google_sub TEXT');
  if (!columns.has('google_picture')) database.exec('ALTER TABLE users ADD COLUMN google_picture TEXT');
  const accountColumns = new Set(database.pragma('table_info(social_accounts)').map((column) => column.name));
  if (!accountColumns.has('workspace_id')) database.exec('ALTER TABLE social_accounts ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE');
  if (!accountColumns.has('brand_id')) database.exec('ALTER TABLE social_accounts ADD COLUMN brand_id TEXT REFERENCES brands(id) ON DELETE SET NULL');
  const postColumns = new Set(database.pragma('table_info(posts)').map((column) => column.name));
  if (!postColumns.has('workspace_id')) database.exec('ALTER TABLE posts ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE');
  if (!postColumns.has('brand_id')) database.exec('ALTER TABLE posts ADD COLUMN brand_id TEXT REFERENCES brands(id) ON DELETE SET NULL');
  if (!postColumns.has('format')) database.exec("ALTER TABLE posts ADD COLUMN format TEXT NOT NULL DEFAULT 'text'");
  if (!postColumns.has('title')) database.exec("ALTER TABLE posts ADD COLUMN title TEXT NOT NULL DEFAULT ''");
  if (!postColumns.has('description')) database.exec("ALTER TABLE posts ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  if (!postColumns.has('hashtags')) database.exec("ALTER TABLE posts ADD COLUMN hashtags TEXT NOT NULL DEFAULT ''");
  if (!postColumns.has('network_content')) database.exec("ALTER TABLE posts ADD COLUMN network_content TEXT NOT NULL DEFAULT '{}'");
  const scheduledAtColumn = database.pragma('table_info(posts)').find((column) => column.name === 'scheduled_at');
  if (scheduledAtColumn?.notnull) {
    database.exec(`
      CREATE TABLE posts_calendar_migration (
        id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        hashtags TEXT NOT NULL DEFAULT '',
        network_id TEXT,
        network_ids TEXT NOT NULL DEFAULT '[]',
        network_content TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status = 'draft'),
        scheduled_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        brand_id TEXT REFERENCES brands(id) ON DELETE SET NULL,
        format TEXT NOT NULL DEFAULT 'text',
        PRIMARY KEY (user_id, id)
      );
      INSERT INTO posts_calendar_migration (id, user_id, text, title, description, hashtags, network_id, network_ids, network_content, status, scheduled_at, retry_count, workspace_id, brand_id, format)
      SELECT id, user_id, text, title, description, hashtags, network_id, network_ids, network_content, 'draft', scheduled_at, retry_count, workspace_id, brand_id, format FROM posts;
      DROP TABLE posts;
      ALTER TABLE posts_calendar_migration RENAME TO posts;
    `);
  }
  database.exec('CREATE INDEX IF NOT EXISTS social_accounts_workspace_brand ON social_accounts(user_id, workspace_id, brand_id)');
  database.exec('CREATE INDEX IF NOT EXISTS posts_workspace_id ON posts(user_id, workspace_id)');
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique ON users(google_sub) WHERE google_sub IS NOT NULL');
  if (columns.has('phone')) database.exec('ALTER TABLE users DROP COLUMN phone');
  const migrateUserWorkspaces = database.transaction(() => {
    const users = database.prepare('SELECT id FROM users').all();
    for (const { id: userId } of users) {
      let workspace = database.prepare('SELECT id FROM workspaces WHERE user_id = ? ORDER BY created_at, id LIMIT 1').get(userId);
      if (!workspace) {
        const workspaceId = `workspace-${randomUUID()}`;
        database.prepare('INSERT INTO workspaces (id, user_id, name) VALUES (?, ?, ?)').run(workspaceId, userId, 'Mi espacio');
        workspace = { id: workspaceId };
      }
      let brand = database.prepare('SELECT id FROM brands WHERE workspace_id = ? ORDER BY created_at, id LIMIT 1').get(workspace.id);
      if (!brand) {
        const brandId = `brand-${randomUUID()}`;
        database.prepare('INSERT INTO brands (id, workspace_id, name) VALUES (?, ?, ?)').run(brandId, workspace.id, 'Marca principal');
        brand = { id: brandId };
      }
      database.prepare('UPDATE social_accounts SET workspace_id = ?, brand_id = COALESCE(brand_id, ?) WHERE user_id = ? AND workspace_id IS NULL')
        .run(workspace.id, brand.id, userId);
      database.prepare('UPDATE posts SET workspace_id = ?, brand_id = COALESCE(brand_id, ?) WHERE user_id = ? AND workspace_id IS NULL')
        .run(workspace.id, brand.id, userId);
      database.prepare(`
        INSERT INTO user_workspace_settings (user_id, active_workspace_id)
        VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET active_workspace_id =
          CASE
            WHEN user_workspace_settings.active_workspace_id IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM workspaces
                WHERE id = user_workspace_settings.active_workspace_id AND user_id = excluded.user_id
              )
            THEN excluded.active_workspace_id
            ELSE user_workspace_settings.active_workspace_id
          END
      `).run(userId, workspace.id);
    }
  });
  migrateUserWorkspaces();
  database.exec('CREATE INDEX IF NOT EXISTS calendar_notes_date ON calendar_notes(user_id, workspace_id, brand_id, note_date)');
  if (!database.pragma('table_info(posts)').some((column) => column.name === 'account_ids')) database.exec("ALTER TABLE posts ADD COLUMN account_ids TEXT NOT NULL DEFAULT '[]'");
  const facebookColumns = new Set(database.pragma('table_info(social_connections)').map((column) => column.name));
  if (!facebookColumns.has('verified_at')) database.exec('ALTER TABLE social_connections ADD COLUMN verified_at TEXT');
  if (!facebookColumns.has('last_error_code')) database.exec('ALTER TABLE social_connections ADD COLUMN last_error_code TEXT');
  database.exec(`CREATE TABLE IF NOT EXISTS social_card_orders (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    account_ids_json TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (user_id, workspace_id)
  )`);
  database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  database.prepare("UPDATE social_accounts SET status = 'demo' WHERE status != 'demo'").run();
  database.prepare("UPDATE posts SET status = 'draft' WHERE status != 'draft'").run();
  return database;
}

function normalizePost(post) {
  if (!post || typeof post !== 'object'
    || !validText(post.id, 100)
    || !validText(post.text, 5000)
    || (post.title !== undefined && typeof post.title !== 'string')
    || (post.description !== undefined && typeof post.description !== 'string')
    || (post.hashtags !== undefined && typeof post.hashtags !== 'string')
    || (post.title || '').length > 200
    || (post.description || '').length > 2000
    || (post.hashtags || '').length > 1000
    || (post.date !== null && (typeof post.date !== 'string' || Number.isNaN(Date.parse(post.date))))
    || !postFormats.has(post.format || 'text')) return null;
  const selectedNetworks = Array.isArray(post.networkIds) && post.networkIds.length
    ? post.networkIds
    : post.networkId ? [post.networkId] : [];
  if (selectedNetworks.length > networkIds.size || selectedNetworks.some((id) => !networkIds.has(id))) return null;
  if (post.networkId != null && !networkIds.has(post.networkId)) return null;
  const networkContent = {};
  const accountIds = post.accountIds ?? [];
  if (!Array.isArray(accountIds) || accountIds.length > 1000 || accountIds.some((id) => !validText(id, 150)) || new Set(accountIds).size !== accountIds.length) return null;
  if (post.networkContent !== undefined
    && (!post.networkContent || typeof post.networkContent !== 'object' || Array.isArray(post.networkContent))) return null;
  for (const [networkId, content] of Object.entries(post.networkContent || {})) {
    if (!selectedNetworks.includes(networkId) || !content || typeof content !== 'object' || Array.isArray(content)) return null;
    if (Object.keys(content).some((field) => !['title', 'description', 'text', 'hashtags', 'settings'].includes(field))) return null;
    const normalizedContent = {};
    for (const [field, maxLength] of Object.entries({ title: 200, description: networkId === 'youtube' ? 5000 : 2000, text: 5000, hashtags: 1000 })) {
      const value = content[field] ?? '';
      if (typeof value !== 'string' || value.length > maxLength) return null;
      if (value.trim()) normalizedContent[field] = value.trim();
    }
    if (content.settings !== undefined
      && (!content.settings || typeof content.settings !== 'object' || Array.isArray(content.settings))) return null;
    const settings = {};
    for (const [key, value] of Object.entries(content.settings || {})) {
      if (!['link', 'altText', 'callToAction', 'visibility'].includes(key)
        || typeof value !== 'string' || value.length > 500) return null;
      if (key === 'link' && value.trim()) {
        try {
          const link = new URL(value);
          if (!['https:', 'http:'].includes(link.protocol) || link.username || link.password) return null;
        } catch {
          return null;
        }
      }
      if (value.trim()) settings[key] = value.trim();
    }
    if (Object.keys(settings).length) normalizedContent.settings = settings;
    if (Object.keys(normalizedContent).length) networkContent[networkId] = normalizedContent;
  }
  return {
    id: post.id.trim(),
    text: post.text.trim(),
    title: (post.title || '').trim(),
    description: (post.description || '').trim(),
    hashtags: (post.hashtags || '').trim(),
    networkId: post.networkId || null,
    networkIds: [...new Set(selectedNetworks)],
    networkContent,
    accountIds,
    status: 'draft',
    date: post.date === null ? null : new Date(post.date).toISOString(),
    format: post.format || 'text',
    brandId: typeof post.brandId === 'string' ? post.brandId : null,
  };
}

function normalizeAccount(account) {
  if (!account || typeof account !== 'object'
    || !validText(account.id, 100)
    || !validText(account.name, 120)
    || !networkIds.has(account.networkId)) return null;
  return {
    id: account.id.trim(),
    name: account.name.trim(),
    networkId: account.networkId,
    status: 'demo',
    preferenceEnabled: account.preferenceEnabled !== false,
  };
}

function normalizeBrandSettings(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const {
    description = '',
    website = '',
    primaryColor = '#087fb7',
    accentColor = '#44b9e2',
    timezone = 'America/Mexico_City',
  } = value;
  if (typeof description !== 'string' || description.length > 500
    || typeof website !== 'string' || website.length > 2048
    || typeof primaryColor !== 'string' || !/^#[\da-f]{6}$/i.test(primaryColor)
    || typeof accentColor !== 'string' || !/^#[\da-f]{6}$/i.test(accentColor)
    || typeof timezone !== 'string' || timezone.length > 100) return null;
  if (website) {
    try {
      const url = new URL(website);
      if (url.protocol !== 'https:' || url.username || url.password) return null;
    } catch {
      return null;
    }
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    return null;
  }
  return { description: description.trim(), website, primaryColor, accentColor, timezone };
}

function normalizeLogoUrl(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const logo = new URL(value);
    return logo.protocol === 'https:' && !logo.username && !logo.password ? logo.href : undefined;
  } catch {
    return undefined;
  }
}

function createMailer() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASSWORD || !SMTP_FROM) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  });
}

function createGoogleClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) return null;
  let redirect;
  try {
    redirect = new URL(GOOGLE_REDIRECT_URI);
  } catch {
    throw new Error('GOOGLE_REDIRECT_URI debe ser una URL válida de retorno OAuth.');
  }
  const localHttp = redirect.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname);
  if ((!localHttp && redirect.protocol !== 'https:')
    || redirect.username || redirect.password
    || redirect.pathname !== '/api/auth/google/callback'
    || redirect.search || redirect.hash) {
    throw new Error('GOOGLE_REDIRECT_URI debe usar HTTPS (o localhost HTTP) y terminar exactamente en /api/auth/google/callback.');
  }
  if (process.env.NODE_ENV === 'production' && (redirect.protocol !== 'https:'
    || ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) || redirect.hostname.endsWith('.localhost'))) {
    throw new Error('En producción, GOOGLE_REDIRECT_URI debe usar el dominio público HTTPS del entorno de producción.');
  }
  return new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

export function createYouTubeOAuthConfig(environment = process.env) {
  const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].filter((key) => !environment[key]);
  const googleRedirectUri = environment.GOOGLE_REDIRECT_URI;
  const redirectUri = environment.YOUTUBE_REDIRECT_URI || (googleRedirectUri
    ? new URL(googleRedirectUri).origin + '/api/connections/youtube/callback'
    : 'http://localhost:5173/api/connections/youtube/callback');
  let redirect;
  try {
    redirect = new URL(redirectUri);
  } catch {
    throw new Error('YOUTUBE_REDIRECT_URI debe ser una URL válida de retorno OAuth.');
  }
  const localHttp = redirect.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname);
  if ((!localHttp && redirect.protocol !== 'https:')
    || redirect.username || redirect.password
    || redirect.pathname !== '/api/connections/youtube/callback'
    || redirect.search || redirect.hash) {
    throw new Error('YOUTUBE_REDIRECT_URI debe usar HTTPS (o localhost HTTP) y terminar exactamente en /api/connections/youtube/callback.');
  }
  if (environment.NODE_ENV === 'production' && (redirect.protocol !== 'https:'
    || ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) || redirect.hostname.endsWith('.localhost'))) {
    throw new Error('En producción, YOUTUBE_REDIRECT_URI debe usar el dominio público HTTPS del entorno de producción.');
  }
  return {
    configured: missing.length === 0,
    missing,
    clientId: environment.GOOGLE_CLIENT_ID || '',
    clientSecret: environment.GOOGLE_CLIENT_SECRET || '',
    redirectUri: redirect.href,
  };
}

export function createApp({
  databasePath = process.env.LOP_DATABASE_PATH || resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'lop.sqlite'),
  mailer = createMailer(),
  googleClient = createGoogleClient(),
  googleClientId = process.env.GOOGLE_CLIENT_ID,
  facebookOAuthConfig = createFacebookOAuthConfig(),
  instagramOAuthConfig = createInstagramOAuthConfig(),
  youtubeOAuthConfig = createYouTubeOAuthConfig(),
  tiktokOAuthConfig = createTikTokOAuthConfig(),
  youtubeOAuthClient = youtubeOAuthConfig.configured
    ? new OAuth2Client(youtubeOAuthConfig.clientId, youtubeOAuthConfig.clientSecret, youtubeOAuthConfig.redirectUri)
    : null,
  socialTokenEncryptionKey = createTokenEncryptionKey(process.env.SOCIAL_TOKEN_ENCRYPTION_KEY),
  fetchImpl = globalThis.fetch,
} = {}) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = createDatabase(databasePath);
  initializeInstagramDatabase(database);
  initializeYouTubeDatabase(database);
  initializeTikTokDatabase(database);
  const app = express();
  const secureCookie = process.env.NODE_ENV === 'production';
  const sessionCookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookie,
    path: '/',
    ...(process.env.LOP_COOKIE_DOMAIN ? { domain: process.env.LOP_COOKIE_DOMAIN } : {}),
  };
  app.locals.database = database;
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '128kb', strict: true }));
  app.use('/api', (_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });

  const authAttempts = new Map();
  app.use('/api/auth', (request, response, next) => {
    if (request.method !== 'POST') return next();
    const limitedPaths = new Set([
      '/login',
      '/register',
      '/verify-email',
      '/verification/send',
      '/password/recovery',
      '/password/reset',
    ]);
    if (!limitedPaths.has(request.path)) return next();
    const now = Date.now();
    const key = `${request.ip}:${request.path}`;
    const previous = authAttempts.get(key);
    if (previous && previous.until > now && previous.count >= 10) {
      response.set('Retry-After', String(Math.ceil((previous.until - now) / 1000)));
      return jsonError(response, 429, 'Demasiados intentos. Espera unos minutos antes de volver a intentarlo.');
    }
    const attempt = previous && previous.until > now ? previous : { count: 0, until: now + 15 * 60 * 1000 };
    attempt.count += 1;
    authAttempts.set(key, attempt);
    if (authAttempts.size > 5000) {
      for (const [address, value] of authAttempts) if (value.until <= now) authAttempts.delete(address);
    }
    next();
  });

  app.use('/api', (request, response, next) => {
    const origin = request.get('origin');
    if (origin) {
      let requestOrigin;
      try {
        requestOrigin = new URL(origin).origin;
      } catch {
        return jsonError(response, 403, 'Origen no permitido.');
      }
      const allowedOrigins = process.env.LOP_ALLOWED_ORIGINS?.split(',').map((value) => value.trim()).filter(Boolean) || [
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://[::1]:5173',
        'http://localhost:3001',
        'http://127.0.0.1:3001',
        'http://[::1]:3001',
      ];
      if (!allowedOrigins.includes(requestOrigin)) return jsonError(response, 403, 'Origen no permitido.');
    }
    next();
  });

  const issueSession = (response, userId) => {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + sessionDurationMs;
    database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(hash(token), userId, expiresAt);
    response.cookie(sessionCookie, token, {
      ...sessionCookieOptions,
      maxAge: sessionDurationMs,
    });
  };

  const requireSession = (request, response, next) => {
    const token = parseCookies(request.get('cookie'))[sessionCookie];
    if (!token || token.length > 100) return jsonError(response, 401, 'Inicia sesión para continuar.');
    const session = database.prepare(`
      SELECT users.id, users.name, users.email, users.google_picture AS image
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `).get(hash(token), Date.now());
    if (!session) return jsonError(response, 401, 'La sesión venció. Inicia sesión nuevamente.');
    request.user = session;
    request.sessionTokenHash = hash(token);
    next();
  };

  const codeCooldownRemaining = (email, purpose) => {
    const record = database.prepare('SELECT next_allowed_at FROM verification_throttles WHERE email = ? AND purpose = ?')
      .get(email, purpose);
    return record ? Math.max(0, record.next_allowed_at - Date.now()) : 0;
  };

  const sendCode = async (user, purpose) => {
    if (!mailer) throw Object.assign(new Error('El envío de correo no está configurado.'), { status: 503 });
    const email = user.email.toLowerCase();
    const remaining = codeCooldownRemaining(email, purpose);
    if (remaining > 0) throw Object.assign(new Error('Espera un minuto antes de solicitar otro código.'), { status: 429 });
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const salt = randomBytes(16).toString('hex');
    const expiresAt = Date.now() + codeLifetimeMs;
    const store = database.transaction(() => {
      database.prepare('INSERT INTO verification_codes (user_id, purpose, code_hash, salt, expires_at, attempts) VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT(user_id, purpose) DO UPDATE SET code_hash = excluded.code_hash, salt = excluded.salt, expires_at = excluded.expires_at, attempts = 0')
        .run(user.id, purpose, hash(`${salt}.${code}`), salt, expiresAt);
      database.prepare('INSERT INTO verification_throttles (email, purpose, next_allowed_at) VALUES (?, ?, ?) ON CONFLICT(email, purpose) DO UPDATE SET next_allowed_at = excluded.next_allowed_at')
        .run(email, purpose, Date.now() + codeCooldownMs);
    });
    store();
    const subject = purpose === 'verify_email' ? 'Verifica tu correo de LOP Planificador' : 'Código para recuperar tu contraseña de LOP';
    const action = purpose === 'verify_email' ? 'verificar tu correo' : 'cambiar tu contraseña';
    try {
      await mailer.sendMail({
        from: process.env.SMTP_FROM,
        to: email,
        subject,
        text: `Tu código para ${action} es ${code}. Vence en 10 minutos. Si no solicitaste este código, ignora este mensaje.`,
      });
    } catch (error) {
      database.prepare('DELETE FROM verification_codes WHERE user_id = ? AND purpose = ?').run(user.id, purpose);
      database.prepare('DELETE FROM verification_throttles WHERE email = ? AND purpose = ?').run(email, purpose);
      console.error('No se pudo entregar el correo de acceso:', error.code || 'error SMTP');
      throw Object.assign(new Error('No se pudo enviar el correo. Revisa la configuración SMTP.'), { status: 503 });
    }
  };

  const consumeCode = (userId, purpose, suppliedCode) => {
    const record = database.prepare('SELECT code_hash, salt, expires_at, attempts FROM verification_codes WHERE user_id = ? AND purpose = ?')
      .get(userId, purpose);
    if (!record || record.expires_at <= Date.now() || record.attempts >= maxCodeAttempts) {
      database.prepare('DELETE FROM verification_codes WHERE user_id = ? AND purpose = ?').run(userId, purpose);
      return false;
    }
    const actual = Buffer.from(hash(`${record.salt}.${suppliedCode}`), 'hex');
    const expected = Buffer.from(record.code_hash, 'hex');
    const matches = actual.length === expected.length && timingSafeEqual(actual, expected);
    if (!matches) {
      database.prepare('UPDATE verification_codes SET attempts = attempts + 1 WHERE user_id = ? AND purpose = ?')
        .run(userId, purpose);
      return false;
    }
    database.prepare('DELETE FROM verification_codes WHERE user_id = ? AND purpose = ?').run(userId, purpose);
    return true;
  };

  const hashPassword = async (password) => {
    const salt = randomBytes(16);
    const derivedKey = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return `scrypt$32768$8$1$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
  };

  const verifyPassword = async (password, passwordHash) => {
    const [, cost = '32768', blockSize = '8', parallelization = '1', saltHex = '', keyHex = ''] = passwordHash.split('$');
    const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), 64, {
      N: Number(cost), r: Number(blockSize), p: Number(parallelization), maxmem: 64 * 1024 * 1024,
    });
    const expected = Buffer.from(keyHex, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };

  app.get('/api/auth/methods', (request, response) => {
    response.json({ emailDelivery: Boolean(mailer), google: Boolean(googleClient) });
  });

  app.post('/api/auth/register', async (request, response, next) => {
    const { name, email, password } = request.body || {};
    if (!mailer) return jsonError(response, 503, 'El registro requiere configurar un servicio SMTP real para verificar el correo.');
    if (!validText(name, 80) || typeof email !== 'string' || email.length > 254
      || !emailPattern.test(email.trim())
      || typeof password !== 'string' || password.length < 12 || password.length > 128) {
      return jsonError(response, 400, 'Ingresa un nombre, un correo válido y una contraseña de 12 a 128 caracteres.');
    }
    const normalizedEmail = email.trim().toLowerCase();
    try {
      const userId = randomBytes(16).toString('hex');
      const passwordHash = await hashPassword(password);
      database.prepare('INSERT INTO users (id, name, email, password_hash, email_verified) VALUES (?, ?, ?, ?, 0)')
        .run(userId, name.trim(), normalizedEmail, passwordHash);
      const user = { id: userId, name: name.trim(), email: normalizedEmail };
      try {
        await sendCode(user, 'verify_email');
      } catch (mailError) {
        database.prepare('DELETE FROM users WHERE id = ?').run(userId);
        throw mailError;
      }
      return response.status(201).json({ message: 'Enviamos un código de verificación a tu correo.' });
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return jsonError(response, 409, 'Ya existe una cuenta con ese correo.');
      if (error.status) return jsonError(response, error.status, error.message);
      return next(error);
    }
  });

  app.post('/api/auth/verification/send', async (request, response, next) => {
    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
    if (!emailPattern.test(email)) return jsonError(response, 400, 'Ingresa un correo válido.');
    const user = database.prepare('SELECT id, name, email FROM users WHERE email = ? AND email_verified = 0 COLLATE NOCASE').get(email);
    if (!user) return response.json({ message: 'Si la cuenta requiere verificación, enviaremos un código.' });
    try {
      await sendCode(user, 'verify_email');
      return response.json({ message: 'Enviamos un nuevo código de verificación.' });
    } catch (error) {
      if (error.status) return jsonError(response, error.status, error.message);
      return next(error);
    }
  });

  app.post('/api/auth/verify-email', (request, response) => {
    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
    const code = request.body?.code;
    if (!emailPattern.test(email) || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      return jsonError(response, 400, 'Ingresa el correo y el código de seis dígitos.');
    }
    const user = database.prepare('SELECT id, name, email FROM users WHERE email = ? COLLATE NOCASE').get(email);
    if (!user || !consumeCode(user.id, 'verify_email', code)) {
      return jsonError(response, 400, 'El código no es válido, venció o superó el límite de intentos.');
    }
    database.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id);
    issueSession(response, user.id);
    return response.json({ user });
  });

  app.post('/api/auth/login', async (request, response, next) => {
    const { email, password } = request.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || email.length > 254 || password.length > 128) {
      return jsonError(response, 400, 'Correo o contraseña no válidos.');
    }
    try {
      const user = database.prepare('SELECT id, name, email, password_hash, email_verified FROM users WHERE email = ? COLLATE NOCASE')
        .get(email.trim());
      const valid = user?.password_hash ? await verifyPassword(password, user.password_hash) : false;
      if (!valid) return jsonError(response, 401, 'Correo o contraseña incorrectos.');
      if (!user.email_verified) {
        await sendCode(user, 'verify_email');
        return jsonError(response, 403, 'Verifica tu correo con el código que acabamos de enviar.');
      }
      issueSession(response, user.id);
      return response.json({ user: { id: user.id, name: user.name, email: user.email } });
    } catch (error) {
      if (error.status) return jsonError(response, error.status, error.message);
      return next(error);
    }
  });

  app.post('/api/auth/password/recovery', async (request, response, next) => {
    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
    if (!emailPattern.test(email)) return jsonError(response, 400, 'Ingresa un correo válido.');
    if (!mailer) return jsonError(response, 503, 'La recuperación requiere configurar un servicio de correo real.');
    const user = database.prepare('SELECT id, name, email FROM users WHERE email = ? AND email_verified = 1 COLLATE NOCASE').get(email);
    if (!user) return response.json({ message: 'Si existe una cuenta verificada con ese correo, enviaremos un código.' });
    try {
      await sendCode(user, 'password_reset');
      return response.json({ message: 'Si existe una cuenta verificada con ese correo, enviaremos un código.' });
    } catch (error) {
      if (error.status === 429) return response.json({ message: 'Si existe una cuenta verificada con ese correo, enviaremos un código.' });
      if (error.status) return jsonError(response, error.status, error.message);
      return next(error);
    }
  });

  app.post('/api/auth/password/reset', async (request, response, next) => {
    const { email, code, password } = request.body || {};
    if (typeof email !== 'string' || !emailPattern.test(email.trim())
      || typeof code !== 'string' || !/^\d{6}$/.test(code)
      || typeof password !== 'string' || password.length < 12 || password.length > 128) {
      return jsonError(response, 400, 'Ingresa un correo válido, el código de seis dígitos y una contraseña de 12 a 128 caracteres.');
    }
    const user = database.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email.trim());
    if (!user || !consumeCode(user.id, 'password_reset', code)) {
      return jsonError(response, 400, 'El código no es válido, venció o superó el límite de intentos.');
    }
    try {
      const passwordHash = await hashPassword(password);
      database.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
      database.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      return response.json({ message: 'La contraseña se actualizó. Inicia sesión con la nueva contraseña.' });
    } catch (error) {
      return next(error);
    }
  });

  if (googleClient) {
    const beginGoogleAuth = (response, intent, userId = '', sessionTokenHash = '') => {
      const state = randomBytes(32).toString('base64url');
      const nonce = randomBytes(32).toString('base64url');
      response.cookie(googleStateCookie, `${state}.${nonce}.${intent}.${userId}.${sessionTokenHash}`, {
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookie,
        path: '/api/auth/google/callback',
        maxAge: 10 * 60 * 1000,
      });
      const authorizationUrl = googleClient.generateAuthUrl({
        access_type: 'online',
        scope: ['openid', 'email', 'profile'],
        state,
        nonce,
        prompt: 'select_account',
      });
      response.redirect(authorizationUrl);
    };

    app.get('/api/auth/google', (request, response) => beginGoogleAuth(response, 'login'));
    app.get('/api/auth/google/link', requireSession, (request, response) =>
      beginGoogleAuth(response, 'link', request.user.id, request.sessionTokenHash));

    app.get('/api/auth/google/callback', async (request, response) => {
      const stateCookie = parseCookies(request.get('cookie'))[googleStateCookie];
      response.clearCookie(googleStateCookie, {
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookie,
        path: '/api/auth/google/callback',
      });
      const [expectedState, expectedNonce, intent, linkUserId, linkSessionHash] = stateCookie?.split('.') || [];
      if (request.query.error || !request.query.code || !expectedState || !expectedNonce
        || !['login', 'link'].includes(intent) || request.query.state !== expectedState) {
        return response.redirect('/?auth=google-error');
      }
      try {
        const { tokens } = await googleClient.getToken(String(request.query.code));
        const ticket = await googleClient.verifyIdToken({ idToken: tokens.id_token, audience: googleClientId });
        const payload = ticket.getPayload();
        if (!payload?.sub || !payload.email || payload.email_verified !== true || payload.nonce !== expectedNonce) {
          return response.redirect('/?auth=google-unverified');
        }
        const email = payload.email.toLowerCase();
        const googlePicture = normalizeGooglePicture(payload.picture);
        const googleAccount = database.prepare('SELECT id, name, email FROM users WHERE google_sub = ?').get(payload.sub);

        if (intent === 'link') {
          const sessionToken = parseCookies(request.get('cookie'))[sessionCookie];
          if (!linkUserId || !linkSessionHash || !sessionToken || hash(sessionToken) !== linkSessionHash) {
            return response.redirect('/?auth=google-link-session-required');
          }
          const currentSession = database.prepare(`
            SELECT users.id, users.google_sub
            FROM sessions JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ? AND sessions.user_id = ? AND sessions.expires_at > ?
          `).get(linkSessionHash, linkUserId, Date.now());
          if (!currentSession) return response.redirect('/?auth=google-link-session-required');
          if (googleAccount && googleAccount.id !== currentSession.id) {
            return response.redirect('/?auth=google-conflict');
          }
          if (currentSession.google_sub && currentSession.google_sub !== payload.sub) {
            return response.redirect('/?auth=google-conflict');
          }
          database.prepare('UPDATE users SET google_sub = ?, google_picture = ? WHERE id = ?')
            .run(payload.sub, googlePicture, currentSession.id);
          return response.redirect('/?auth=google-linked');
        }

        if (googleAccount) {
          database.prepare('UPDATE users SET google_picture = ? WHERE id = ?').run(googlePicture, googleAccount.id);
          issueSession(response, googleAccount.id);
          return response.redirect('/');
        }

        const existingEmail = database.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email);
        if (existingEmail) return response.redirect('/?auth=google-link-required');

        {
          const id = randomBytes(16).toString('hex');
          const passwordHash = await hashPassword(randomBytes(48).toString('base64url'));
          database.prepare('INSERT INTO users (id, name, email, password_hash, email_verified, google_sub, google_picture) VALUES (?, ?, ?, ?, 1, ?, ?)')
            .run(id, payload.name?.slice(0, 80) || email, email, passwordHash, payload.sub, googlePicture);
          issueSession(response, id);
        }
        return response.redirect('/');
      } catch (error) {
        const providerError = error.response?.data?.error;
        const safeProviderErrors = new Set([
          'access_denied',
          'invalid_client',
          'invalid_grant',
          'invalid_request',
          'unauthorized_client',
        ]);
        const diagnostic = safeProviderErrors.has(providerError)
          ? providerError
          : error.response?.status ? `HTTP_${error.response.status}` : 'error OAuth';
        console.error('No se pudo completar la autenticación oficial de Google:', diagnostic);
        return response.redirect(providerError === 'invalid_client'
          ? '/?auth=google-config-error'
          : '/?auth=google-error');
      }
    });
  }

  app.post('/api/auth/logout', (request, response) => {
    const token = parseCookies(request.get('cookie'))[sessionCookie];
    let sessionFound = false;
    let revokedSessions = 0;
    if (token && token.length <= 100) {
      database.transaction(() => {
        const session = database.prepare('SELECT user_id FROM sessions WHERE token_hash = ?').get(hash(token));
        sessionFound = Boolean(session);
        if (session) {
          revokedSessions = database.prepare('DELETE FROM sessions WHERE user_id = ?').run(session.user_id).changes;
        }
      })();
    }
    response.clearCookie(sessionCookie, sessionCookieOptions);
    response.status(204).end();
    console.info('Cierre de sesión procesado:', {
      status: 204,
      sessionFound,
      revokedSessions,
      cookieExpired: true,
    });
  });

  app.get('/api/auth/session', requireSession, (request, response) => response.json({ user: request.user }));
  app.use('/api/data', requireSession);

  const ensureUserWorkspace = (userId) => {
    const ensure = database.transaction(() => {
      let workspace = database.prepare('SELECT id FROM workspaces WHERE user_id = ? ORDER BY created_at, id LIMIT 1').get(userId);
      if (!workspace) {
        const workspaceId = `workspace-${randomUUID()}`;
        database.prepare('INSERT INTO workspaces (id, user_id, name) VALUES (?, ?, ?)').run(workspaceId, userId, 'Mi espacio');
        workspace = { id: workspaceId };
      }
      let brand = database.prepare('SELECT id FROM brands WHERE workspace_id = ? ORDER BY created_at, id LIMIT 1').get(workspace.id);
      if (!brand) {
        const brandId = `brand-${randomUUID()}`;
        database.prepare('INSERT INTO brands (id, workspace_id, name) VALUES (?, ?, ?)').run(brandId, workspace.id, 'Marca principal');
        brand = { id: brandId };
      }
      database.prepare('UPDATE social_accounts SET workspace_id = ?, brand_id = COALESCE(brand_id, ?) WHERE user_id = ? AND workspace_id IS NULL')
        .run(workspace.id, brand.id, userId);
      database.prepare('UPDATE posts SET workspace_id = ?, brand_id = COALESCE(brand_id, ?) WHERE user_id = ? AND workspace_id IS NULL')
        .run(workspace.id, brand.id, userId);
      database.prepare(`
        INSERT INTO user_workspace_settings (user_id, active_workspace_id) VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET active_workspace_id =
          CASE
            WHEN user_workspace_settings.active_workspace_id IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM workspaces
                WHERE id = user_workspace_settings.active_workspace_id AND user_id = excluded.user_id
              )
            THEN excluded.active_workspace_id
            ELSE user_workspace_settings.active_workspace_id
          END
      `).run(userId, workspace.id);
    });
    ensure();
  };
  const getActiveWorkspaceId = (userId) => {
    const active = database.prepare(`
      SELECT w.id FROM user_workspace_settings s
      JOIN workspaces w ON w.id = s.active_workspace_id AND w.user_id = s.user_id
      WHERE s.user_id = ?
    `).get(userId);
    if (active) return active.id;
    const fallback = database.prepare('SELECT id FROM workspaces WHERE user_id = ? ORDER BY created_at, id LIMIT 1').get(userId);
    if (!fallback) throw new Error('No existe un espacio de trabajo para el usuario autenticado.');
    database.prepare(`
      INSERT INTO user_workspace_settings (user_id, active_workspace_id) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET active_workspace_id = excluded.active_workspace_id
    `).run(userId, fallback.id);
    return fallback.id;
  };
  const getActiveBrandId = (userId, workspaceId) => {
    const selection = database.prepare('SELECT brand_id AS brandId FROM workspace_brand_selections WHERE user_id = ? AND workspace_id = ?')
      .get(userId, workspaceId);
    if (selection) {
      return selection.brandId && database.prepare('SELECT 1 FROM brands WHERE id = ? AND workspace_id = ?').get(selection.brandId, workspaceId)
        ? selection.brandId : null;
    }
    const brandId = database.prepare('SELECT id FROM brands WHERE workspace_id = ? ORDER BY created_at, id LIMIT 1').get(workspaceId)?.id || null;
    database.prepare('INSERT INTO workspace_brand_selections (user_id, workspace_id, brand_id) VALUES (?, ?, ?)')
      .run(userId, workspaceId, brandId);
    return brandId;
  };
  const getWorkspaceList = (userId) => database.prepare(`
    SELECT id, name, created_at AS createdAt FROM workspaces
    WHERE user_id = ? ORDER BY created_at, id
  `).all(userId).map((workspace) => ({
    ...workspace,
    brands: database.prepare(`
      SELECT id, name, logo_url AS logoUrl, settings_json AS settingsJson
      FROM brands WHERE workspace_id = ? ORDER BY created_at, id
    `).all(workspace.id).map((brand) => ({
      id: brand.id,
      name: brand.name,
      logoUrl: brand.logoUrl,
    settings: normalizeBrandSettings(JSON.parse(brand.settingsJson)) || normalizeBrandSettings({}),
    })),
  }));

  app.get('/api/connections/methods', requireSession, (_request, response) => {
    response.json({
      facebook: {
        available: Boolean(facebookOAuthConfig.configured && socialTokenEncryptionKey),
        missing: [
          ...(facebookOAuthConfig.missing || []),
          ...(!socialTokenEncryptionKey ? ['SOCIAL_TOKEN_ENCRYPTION_KEY'] : []),
        ],
        requiredPermissions: facebookPagePermissions,
        optionalPermissions: ['business_management'],
      },
      instagram: {
        available: Boolean(instagramOAuthConfig.configured && socialTokenEncryptionKey),
        missing: [
          ...(instagramOAuthConfig.missing || []),
          ...(!socialTokenEncryptionKey ? ['SOCIAL_TOKEN_ENCRYPTION_KEY'] : []),
        ],
        requiredPermissions: ['instagram_basic', 'pages_show_list', 'pages_read_engagement'],
        optionalPermissions: ['business_management'],
        futurePublishingPermission: 'instagram_content_publish',
        accountRequirement: 'Cuenta profesional de Instagram (Business o Creator) vinculada a una página de Facebook administrable.',
        reason: 'OAuth separado mediante Facebook Login; verifica la cuenta profesional y permite asignarla a una marca.',
      },
      threads: { available: false, reason: 'Integración pendiente de la validación secuencial de Facebook.' },
      tiktok: {
        available: Boolean(tiktokOAuthConfig.configured && socialTokenEncryptionKey),
        missing: [...(tiktokOAuthConfig.missing || []), ...(!socialTokenEncryptionKey ? ['SOCIAL_TOKEN_ENCRYPTION_KEY'] : [])],
        requiredScopes: [...tiktokRequiredScopes],
      },
      youtube: {
        available: Boolean(youtubeOAuthConfig.configured && youtubeOAuthClient && socialTokenEncryptionKey),
        missing: [
          ...(youtubeOAuthConfig.missing || []),
          ...(!socialTokenEncryptionKey ? ['SOCIAL_TOKEN_ENCRYPTION_KEY'] : []),
        ],
        requiredScopes: [...youtubeRequiredScopes],
      },
    });
  });

  const recordFacebookOAuthEvent = ({
    userId = null,
    sessionTokenHash = null,
    eventType,
    stage,
    reason = null,
    providerCode = null,
    providerSubcode = null,
    providerType = null,
    providerMessage = null,
  }) => {
    const id = randomUUID();
    database.prepare(`
      INSERT INTO facebook_oauth_events (
        id, user_id, session_token_hash, event_type, stage, reason,
        provider_code, provider_subcode, provider_type, provider_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      userId,
      sessionTokenHash,
      eventType,
      stage,
      reason,
      providerCode,
      providerSubcode,
      typeof providerType === 'string' ? providerType.slice(0, 120) : null,
      typeof providerMessage === 'string'
        ? providerMessage
          .replace(/((?:access_token|fb_exchange_token|client_secret|appsecret_proof|code)\s*[=:]\s*)[^&\s,;]+/gi, '$1[redacted]')
          .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
          .replace(/\bEA[A-Za-z0-9]{20,}\b/g, '[redacted token]')
          .slice(0, 500)
        : null,
    );
    database.prepare(`
      DELETE FROM facebook_oauth_events WHERE created_at < datetime('now', '-30 days')
    `).run();
    return id;
  };

  const facebookGraphRequest = async (path, accessToken, parameters = {}) => {
    const url = new URL(`https://graph.facebook.com/${facebookOAuthConfig.graphVersion}/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries({ ...parameters, ...(accessToken ? { access_token: accessToken } : {}) })) {
      url.searchParams.set(key, value);
    }
    const providerResponse = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
    return readFacebookResponse(providerResponse);
  };

  const readFacebookResponse = async (providerResponse) => {
    let payload;
    try {
      payload = await providerResponse.json();
    } catch {
      throw new Error('Meta devolvió una respuesta no válida.');
    }
    if (!providerResponse.ok || payload.error) {
      const error = new Error('Meta no pudo completar la solicitud de autorización.');
      error.providerCode = String(payload.error?.code || providerResponse.status);
      error.providerSubcode = payload.error?.error_subcode == null ? null : String(payload.error.error_subcode);
      error.providerType = typeof payload.error?.type === 'string' ? payload.error.type : null;
      error.providerMessage = typeof payload.error?.error_user_msg === 'string'
        ? payload.error.error_user_msg
        : typeof payload.error?.message === 'string' ? payload.error.message : null;
      throw error;
    }
    return payload;
  };

  const getFacebookEdge = async (path, accessToken, parameters = {}) => {
    const records = [];
    const visitedUrls = new Set();
    let result = await facebookGraphRequest(path, accessToken, parameters);
    let pageCount = 0;
    while (result) {
      if (!Array.isArray(result.data)) throw new Error('Meta devolvió una lista no válida.');
      records.push(...result.data);
      const next = result.paging?.next;
      if (typeof next !== 'string' || !next) break;
      const nextUrl = new URL(next);
      if (nextUrl.protocol !== 'https:' || nextUrl.hostname !== 'graph.facebook.com'
        || nextUrl.pathname !== `/${facebookOAuthConfig.graphVersion}/${path.replace(/^\/+/, '')}`
        || nextUrl.username || nextUrl.password) {
        throw new Error('Meta devolvió un enlace de paginación no válido.');
      }
      if (visitedUrls.has(nextUrl.href)) throw new Error('Meta repitió una página del listado.');
      visitedUrls.add(nextUrl.href);
      pageCount += 1;
      if (pageCount > 1000) throw new Error('El listado de Meta excede el máximo de seguridad.');
      result = await readFacebookResponse(await fetchImpl(nextUrl, { signal: AbortSignal.timeout(15000) }));
    }
    return records;
  };

  const normalizeFacebookPage = (page) => {
    if (typeof page?.id !== 'string' || typeof page.name !== 'string' || typeof page.access_token !== 'string') return null;
    return {
      id: page.id,
      name: page.name.slice(0, 120),
      access_token: page.access_token,
      tasks: Array.isArray(page.tasks)
        ? page.tasks.filter((task) => typeof task === 'string')
        : Array.isArray(page.permitted_tasks) ? page.permitted_tasks.filter((task) => typeof task === 'string') : [],
    };
  };

  const getFacebookPageNode = async (pageId, accessToken) => {
    const page = await facebookGraphRequest(pageId, accessToken, {
      fields: 'id,name,access_token,tasks',
    });
    return normalizeFacebookPage(page);
  };

  const getFacebookPagesFromBusiness = async (accessToken, businessPermissionGranted) => {
    const pages = new Map();
    const errors = [];
    if (!businessPermissionGranted) {
      return {
        pages: [],
        errors: [{
          providerCode: null,
          providerSubcode: null,
          providerType: null,
          providerMessage: 'Meta no concedió business_management; se intentará el listado estándar /me/accounts.',
        }],
      };
    }
    try {
      const businesses = await getFacebookEdge('me/businesses', accessToken, { fields: 'id,name', limit: '100' });
      for (const business of businesses) {
        if (typeof business?.id !== 'string' || !/^\d+$/.test(business.id)) continue;
        for (const edge of ['owned_pages', 'client_pages']) {
          try {
            const businessPages = await getFacebookEdge(`${business.id}/${edge}`, accessToken, {
              fields: 'id,name,access_token,tasks',
              limit: '100',
            });
            for (const pageData of businessPages) {
              let page = normalizeFacebookPage(pageData);
              if (!page && typeof pageData?.id === 'string' && /^\d+$/.test(pageData.id)) {
                page = await getFacebookPageNode(pageData.id, accessToken);
              }
              if (page) pages.set(page.id, page);
            }
          } catch (error) {
            errors.push(error);
          }
        }
      }
    } catch (error) {
      errors.push(error);
    }
    return { pages: [...pages.values()], errors };
  };

  const getFacebookPages = async (accessToken) => {
    const pages = new Map();
    const result = await getFacebookEdge('me/accounts', accessToken, {
      fields: 'id,name,access_token,tasks',
      limit: '100',
    });
    for (const pageData of result) {
      const page = normalizeFacebookPage(pageData);
      if (page) pages.set(page.id, page);
    }
    return [...pages.values()];
  };

  app.get('/api/connections/facebook/authorize', requireSession, (request, response) => {
    if (!facebookOAuthConfig.configured) {
      return jsonError(response, 503, 'La conexión oficial de Facebook requiere configurar las credenciales de la aplicación Meta.');
    }
    if (!socialTokenEncryptionKey) {
      return jsonError(response, 503, 'Configura una clave local de cifrado antes de conectar cuentas sociales.');
    }
    const workspaceId = getActiveWorkspaceId(request.user.id);
    const brandId = request.query.brandId;
    if (!validText(brandId, 150)
      || !database.prepare('SELECT id FROM brands WHERE id = ? AND workspace_id = ?').get(brandId, workspaceId)) {
      return jsonError(response, 400, 'Selecciona una marca del espacio activo antes de conectar Facebook.');
    }
    database.prepare('DELETE FROM facebook_page_selections WHERE expires_at <= ?').run(Date.now());
    const state = randomBytes(32).toString('base64url');
    database.prepare(`
      INSERT INTO social_oauth_states
        (state_hash, user_id, session_token_hash, workspace_id, brand_id, network_id, expires_at)
      VALUES (?, ?, ?, ?, ?, 'facebook', ?)
    `).run(
      hash(state),
      request.user.id,
      request.sessionTokenHash,
      workspaceId,
      brandId,
      Date.now() + socialOAuthStateDurationMs,
    );
    const authorizationUrl = new URL(`https://www.facebook.com/${facebookOAuthConfig.graphVersion}/dialog/oauth`);
    authorizationUrl.searchParams.set('client_id', facebookOAuthConfig.appId);
    authorizationUrl.searchParams.set('redirect_uri', facebookOAuthConfig.redirectUri);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('scope', facebookPermissions.join(','));
    return response.redirect(authorizationUrl.href);
  });

  app.get('/api/connections/facebook/callback', async (request, response) => {
    const redirectError = (reason, stateRecord = null, details = {}) => {
      const eventId = recordFacebookOAuthEvent({
        userId: stateRecord?.userId || null,
        sessionTokenHash: stateRecord?.sessionTokenHash || null,
        eventType: 'error',
        stage: details.stage || 'callback',
        reason,
        providerCode: details.providerCode || null,
        providerSubcode: details.providerSubcode || null,
        providerType: details.providerType || null,
        providerMessage: details.providerMessage || null,
      });
      return response.redirect(`/?connection=facebook-error&reason=${encodeURIComponent(reason)}&event=${encodeURIComponent(eventId)}`);
    };
    const returnedState = typeof request.query.state === 'string' ? request.query.state : '';
    const stateRecord = returnedState ? database.prepare(`
      SELECT state_hash AS stateHash, user_id AS userId, session_token_hash AS sessionTokenHash,
        workspace_id AS workspaceId, brand_id AS brandId, expires_at AS expiresAt
      FROM social_oauth_states
      WHERE state_hash = ? AND network_id = 'facebook'
    `).get(hash(returnedState)) : null;
    if (stateRecord) database.prepare('DELETE FROM social_oauth_states WHERE state_hash = ?').run(stateRecord.stateHash);
    if (!stateRecord) return redirectError(request.query.error === 'access_denied' ? 'cancelled' : 'invalid-state');
    if (stateRecord.expiresAt <= Date.now()) {
      return redirectError('state-expired', stateRecord, { stage: 'state-validation' });
    }
    if (typeof request.query.code !== 'string' || request.query.error) {
      const reason = request.query.error === 'access_denied' ? 'cancelled' : 'provider-error';
      return redirectError(reason, stateRecord, { stage: 'facebook-consent' });
    }
    const sessionToken = parseCookies(request.get('cookie'))[sessionCookie];
    if (!sessionToken || hash(sessionToken) !== stateRecord.sessionTokenHash
      || !database.prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?')
        .get(stateRecord.sessionTokenHash, stateRecord.userId, Date.now())) {
      return redirectError('session-expired', stateRecord, { stage: 'session-validation' });
    }
    if (!facebookOAuthConfig.configured || !socialTokenEncryptionKey) {
      return redirectError('not-configured', stateRecord, { stage: 'local-configuration' });
    }

    let stage = 'code-exchange';
    try {
      const authorizationCode = request.query.code;
      const codeParams = new URLSearchParams({
        client_id: facebookOAuthConfig.appId,
        client_secret: facebookOAuthConfig.appSecret,
        redirect_uri: facebookOAuthConfig.redirectUri,
        code: authorizationCode,
      });
      const shortLived = await facebookGraphRequest('oauth/access_token', '', Object.fromEntries(codeParams));
      if (typeof shortLived.access_token !== 'string') throw new Error('Meta no devolvió un token de acceso.');
      stage = 'long-lived-token-exchange';
      const extended = await facebookGraphRequest('oauth/access_token', '', {
        client_id: facebookOAuthConfig.appId,
        client_secret: facebookOAuthConfig.appSecret,
        grant_type: 'fb_exchange_token',
        fb_exchange_token: shortLived.access_token,
      });
      const userAccessToken = extended.access_token;
      if (typeof userAccessToken !== 'string') throw new Error('Meta no devolvió el token de larga duración.');
      stage = 'permission-verification';
      const permissions = await facebookGraphRequest('me/permissions', userAccessToken);
      const grantedScopes = (Array.isArray(permissions.data) ? permissions.data : [])
        .filter((permission) => permission.status === 'granted')
        .map((permission) => permission.permission);
      if (facebookPagePermissions.some((permission) => !grantedScopes.includes(permission))) {
        return redirectError('permissions-missing', stateRecord, {
          stage,
          providerMessage: `Permisos de páginas faltantes: ${facebookPagePermissions.filter((permission) => !grantedScopes.includes(permission)).join(', ')}`,
        });
      }
      stage = 'identity-lookup';
      const identity = await facebookGraphRequest('me', userAccessToken, { fields: 'id,name' });
      if (typeof identity.id !== 'string') throw new Error('Meta no devolvió una identidad de usuario válida.');
      stage = 'page-discovery';
      const businessDiscovery = await getFacebookPagesFromBusiness(
        userAccessToken,
        grantedScopes.includes('business_management'),
      );
      let availablePages = businessDiscovery.pages;
      let discoveryMethod = availablePages.length ? 'business-manager' : 'me/accounts';
      let fallbackError = null;
      if (!availablePages.length) {
        try {
          availablePages = await getFacebookPages(userAccessToken);
        } catch (error) {
          fallbackError = error;
        }
      }
      if (!availablePages.length) {
        const metaError = fallbackError || businessDiscovery.errors[0] || null;
        const businessDetail = businessDiscovery.errors[0]
          ? `Business Manager: ${businessDiscovery.errors[0].providerMessage || businessDiscovery.errors[0].message}`
          : !grantedScopes.includes('business_management')
            ? 'Business Manager no pudo consultarse porque no se concedió business_management.'
            : 'Business Manager no devolvió páginas con tokens utilizables.';
        const fallbackDetail = fallbackError
          ? `/me/accounts falló: ${fallbackError.providerMessage || fallbackError.message}`
          : '/me/accounts tampoco devolvió páginas con tokens utilizables.';
        return redirectError(fallbackError ? 'provider-error' : 'no-manageable-pages', stateRecord, {
          stage,
          providerCode: metaError?.providerCode,
          providerSubcode: metaError?.providerSubcode,
          providerType: metaError?.providerType,
          providerMessage: `${businessDetail} ${fallbackDetail}`,
        });
      }
      const discoveryEventId = recordFacebookOAuthEvent({
        userId: stateRecord.userId,
        sessionTokenHash: stateRecord.sessionTokenHash,
        eventType: 'pages-discovered',
        stage,
        reason: `${discoveryMethod}:${availablePages.length}`,
        providerCode: businessDiscovery.errors[0]?.providerCode,
        providerSubcode: businessDiscovery.errors[0]?.providerSubcode,
        providerType: businessDiscovery.errors[0]?.providerType,
        providerMessage: businessDiscovery.errors[0]
          ? `Business Manager: ${businessDiscovery.errors[0].providerMessage || businessDiscovery.errors[0].message} Páginas recuperadas mediante ${discoveryMethod}.`
          : null,
      });

      stage = 'selection-persistence';
      const selectionId = randomUUID();
      const pagesEncrypted = encryptSocialToken(
        JSON.stringify(availablePages),
        socialTokenEncryptionKey,
        `facebook-pages:${stateRecord.userId}:${stateRecord.sessionTokenHash}:${selectionId}`,
      );
      database.prepare(`
        INSERT INTO facebook_page_selections (
          id, user_id, session_token_hash, provider_user_id, workspace_id, brand_id,
          granted_scopes_json, pages_encrypted, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        selectionId,
        stateRecord.userId,
        stateRecord.sessionTokenHash,
        identity.id,
        stateRecord.workspaceId,
        stateRecord.brandId,
        JSON.stringify(grantedScopes),
        pagesEncrypted,
        Date.now() + facebookPageSelectionDurationMs,
      );
      recordFacebookOAuthEvent({
        userId: stateRecord.userId,
        sessionTokenHash: stateRecord.sessionTokenHash,
        eventType: 'pages-ready',
        stage,
      });
      return response.redirect(`/?connection=facebook-select&selection=${encodeURIComponent(selectionId)}&event=${encodeURIComponent(discoveryEventId)}`);
    } catch (error) {
      console.error('No se pudo completar la conexión oficial de Facebook:', {
        stage,
        providerCode: error.providerCode || null,
        providerSubcode: error.providerSubcode || null,
        providerType: error.providerType || null,
      });
      return redirectError('provider-error', stateRecord, {
        stage,
        providerCode: error.providerCode,
        providerSubcode: error.providerSubcode,
        providerType: error.providerType,
        providerMessage: error.providerMessage || error.message,
      });
    }
  });

  registerYouTubeRoutes({
    app, database, config: youtubeOAuthConfig, oauthClient: youtubeOAuthClient,
    encryptionKey: socialTokenEncryptionKey, encryptToken: encryptSocialToken, decryptToken: decryptSocialToken,
    requireSession, getActiveWorkspaceId, parseCookies, fetchImpl,
  });

  const getFacebookPageSelection = (request, selectionId) => database.prepare(`
    SELECT id, user_id AS userId, session_token_hash AS sessionTokenHash,
      provider_user_id AS providerUserId, workspace_id AS workspaceId, brand_id AS brandId,
      granted_scopes_json AS grantedScopes, pages_encrypted AS pagesEncrypted, expires_at AS expiresAt
    FROM facebook_page_selections
    WHERE id = ? AND user_id = ? AND session_token_hash = ?
  `).get(selectionId, request.user.id, request.sessionTokenHash);

  const decryptFacebookSelectionPages = (selection) => {
    const pages = JSON.parse(decryptSocialToken(
      selection.pagesEncrypted,
      socialTokenEncryptionKey,
      `facebook-pages:${selection.userId}:${selection.sessionTokenHash}:${selection.id}`,
    ));
    if (!Array.isArray(pages)) throw new Error('La lista de páginas cifrada no tiene el formato esperado.');
    return pages;
  };

  app.get('/api/connections/facebook/page-selections/pending', requireSession, (request, response) => {
    if (!socialTokenEncryptionKey) return jsonError(response, 503, 'La clave local de cifrado ya no está disponible.');
    const selections = database.prepare(`
      SELECT id, user_id AS userId, session_token_hash AS sessionTokenHash,
        provider_user_id AS providerUserId, workspace_id AS workspaceId, brand_id AS brandId,
        granted_scopes_json AS grantedScopes, pages_encrypted AS pagesEncrypted, expires_at AS expiresAt
      FROM facebook_page_selections
      WHERE user_id = ? AND session_token_hash = ? AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT 5
    `).all(request.user.id, request.sessionTokenHash, Date.now());
    try {
      const pending = selections.map((selection) => ({
        id: selection.id,
        workspaceId: selection.workspaceId,
        brandId: selection.brandId,
        grantedScopes: JSON.parse(selection.grantedScopes),
        expiresAt: selection.expiresAt,
        pages: decryptFacebookSelectionPages(selection)
          .map(({ id, name, tasks }) => ({ id, name, tasks })),
      }));
      response.json({ pending });
    } catch (error) {
      console.error('No se pudo recuperar una selección pendiente de páginas Facebook:', error.message);
      return jsonError(response, 500, 'No se pudo recuperar de forma segura la selección de páginas.');
    }
  });

  app.get('/api/connections/facebook/page-selections/:selectionId', requireSession, (request, response) => {
    const selection = getFacebookPageSelection(request, request.params.selectionId);
    if (!selection) return jsonError(response, 404, 'La selección de páginas venció o no pertenece a esta sesión.');
    if (selection.expiresAt <= Date.now()) return jsonError(response, 410, 'La selección temporal venció. Vuelve a autorizar Facebook para cargar las páginas.');
    try {
      response.json({
        selection: {
          id: selection.id,
          workspaceId: selection.workspaceId,
          brandId: selection.brandId,
          grantedScopes: JSON.parse(selection.grantedScopes),
          expiresAt: selection.expiresAt,
          pages: decryptFacebookSelectionPages(selection)
            .map(({ id, name, tasks }) => ({ id, name, tasks })),
        },
      });
    } catch (error) {
      console.error('No se pudo descifrar la selección temporal de páginas de Facebook:', error.message);
      return jsonError(response, 500, 'No se pudo recuperar de forma segura la selección de páginas.');
    }
  });

  app.post('/api/connections/facebook/page-selections/:selectionId', requireSession, async (request, response) => {
    const selection = getFacebookPageSelection(request, request.params.selectionId);
    if (!selection) return jsonError(response, 404, 'La selección de páginas venció o no pertenece a esta sesión.');
    if (selection.expiresAt <= Date.now()) return jsonError(response, 410, 'La selección temporal venció. Vuelve a autorizar Facebook.');
    if (!socialTokenEncryptionKey) return jsonError(response, 503, 'La clave local de cifrado ya no está disponible.');
    if (!Array.isArray(request.body?.pages) || request.body.pages.length < 1 || request.body.pages.length > 1000) {
      return jsonError(response, 400, 'Selecciona al menos una página y no más de 1000 por operación.');
    }

    let pages;
    try {
      pages = decryptFacebookSelectionPages(selection);
    } catch (error) {
      console.error('No se pudo descifrar la selección temporal de Facebook antes de guardarla:', error.message);
      return jsonError(response, 500, 'No se pudo recuperar de forma segura la selección de páginas.');
    }
    if (!Array.isArray(pages)) return jsonError(response, 500, 'La lista temporal de páginas de Facebook no es válida.');

    const availablePages = new Map(pages.map((page) => [page.id, page]));
    const selectedPages = [];
    const selectedIds = new Set();
    for (const item of request.body.pages) {
      if (!validText(item?.providerAccountId, 256) || selectedIds.has(item.providerAccountId)) {
        return jsonError(response, 400, 'La selección contiene una página inválida o duplicada.');
      }
      const page = availablePages.get(item.providerAccountId);
      if (!page || !validText(item.workspaceId, 150) || !validText(item.brandId, 150)
        || !database.prepare('SELECT id FROM workspaces WHERE id = ? AND user_id = ?').get(item.workspaceId, request.user.id)
        || !database.prepare('SELECT id FROM brands WHERE id = ? AND workspace_id = ?').get(item.brandId, item.workspaceId)) {
        return jsonError(response, 400, 'Cada página debe pertenecer a la autorización y asignarse a una marca propia.');
      }
      selectedIds.add(item.providerAccountId);
      selectedPages.push({ page, workspaceId: item.workspaceId, brandId: item.brandId });
    }

    try {
      for (const selected of selectedPages) selected.verified = await verifyFacebookPage(selected.page.access_token, selected.page.id);
    } catch (error) {
      return jsonError(response, error.reason === 'api-blocked' ? 503 : 422, error.reason === 'api-blocked'
        ? 'Meta bloqueó el acceso de la aplicación. Revisa sus avisos en Meta antes de volver a autorizar; las conexiones existentes se conservaron.'
        : 'Meta no confirmó la identidad y los permisos de las páginas seleccionadas. No se modificó ninguna conexión.');
    }
    if (!database.prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?').get(request.sessionTokenHash, request.user.id, Date.now())) return jsonError(response, 401, 'La sesión venció durante la comprobación.');
    if (selection.expiresAt <= Date.now() || !getFacebookPageSelection(request, selection.id)) return jsonError(response, 410, 'La selección temporal venció.');
    if (selectedPages.some(({ workspaceId, brandId }) => !database.prepare('SELECT 1 FROM brands b JOIN workspaces w ON w.id = b.workspace_id WHERE b.id = ? AND w.id = ? AND w.user_id = ?').get(brandId, workspaceId, request.user.id))) return jsonError(response, 409, 'Las marcas cambiaron durante la comprobación.');
    const saveSelectedPages = database.transaction(() => {
      for (const { page, workspaceId, brandId, verified } of selectedPages) {
        const existing = database.prepare(`
          SELECT id, account_id AS accountId FROM social_connections
          WHERE user_id = ? AND network_id = 'facebook' AND provider_account_id = ?
        `).get(request.user.id, page.id);
        const accountId = existing?.accountId || `social-${randomUUID()}`;
        database.prepare(`
          INSERT INTO social_accounts
            (id, user_id, name, network_id, status, preference_enabled, workspace_id, brand_id)
          VALUES (?, ?, ?, 'facebook', 'demo', 1, ?, ?)
          ON CONFLICT(user_id, id) DO UPDATE SET
            name = excluded.name, workspace_id = excluded.workspace_id, brand_id = excluded.brand_id
        `).run(accountId, request.user.id, page.name, workspaceId, brandId);
        const encryptedToken = encryptSocialToken(
          page.access_token,
          socialTokenEncryptionKey,
          `${request.user.id}:facebook:${accountId}`,
        );
        database.prepare(`
          INSERT INTO social_connections (
            id, user_id, account_id, workspace_id, brand_id, network_id, provider_account_id,
            provider_user_id, status, access_token_encrypted, expires_at, granted_scopes_json
          ) VALUES (?, ?, ?, ?, ?, 'facebook', ?, ?, 'connected', ?, ?, ?)
          ON CONFLICT(user_id, network_id, provider_account_id) DO UPDATE SET
            workspace_id = excluded.workspace_id, brand_id = excluded.brand_id,
            account_id = excluded.account_id, provider_user_id = excluded.provider_user_id,
            status = 'connected', access_token_encrypted = excluded.access_token_encrypted,
            expires_at = excluded.expires_at, granted_scopes_json = excluded.granted_scopes_json,
            updated_at = CURRENT_TIMESTAMP
        `).run(
          existing?.id || `connection-${randomUUID()}`,
          request.user.id,
          accountId,
          workspaceId,
          brandId,
          page.id,
          selection.providerUserId,
          encryptedToken,
          verified.expiresAt,
          JSON.stringify(verified.scopes),
        );
        database.prepare('UPDATE social_connections SET verified_at = ?, last_error_code = NULL WHERE user_id = ? AND network_id = ? AND provider_account_id = ?')
          .run(verified.verifiedAt, request.user.id, 'facebook', page.id);
      }
      database.prepare('DELETE FROM facebook_page_selections WHERE id = ? AND user_id = ?')
        .run(selection.id, request.user.id);
    });
    saveSelectedPages();
    recordFacebookOAuthEvent({
      userId: request.user.id,
      sessionTokenHash: request.sessionTokenHash,
      eventType: 'pages-saved',
      stage: 'page-selection',
      reason: String(selectedPages.length),
    });
    response.status(201).json({ connectedCount: selectedPages.length });
  });

  app.delete('/api/connections/facebook/page-selections/:selectionId', requireSession, (request, response) => {
    const deleted = database.prepare(`
      DELETE FROM facebook_page_selections
      WHERE id = ? AND user_id = ? AND session_token_hash = ?
    `).run(request.params.selectionId, request.user.id, request.sessionTokenHash);
    if (!deleted.changes) return jsonError(response, 404, 'La selección de páginas ya venció o no existe.');
    recordFacebookOAuthEvent({
      userId: request.user.id,
      sessionTokenHash: request.sessionTokenHash,
      eventType: 'selection-cancelled',
      stage: 'page-selection',
    });
    response.status(204).end();
  });

  app.get('/api/connections/facebook/oauth-events/:eventId', requireSession, (request, response) => {
    const event = database.prepare(`
      SELECT id, event_type AS eventType, stage, reason,
        provider_code AS providerCode, provider_subcode AS providerSubcode,
        provider_type AS providerType, provider_message AS providerMessage,
        created_at AS createdAt
      FROM facebook_oauth_events
      WHERE id = ? AND user_id = ? AND session_token_hash = ?
    `).get(request.params.eventId, request.user.id, request.sessionTokenHash);
    if (!event) return jsonError(response, 404, 'No se encontró el detalle de ese retorno OAuth en esta sesión.');
    response.json({ event });
  });

  const verifyFacebookPage = createFacebookVerifier({ config: facebookOAuthConfig, fetchImpl });
  registerFacebookVerification({ app, database, config: facebookOAuthConfig, encryptionKey: socialTokenEncryptionKey,
    decryptToken: decryptSocialToken, requireSession, getActiveWorkspaceId, verifyPage: verifyFacebookPage });

  registerTikTokRoutes({ app, database, config: tiktokOAuthConfig, encryptionKey: socialTokenEncryptionKey,
    encryptToken: encryptSocialToken, decryptToken: decryptSocialToken,
    requireSession, getActiveWorkspaceId, parseCookies, fetchImpl });

  registerInstagramRoutes({
    app, database, config: instagramOAuthConfig, encryptionKey: socialTokenEncryptionKey,
    encryptToken: encryptSocialToken, decryptToken: decryptSocialToken,
    requireSession, getActiveWorkspaceId, fetchImpl,
  });

  const getInstagramConnections = (userId, workspaceId) => database.prepare(`
    SELECT c.id, c.account_id AS accountId, 'instagram' AS networkId,
      c.provider_account_id AS providerAccountId, c.status, c.expires_at AS expiresAt,
      c.granted_scopes_json AS grantedScopes, c.verified_at AS verifiedAt,
      c.page_id AS pageId, c.page_name AS pageName, c.username,
      a.name, c.workspace_id AS workspaceId, c.brand_id AS brandId
    FROM instagram_connections c
    JOIN social_accounts a ON a.user_id = c.user_id AND a.id = c.account_id
    WHERE c.user_id = ? AND c.workspace_id = ?
    ORDER BY a.name, c.id
  `).all(userId, workspaceId).map((connection) => ({
    ...connection,
    status: connection.expiresAt && connection.expiresAt <= Date.now() ? 'expired' : connection.status,
    grantedScopes: JSON.parse(connection.grantedScopes),
  }));

  app.get('/api/connections', requireSession, (request, response) => {
    ensureUserWorkspace(request.user.id);
    const workspaceId = getActiveWorkspaceId(request.user.id);
    const facebookConnections = database.prepare(`
      SELECT c.id, c.account_id AS accountId, c.network_id AS networkId,
        c.provider_account_id AS providerAccountId, c.status,
        c.expires_at AS expiresAt, c.granted_scopes_json AS grantedScopes,
        a.name, a.brand_id AS brandId
      FROM social_connections c
      JOIN social_accounts a ON a.user_id = c.user_id AND a.id = c.account_id
      WHERE c.user_id = ? AND c.workspace_id = ?
      ORDER BY a.name, c.id
    `).all(request.user.id, workspaceId).map((connection) => ({
      ...connection,
      status: connection.expiresAt && connection.expiresAt <= Date.now() ? 'expired' : connection.status,
      grantedScopes: JSON.parse(connection.grantedScopes),
    }));
    const youtubeConnections = database.prepare(`
      SELECT c.id, c.account_id AS accountId, 'youtube' AS networkId,
        c.provider_channel_id AS providerAccountId, c.status,
        c.granted_scopes_json AS grantedScopes, c.custom_url AS customUrl,
        c.verified_at AS verifiedAt, a.name, a.brand_id AS brandId
      FROM youtube_connections c
      JOIN social_accounts a ON a.user_id = c.user_id AND a.id = c.account_id
      WHERE c.user_id = ? AND c.workspace_id = ?
      ORDER BY a.name, c.id
    `).all(request.user.id, workspaceId).map((connection) => ({
      ...connection,
      grantedScopes: JSON.parse(connection.grantedScopes),
    }));
    const connections = [...facebookConnections, ...youtubeConnections, ...getInstagramConnections(request.user.id, workspaceId), ...getTikTokConnections(database, request.user.id, workspaceId)];
    response.json({ connections });
  });

  app.get('/api/connections/summary', requireSession, (request, response) => {
    ensureUserWorkspace(request.user.id);
    const workspaceId = request.query.workspaceId || getActiveWorkspaceId(request.user.id);
    if (!validText(workspaceId, 150)
      || !database.prepare('SELECT id FROM workspaces WHERE id = ? AND user_id = ?').get(workspaceId, request.user.id)) {
      return jsonError(response, 404, 'No se encontró el espacio solicitado.');
    }
    const brandId = request.query.brandId || null;
    if (brandId !== null && (!validText(brandId, 150)
      || !database.prepare('SELECT id FROM brands WHERE id = ? AND workspace_id = ?').get(brandId, workspaceId))) {
      return jsonError(response, 404, 'No se encontró la marca solicitada en este espacio.');
    }
    const registeredAccounts = database.prepare(`
      SELECT COUNT(*) AS count
      FROM social_accounts
      WHERE user_id = ? AND workspace_id = ? AND (? IS NULL OR brand_id = ?)
    `).get(request.user.id, workspaceId, brandId, brandId).count;
    const facebookConnections = database.prepare(`
      SELECT COUNT(*) AS count
      FROM social_connections c
      JOIN social_accounts a
        ON a.user_id = c.user_id AND a.id = c.account_id
        AND a.workspace_id = c.workspace_id AND a.brand_id = c.brand_id
      WHERE c.user_id = ? AND c.workspace_id = ?
        AND (? IS NULL OR c.brand_id = ?)
        AND c.status = 'connected'
        AND c.last_error_code IS NULL
        AND (c.expires_at IS NULL OR c.expires_at > ?)
    `).get(request.user.id, workspaceId, brandId, brandId, Date.now()).count;
    const youtubeConnections = database.prepare(`
      SELECT COUNT(*) AS count
      FROM youtube_connections c
      JOIN social_accounts a
        ON a.user_id = c.user_id AND a.id = c.account_id
        AND a.workspace_id = c.workspace_id AND a.brand_id = c.brand_id
      WHERE c.user_id = ? AND c.workspace_id = ?
        AND (? IS NULL OR c.brand_id = ?)
        AND c.status = 'connected'
    `).get(request.user.id, workspaceId, brandId, brandId).count;
    const instagramConnections = database.prepare(`
      SELECT COUNT(*) AS count FROM instagram_connections c
      JOIN social_accounts a ON a.user_id = c.user_id AND a.id = c.account_id
        AND a.workspace_id = c.workspace_id AND a.brand_id = c.brand_id
      WHERE c.user_id = ? AND c.workspace_id = ? AND (? IS NULL OR c.brand_id = ?)
        AND c.status = 'connected' AND (c.expires_at IS NULL OR c.expires_at > ?)
    `).get(request.user.id, workspaceId, brandId, brandId, Date.now()).count;
    const tiktokConnections = database.prepare(`SELECT COUNT(*) AS count FROM tiktok_connections c
      JOIN social_accounts a ON a.user_id = c.user_id AND a.id = c.account_id AND a.workspace_id = c.workspace_id AND a.brand_id = c.brand_id
      WHERE c.user_id = ? AND c.workspace_id = ? AND (? IS NULL OR c.brand_id = ?)
        AND c.status = 'connected' AND c.expires_at > ?`).get(request.user.id, workspaceId, brandId, brandId, Date.now()).count;
    response.json({ workspaceId, brandId, registeredAccounts,
      officialConnections: facebookConnections + youtubeConnections + instagramConnections + tiktokConnections });
  });

  app.patch('/api/connections/:connectionId', requireSession, (request, response) => {
    const { workspaceId, brandId } = request.body || {};
    if (!validText(workspaceId, 150) || !validText(brandId, 150)
      || !database.prepare('SELECT id FROM workspaces WHERE id = ? AND user_id = ?').get(workspaceId, request.user.id)
      || !database.prepare('SELECT id FROM brands WHERE id = ? AND workspace_id = ?').get(brandId, workspaceId)) {
      return jsonError(response, 400, 'Selecciona un espacio y una marca que pertenezcan a tu cuenta.');
    }
    const connection = database.prepare(`
      SELECT account_id AS accountId FROM social_connections WHERE id = ? AND user_id = ?
    `).get(request.params.connectionId, request.user.id);
    const youtubeConnection = connection ? null : database.prepare(`
      SELECT account_id AS accountId FROM youtube_connections WHERE id = ? AND user_id = ?
    `).get(request.params.connectionId, request.user.id);
    const instagramConnection = connection || youtubeConnection ? null : database.prepare(`
      SELECT account_id AS accountId FROM instagram_connections WHERE id = ? AND user_id = ?
    `).get(request.params.connectionId, request.user.id);
    const tiktokConnection = connection || youtubeConnection || instagramConnection ? null : database.prepare(
      'SELECT account_id AS accountId FROM tiktok_connections WHERE id = ? AND user_id = ?',
    ).get(request.params.connectionId, request.user.id);
    const target = connection || youtubeConnection || instagramConnection || tiktokConnection;
    if (!target) return jsonError(response, 404, 'No se encontró la conexión solicitada.');
    database.transaction(() => {
      if (connection) {
        database.prepare(`
          UPDATE social_connections SET workspace_id = ?, brand_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND user_id = ?
        `).run(workspaceId, brandId, request.params.connectionId, request.user.id);
      } else if (youtubeConnection) {
        database.prepare(`
          UPDATE youtube_connections SET workspace_id = ?, brand_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND user_id = ?
        `).run(workspaceId, brandId, request.params.connectionId, request.user.id);
      } else if (tiktokConnection) {
        database.prepare('UPDATE tiktok_connections SET workspace_id = ?, brand_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
          .run(workspaceId, brandId, request.params.connectionId, request.user.id);
      } else {
        database.prepare(`
          UPDATE instagram_connections SET workspace_id = ?, brand_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND user_id = ?
        `).run(workspaceId, brandId, request.params.connectionId, request.user.id);
      }
      database.prepare('UPDATE social_accounts SET workspace_id = ?, brand_id = ? WHERE id = ? AND user_id = ?')
        .run(workspaceId, brandId, target.accountId, request.user.id);
    })();
    response.status(204).end();
  });

  app.delete('/api/connections/:connectionId', requireSession, (request, response) => {
    const connection = database.prepare(`
      SELECT account_id AS accountId FROM social_connections WHERE id = ? AND user_id = ? AND workspace_id = ?
    `).get(request.params.connectionId, request.user.id, getActiveWorkspaceId(request.user.id));
    const youtubeConnection = connection ? null : database.prepare(`
      SELECT account_id AS accountId FROM youtube_connections WHERE id = ? AND user_id = ? AND workspace_id = ?
    `).get(request.params.connectionId, request.user.id, getActiveWorkspaceId(request.user.id));
    const instagramConnection = connection || youtubeConnection ? null : database.prepare(`
      SELECT account_id AS accountId FROM instagram_connections WHERE id = ? AND user_id = ? AND workspace_id = ?
    `).get(request.params.connectionId, request.user.id, getActiveWorkspaceId(request.user.id));
    const tiktokConnection = connection || youtubeConnection || instagramConnection ? null : database.prepare(
      'SELECT account_id AS accountId FROM tiktok_connections WHERE id = ? AND user_id = ? AND workspace_id = ?',
    ).get(request.params.connectionId, request.user.id, getActiveWorkspaceId(request.user.id));
    const target = connection || youtubeConnection || instagramConnection || tiktokConnection;
    if (!target) return jsonError(response, 404, 'No se encontró la conexión del espacio activo.');
    database.prepare('DELETE FROM social_accounts WHERE id = ? AND user_id = ?')
      .run(target.accountId, request.user.id);
    response.status(204).end();
  });

  app.get('/api/workspaces', requireSession, (request, response) => {
    ensureUserWorkspace(request.user.id);
    response.json({
      workspaces: getWorkspaceList(request.user.id),
      activeWorkspaceId: getActiveWorkspaceId(request.user.id),
      activeBrandId: getActiveBrandId(request.user.id, getActiveWorkspaceId(request.user.id)),
    });
  });

  app.post('/api/workspaces', requireSession, (request, response) => {
    const { name } = request.body || {};
    if (!validText(name, 100)) return jsonError(response, 400, 'El nombre del espacio es obligatorio y debe tener 100 caracteres como máximo.');
    const workspaceId = `workspace-${randomUUID()}`;
    const brandId = `brand-${randomUUID()}`;
    database.transaction(() => {
      database.prepare('INSERT INTO workspaces (id, user_id, name) VALUES (?, ?, ?)').run(workspaceId, request.user.id, name.trim());
      database.prepare('INSERT INTO brands (id, workspace_id, name) VALUES (?, ?, ?)').run(brandId, workspaceId, 'Marca principal');
      database.prepare(`
        INSERT INTO user_workspace_settings (user_id, active_workspace_id) VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET active_workspace_id = excluded.active_workspace_id
      `).run(request.user.id, workspaceId);
    })();
    response.status(201).json({
      workspaces: getWorkspaceList(request.user.id),
      activeWorkspaceId: workspaceId,
    });
  });

  app.put('/api/workspaces/active', requireSession, (request, response) => {
    const { workspaceId } = request.body || {};
    if (!validText(workspaceId, 150)) return jsonError(response, 400, 'Selecciona un espacio de trabajo válido.');
    const workspace = database.prepare('SELECT id FROM workspaces WHERE id = ? AND user_id = ?').get(workspaceId, request.user.id);
    if (!workspace) return jsonError(response, 404, 'No se encontró el espacio solicitado.');
    database.prepare(`
      INSERT INTO user_workspace_settings (user_id, active_workspace_id) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET active_workspace_id = excluded.active_workspace_id
    `).run(request.user.id, workspace.id);
    response.json({ activeWorkspaceId: workspace.id, activeBrandId: getActiveBrandId(request.user.id, workspace.id) });
  });

  app.put('/api/workspaces/:workspaceId/active-brand', requireSession, (request, response) => {
    const workspaceId = request.params.workspaceId;
    if (!database.prepare('SELECT 1 FROM workspaces WHERE id = ? AND user_id = ?').get(workspaceId, request.user.id)) {
      return jsonError(response, 404, 'No se encontró el espacio solicitado.');
    }
    const brandId = request.body?.brandId;
    if (brandId !== null && (!validText(brandId, 150)
      || !database.prepare('SELECT 1 FROM brands WHERE id = ? AND workspace_id = ?').get(brandId, workspaceId))) {
      return jsonError(response, 400, 'Selecciona una marca de este espacio o ninguna marca.');
    }
    database.prepare(`INSERT INTO workspace_brand_selections (user_id, workspace_id, brand_id) VALUES (?, ?, ?)
      ON CONFLICT(user_id, workspace_id) DO UPDATE SET brand_id = excluded.brand_id`)
      .run(request.user.id, workspaceId, brandId);
    response.json({ workspaceId, activeBrandId: brandId });
  });

  app.patch('/api/workspaces/:workspaceId', requireSession, (request, response) => {
    const { name } = request.body || {};
    if (!validText(name, 100)) return jsonError(response, 400, 'El nombre del espacio es obligatorio y debe tener 100 caracteres como máximo.');
    const result = database.prepare('UPDATE workspaces SET name = ? WHERE id = ? AND user_id = ?')
      .run(name.trim(), request.params.workspaceId, request.user.id);
    if (!result.changes) return jsonError(response, 404, 'No se encontró el espacio solicitado.');
    response.json({ workspaces: getWorkspaceList(request.user.id), activeWorkspaceId: getActiveWorkspaceId(request.user.id) });
  });

  app.delete('/api/workspaces/:workspaceId', requireSession, (request, response) => {
    const workspaces = database.prepare('SELECT id FROM workspaces WHERE user_id = ? ORDER BY created_at, id').all(request.user.id);
    const workspace = workspaces.find(({ id }) => id === request.params.workspaceId);
    if (!workspace) return jsonError(response, 404, 'No se encontró el espacio solicitado.');
    if (workspaces.length === 1) return jsonError(response, 409, 'Conserva al menos un espacio de trabajo.');
    const activeWorkspaceId = getActiveWorkspaceId(request.user.id);
    const nextWorkspaceId = activeWorkspaceId === workspace.id
      ? workspaces.find(({ id }) => id !== workspace.id).id
      : activeWorkspaceId;
    database.transaction(() => {
      database.prepare('DELETE FROM workspaces WHERE id = ? AND user_id = ?').run(workspace.id, request.user.id);
      database.prepare('UPDATE user_workspace_settings SET active_workspace_id = ? WHERE user_id = ?')
        .run(nextWorkspaceId, request.user.id);
    })();
    response.json({ workspaces: getWorkspaceList(request.user.id), activeWorkspaceId: nextWorkspaceId });
  });

  app.post('/api/workspaces/:workspaceId/brands', requireSession, (request, response) => {
    const { name, logoUrl = null, settings = {} } = request.body || {};
    if (!database.prepare('SELECT id FROM workspaces WHERE id = ? AND user_id = ?').get(request.params.workspaceId, request.user.id)) {
      return jsonError(response, 404, 'No se encontró el espacio solicitado.');
    }
    const normalizedLogoUrl = normalizeLogoUrl(logoUrl);
    const normalizedSettings = normalizeBrandSettings(settings);
    if (!validText(name, 100) || normalizedLogoUrl === undefined || normalizedSettings === null) {
      return jsonError(response, 400, 'Revisa el nombre, el logotipo HTTPS y la configuración de la marca.');
    }
    const brand = {
      id: `brand-${randomUUID()}`,
      name: name.trim(),
      logoUrl: normalizedLogoUrl,
      settings: normalizedSettings,
    };
    database.prepare('INSERT INTO brands (id, workspace_id, name, logo_url, settings_json) VALUES (?, ?, ?, ?, ?)')
      .run(brand.id, request.params.workspaceId, brand.name, brand.logoUrl, JSON.stringify(brand.settings));
    response.status(201).json(brand);
  });

  app.patch('/api/brands/:brandId', requireSession, (request, response) => {
    const current = database.prepare(`
      SELECT b.id, b.name, b.logo_url AS logoUrl, b.settings_json AS settingsJson
      FROM brands b JOIN workspaces w ON w.id = b.workspace_id
      WHERE b.id = ? AND w.user_id = ?
    `).get(request.params.brandId, request.user.id);
    if (!current) return jsonError(response, 404, 'No se encontró la marca solicitada.');
    const { name = current.name, logoUrl = current.logoUrl } = request.body || {};
    let settings = {};
    try {
      settings = JSON.parse(current.settingsJson);
    } catch (error) {
      console.error('No se pudo leer la configuración persistida de una marca:', error.message);
    }
    const normalizedLogoUrl = normalizeLogoUrl(logoUrl);
    const normalizedSettings = normalizeBrandSettings(request.body?.settings ?? settings);
    if (!validText(name, 100) || normalizedLogoUrl === undefined || normalizedSettings === null) {
      return jsonError(response, 400, 'Revisa el nombre, el logotipo HTTPS y la configuración de la marca.');
    }
    database.prepare('UPDATE brands SET name = ?, logo_url = ?, settings_json = ? WHERE id = ?')
      .run(name.trim(), normalizedLogoUrl, JSON.stringify(normalizedSettings), current.id);
    response.json({ id: current.id, name: name.trim(), logoUrl: normalizedLogoUrl, settings: normalizedSettings });
  });

  app.delete('/api/brands/:brandId', requireSession, (request, response) => {
    const brand = database.prepare(`
      SELECT b.id, b.workspace_id AS workspaceId FROM brands b
      JOIN workspaces w ON w.id = b.workspace_id
      WHERE b.id = ? AND w.user_id = ?
    `).get(request.params.brandId, request.user.id);
    if (!brand) return jsonError(response, 404, 'No se encontró la marca solicitada.');
    const brands = database.prepare('SELECT id FROM brands WHERE workspace_id = ?').all(brand.workspaceId);
    if (brands.length === 1) return jsonError(response, 409, 'Conserva al menos una marca en el espacio.');
    const replacementBrandId = brands.find(({ id }) => id !== brand.id).id;
    database.transaction(() => {
      for (const table of ['social_connections', 'youtube_connections', 'instagram_connections', 'tiktok_connections']) {
        database.prepare(`UPDATE ${table} SET brand_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ? AND workspace_id = ? AND brand_id = ?`)
          .run(replacementBrandId, request.user.id, brand.workspaceId, brand.id);
      }
      database.prepare('UPDATE social_accounts SET brand_id = ? WHERE user_id = ? AND workspace_id = ? AND brand_id = ?')
        .run(replacementBrandId, request.user.id, brand.workspaceId, brand.id);
      database.prepare('UPDATE posts SET brand_id = ? WHERE user_id = ? AND workspace_id = ? AND brand_id = ?')
        .run(replacementBrandId, request.user.id, brand.workspaceId, brand.id);
      database.prepare('DELETE FROM brands WHERE id = ?').run(brand.id);
    })();
    response.status(204).end();
  });

  app.get('/api/calendar/notes', requireSession, (request, response) => {
    ensureUserWorkspace(request.user.id);
    const workspaceId = getActiveWorkspaceId(request.user.id);
    const brandId = request.query.brandId;
    if (!validText(brandId, 150)
      || !database.prepare('SELECT id FROM brands WHERE id = ? AND workspace_id = ?').get(brandId, workspaceId)) {
      return jsonError(response, 404, 'No se encontró la marca de este espacio.');
    }
    const { from, to } = request.query;
    if ((from && !validCalendarDate(from)) || (to && !validCalendarDate(to))) {
      return jsonError(response, 400, 'El rango de fechas no es válido.');
    }
    const notes = database.prepare(`
      SELECT id, brand_id AS brandId, note_date AS date, text, reminder_at AS reminderAt
      FROM calendar_notes
      WHERE user_id = ? AND workspace_id = ? AND brand_id = ?
        AND (? IS NULL OR note_date >= ?)
        AND (? IS NULL OR note_date <= ?)
      ORDER BY note_date, reminder_at, id
    `).all(request.user.id, workspaceId, brandId, from || null, from || null, to || null, to || null);
    response.json({ notes });
  });

  app.post('/api/calendar/notes', requireSession, (request, response) => {
    ensureUserWorkspace(request.user.id);
    const workspaceId = getActiveWorkspaceId(request.user.id);
    const { brandId, date, text, reminderAt = null } = request.body || {};
    if (!validText(brandId, 150)
      || !database.prepare('SELECT id FROM brands WHERE id = ? AND workspace_id = ?').get(brandId, workspaceId)) {
      return jsonError(response, 404, 'No se encontró la marca de este espacio.');
    }
    if (!validCalendarDate(date)
      || !validText(text, 2000)
      || (reminderAt !== null && (typeof reminderAt !== 'string' || Number.isNaN(Date.parse(reminderAt))))) {
      return jsonError(response, 400, 'Revisa la fecha, el texto y el recordatorio.');
    }
    const note = {
      id: `note-${randomUUID()}`,
      brandId,
      date,
      text: text.trim(),
      reminderAt: reminderAt ? new Date(reminderAt).toISOString() : null,
    };
    database.prepare(`
      INSERT INTO calendar_notes (id, user_id, workspace_id, brand_id, note_date, text, reminder_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(note.id, request.user.id, workspaceId, note.brandId, note.date, note.text, note.reminderAt);
    response.status(201).json(note);
  });

  app.patch('/api/calendar/notes/:noteId', requireSession, (request, response) => {
    ensureUserWorkspace(request.user.id);
    const workspaceId = getActiveWorkspaceId(request.user.id);
    const note = database.prepare(`
      SELECT id, brand_id AS brandId, note_date AS date, text, reminder_at AS reminderAt
      FROM calendar_notes WHERE id = ? AND user_id = ? AND workspace_id = ?
    `).get(request.params.noteId, request.user.id, workspaceId);
    if (!note) return jsonError(response, 404, 'No se encontró la nota de calendario.');
    const { date = note.date, text = note.text, reminderAt = note.reminderAt } = request.body || {};
    if (!validCalendarDate(date)
      || !validText(text, 2000)
      || (reminderAt !== null && (typeof reminderAt !== 'string' || Number.isNaN(Date.parse(reminderAt))))) {
      return jsonError(response, 400, 'Revisa la fecha, el texto y el recordatorio.');
    }
    const updated = {
      ...note,
      date,
      text: text.trim(),
      reminderAt: reminderAt ? new Date(reminderAt).toISOString() : null,
    };
    database.prepare(`
      UPDATE calendar_notes SET note_date = ?, text = ?, reminder_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ? AND workspace_id = ?
    `).run(updated.date, updated.text, updated.reminderAt, note.id, request.user.id, workspaceId);
    response.json(updated);
  });

  app.delete('/api/calendar/notes/:noteId', requireSession, (request, response) => {
    ensureUserWorkspace(request.user.id);
    database.prepare('DELETE FROM calendar_notes WHERE id = ? AND user_id = ? AND workspace_id = ?')
      .run(request.params.noteId, request.user.id, getActiveWorkspaceId(request.user.id));
    response.status(204).end();
  });

  app.get('/api/data', (request, response) => {
    ensureUserWorkspace(request.user.id);
    const workspaceId = getActiveWorkspaceId(request.user.id);
    const facebookAccounts = database.prepare(`
      SELECT account_id AS accountId, id AS connectionId, status AS connectionStatus,
        expires_at AS expiresAt, granted_scopes_json AS grantedScopes, verified_at AS verifiedAt, last_error_code AS verificationError,
        network_id AS connectionNetwork, provider_account_id AS providerAccountId
      FROM social_connections WHERE user_id = ? AND workspace_id = ?
    `).all(request.user.id, workspaceId);
    const youtubeAccounts = database.prepare(`
      SELECT account_id AS accountId, id AS connectionId, status AS connectionStatus,
        granted_scopes_json AS grantedScopes, 'youtube' AS connectionNetwork,
        provider_channel_id AS providerAccountId, custom_url AS customUrl, verified_at AS verifiedAt
      FROM youtube_connections WHERE user_id = ? AND workspace_id = ?
    `).all(request.user.id, workspaceId);
    const instagramAccounts = getInstagramConnections(request.user.id, workspaceId).map((connection) => ({
      ...connection, connectionId: connection.id, connectionStatus: connection.status,
      connectionNetwork: 'instagram', grantedScopes: JSON.stringify(connection.grantedScopes),
    }));
    const tiktokAccounts = getTikTokConnections(database, request.user.id, workspaceId).map((connection) => ({
      ...connection, connectionId: connection.id, connectionStatus: connection.status,
      connectionNetwork: 'tiktok', grantedScopes: JSON.stringify(connection.grantedScopes),
    }));
    const connectedAccounts = new Map([...facebookAccounts, ...youtubeAccounts, ...instagramAccounts, ...tiktokAccounts]
      .map((connection) => [connection.accountId, connection]));
    const accounts = database.prepare(`
      SELECT id, name, network_id AS networkId, status,
        preference_enabled AS preferenceEnabled, workspace_id AS workspaceId, brand_id AS brandId
      FROM social_accounts WHERE user_id = ? AND workspace_id = ?
    `).all(request.user.id, workspaceId)
      .map((account) => {
        const connection = connectedAccounts.get(account.id);
        return {
          ...account,
          status: connection
            ? connection.expiresAt && connection.expiresAt <= Date.now() ? 'expired' : connection.connectionStatus
            : 'demo',
          connectionId: connection?.connectionId || null,
          connectionNetwork: connection?.connectionNetwork || null,
          providerAccountId: connection?.providerAccountId || null,
          expiresAt: connection?.expiresAt || null,
          verifiedAt: connection?.verifiedAt || null,
          verificationError: connection?.verificationError || null,
          ...(connection?.connectionNetwork === 'instagram' ? {
            verifiedAt: connection.verifiedAt, username: connection.username,
            pageId: connection.pageId, pageName: connection.pageName,
          } : {}),
          ...(connection?.connectionNetwork === 'youtube' ? {
            verifiedAt: connection.verifiedAt, customUrl: connection.customUrl,
          } : {}),
          grantedScopes: connection ? JSON.parse(connection.grantedScopes) : [],
          preferenceEnabled: Boolean(account.preferenceEnabled),
        };
      });
    const posts = database.prepare(`
      SELECT id, text, title, description, hashtags, network_id AS networkId,
        network_ids AS networkIds, network_content AS networkContent, account_ids AS accountIds,
        'draft' AS status, scheduled_at AS date, format, brand_id AS brandId
      FROM posts WHERE user_id = ? AND workspace_id = ?
    `).all(request.user.id, workspaceId)
      .map((post) => ({
        ...post,
        networkIds: JSON.parse(post.networkIds),
        accountIds: JSON.parse(post.accountIds),
        networkContent: JSON.parse(post.networkContent),
      }));
    const storedOrder = JSON.parse(database.prepare('SELECT account_ids_json AS ids FROM social_card_orders WHERE user_id = ? AND workspace_id = ?').get(request.user.id, workspaceId)?.ids || '[]');
    const accountOrder = [...new Set([...storedOrder.filter((id) => accounts.some((account) => account.id === id)), ...accounts.map((account) => account.id)])];
    response.json({ profile: request.user, accounts, posts, workspaceId, accountOrder, activeBrandId: getActiveBrandId(request.user.id, workspaceId) });
  });

  app.put('/api/workspaces/:workspaceId/account-order', requireSession, (request, response) => {
    const workspaceId = request.params.workspaceId;
    if (!database.prepare('SELECT 1 FROM workspaces WHERE id = ? AND user_id = ?').get(workspaceId, request.user.id)) return jsonError(response, 404, 'No se encontró el espacio.');
    const ids = request.body?.accountIds;
    const owned = database.prepare('SELECT id FROM social_accounts WHERE user_id = ? AND workspace_id = ?').all(request.user.id, workspaceId).map((row) => row.id);
    if (!Array.isArray(ids) || ids.length > 1000 || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string' || !owned.includes(id))) return jsonError(response, 400, 'El orden debe contener cuentas propias del espacio, sin duplicados.');
    const order = [...ids, ...owned.filter((id) => !ids.includes(id))];
    database.prepare('INSERT INTO social_card_orders (user_id, workspace_id, account_ids_json) VALUES (?, ?, ?) ON CONFLICT(user_id, workspace_id) DO UPDATE SET account_ids_json = excluded.account_ids_json')
      .run(request.user.id, workspaceId, JSON.stringify(order));
    response.json({ accountOrder: order });
  });

  app.put('/api/data/profile', (request, response) => {
    const { name } = request.body || {};
    if (!validText(name, 80)) return jsonError(response, 400, 'El nombre del perfil es obligatorio y debe tener 80 caracteres como máximo.');
    database.prepare('UPDATE users SET name = ? WHERE id = ?').run(name.trim(), request.user.id);
    response.json({ profile: { ...request.user, name: name.trim() } });
  });

  app.put('/api/data/accounts/:accountId', (request, response) => {
    const account = normalizeAccount({ ...request.body, id: request.params.accountId });
    if (!account) return jsonError(response, 400, 'La cuenta contiene datos no válidos.');
    ensureUserWorkspace(request.user.id);
    const workspaceId = getActiveWorkspaceId(request.user.id);
    const existing = database.prepare('SELECT workspace_id AS workspaceId FROM social_accounts WHERE user_id = ? AND id = ?')
      .get(request.user.id, account.id);
    if (existing && existing.workspaceId !== workspaceId) return jsonError(response, 404, 'No se encontró la cuenta solicitada.');
    const officialConnection = ['social_connections', 'youtube_connections', 'instagram_connections', 'tiktok_connections']
      .some((table) => database.prepare(`SELECT 1 FROM ${table} WHERE account_id = ? AND user_id = ?`)
        .get(account.id, request.user.id));
    if (officialConnection) return jsonError(response, 409, 'Usa las opciones de la conexión oficial para reasignarla o reconectarla.');
    const brandId = request.body?.brandId
      || database.prepare('SELECT id FROM brands WHERE workspace_id = ? ORDER BY created_at, id LIMIT 1').get(workspaceId)?.id;
    if (!brandId || !database.prepare('SELECT id FROM brands WHERE id = ? AND workspace_id = ?').get(brandId, workspaceId)) {
      return jsonError(response, 400, 'Selecciona una marca de este espacio para organizar la cuenta.');
    }
    database.prepare(`
      INSERT INTO social_accounts (id, user_id, name, network_id, status, preference_enabled, workspace_id, brand_id)
      VALUES (?, ?, ?, ?, 'demo', ?, ?, ?)
      ON CONFLICT(user_id, id) DO UPDATE SET name = excluded.name, network_id = excluded.network_id,
        preference_enabled = excluded.preference_enabled, brand_id = excluded.brand_id
    `).run(account.id, request.user.id, account.name, account.networkId, Number(account.preferenceEnabled), workspaceId, brandId);
    response.json({ ...account, workspaceId, brandId });
  });

  app.delete('/api/data/accounts/:accountId', (request, response) => {
    ensureUserWorkspace(request.user.id);
    database.prepare('DELETE FROM social_accounts WHERE user_id = ? AND workspace_id = ? AND id = ?')
      .run(request.user.id, getActiveWorkspaceId(request.user.id), request.params.accountId);
    response.status(204).end();
  });

  app.put('/api/data/posts/:postId', (request, response) => {
    const post = normalizePost({ ...request.body, id: request.params.postId });
    if (!post) return jsonError(response, 400, 'Solo se pueden guardar borradores con datos válidos.');
    ensureUserWorkspace(request.user.id);
    const workspaceId = getActiveWorkspaceId(request.user.id);
    const existing = database.prepare('SELECT workspace_id AS workspaceId, brand_id AS brandId, account_ids AS accountIds FROM posts WHERE user_id = ? AND id = ?')
      .get(request.user.id, post.id);
    if (existing && existing.workspaceId !== workspaceId) return jsonError(response, 404, 'No se encontró el borrador solicitado.');
    const brandId = post.brandId || database.prepare('SELECT brand_id AS brandId FROM posts WHERE user_id = ? AND id = ?')
      .get(request.user.id, post.id)?.brandId || database.prepare('SELECT id FROM brands WHERE workspace_id = ? ORDER BY created_at, id LIMIT 1')
        .get(workspaceId)?.id;
    if (!brandId) return jsonError(response, 409, 'Crea una marca antes de guardar borradores en este espacio.');
    if (!database.prepare('SELECT id FROM brands WHERE id = ? AND workspace_id = ?').get(brandId, workspaceId)) {
      return jsonError(response, 404, 'No se encontró la marca solicitada en este espacio.');
    }
    const unchangedDestinations = existing?.brandId === brandId && post.accountIds.every((id) => JSON.parse(existing.accountIds).includes(id));
    // Editing a private draft must remain possible if an earlier destination expires
    // or is disconnected. New destinations always require current verified access.
    if (post.accountIds.length && !unchangedDestinations) {
      const destinationNetworks = new Set();
      for (const id of post.accountIds) {
        const account = database.prepare('SELECT network_id AS network FROM social_accounts WHERE id = ? AND user_id = ? AND workspace_id = ? AND brand_id = ?').get(id, request.user.id, workspaceId, brandId);
        const table = { facebook: 'social_connections', youtube: 'youtube_connections', instagram: 'instagram_connections', tiktok: 'tiktok_connections' }[account?.network];
        const connection = table && database.prepare(`SELECT * FROM ${table} WHERE account_id = ? AND user_id = ? AND workspace_id = ? AND brand_id = ?`).get(id, request.user.id, workspaceId, brandId);
        if (!connection || connection.status !== 'connected' || !connection.verified_at || connection.last_error_code || (connection.expires_at && connection.expires_at <= Date.now())) return jsonError(response, 400, 'Selecciona únicamente cuentas oficiales verificadas de la marca y espacio del borrador.');
        destinationNetworks.add(account.network);
      }
      if (post.networkIds.length !== destinationNetworks.size || post.networkIds.some((network) => !destinationNetworks.has(network))) return jsonError(response, 400, 'Las redes no coinciden con las cuentas seleccionadas.');
    }
    database.prepare(`
      INSERT INTO posts (
        id, user_id, text, title, description, hashtags, network_id, network_ids, network_content, account_ids,
        status, scheduled_at, workspace_id, brand_id, format
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
      ON CONFLICT(user_id, id) DO UPDATE SET text = excluded.text, title = excluded.title,
        description = excluded.description, hashtags = excluded.hashtags, network_id = excluded.network_id,
        network_ids = excluded.network_ids, network_content = excluded.network_content,
        account_ids = excluded.account_ids,
        scheduled_at = excluded.scheduled_at, status = 'draft',
        brand_id = excluded.brand_id, format = excluded.format
    `).run(
      post.id,
      request.user.id,
      post.text,
      post.title,
      post.description,
      post.hashtags,
      post.networkId,
      JSON.stringify(post.networkIds),
      JSON.stringify(post.networkContent),
      JSON.stringify(post.accountIds),
      post.date,
      workspaceId,
      brandId,
      post.format,
    );
    response.json({ ...post, brandId });
  });

  app.delete('/api/data/posts/:postId', (request, response) => {
    ensureUserWorkspace(request.user.id);
    database.prepare('DELETE FROM posts WHERE user_id = ? AND workspace_id = ? AND id = ?')
      .run(request.user.id, getActiveWorkspaceId(request.user.id), request.params.postId);
    response.status(204).end();
  });

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (error instanceof SyntaxError && 'body' in error) return jsonError(response, 400, 'El cuerpo JSON no es válido.');
    if (error.type === 'entity.too.large') return jsonError(response, 413, 'La solicitud supera el tamaño permitido.');
    console.error('Error interno de API:', error);
    return jsonError(response, 500, 'Ocurrió un error interno. Revisa el registro del servidor.');
  });

  return app;
}

export async function listenOnFixedPort(app, port = 3001) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('El puerto del backend debe ser un entero entre 1 y 65535.');
  }
  const server = app.listen(port, '127.0.0.1');
  await new Promise((resolveListen, rejectListen) => {
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };
    const onError = (error) => {
      server.off('listening', onListening);
      rejectListen(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });
  return server;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = createApp();
  const port = 3001;

  const start = async () => {
    const server = await listenOnFixedPort(app, port);
    console.log(`LOP API disponible localmente en http://127.0.0.1:${port}`);
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI) {
      console.log(`Callback OAuth de Google configurado: ${process.env.GOOGLE_REDIRECT_URI}`);
    }
    if (process.send) process.send({ type: 'lop-api-ready', port });

    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      server.close((error) => {
        if (error) console.error('Error al cerrar LOP API:', error.message);
        app.locals.database.close();
      });
    };
    process.on('SIGINT', close);
    process.on('SIGTERM', close);
  };

  start().catch((error) => {
    app.locals.database.close();
    if (error.code === 'EADDRINUSE') {
      console.error(`El puerto fijo ${port} ya está ocupado. No se inició otra instancia de LOP API; identifica y cierra solo el proceso anterior de este proyecto.`);
    } else {
      console.error('No se pudo iniciar LOP API:', error.message);
    }
    process.exitCode = 1;
  });
}
