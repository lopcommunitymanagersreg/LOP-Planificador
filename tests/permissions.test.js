import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAccountPermissions } from '../src/permissions.js';

test('permission dialog distinguishes the existing YouTube read grant from missing upload consent', () => {
  const read = 'https://www.googleapis.com/auth/youtube.readonly';
  const upload = 'https://www.googleapis.com/auth/youtube.upload';
  const permissions = getAccountPermissions({ status: 'connected', verifiedAt: '2026-01-01', grantedScopes: [read] }, [read, upload]);
  assert.equal(permissions[0].status, 'Concedido en la última comprobación');
  assert.equal(permissions[1].status, 'Pendiente de autorización');
  assert.match(permissions[1].description, /carga de videos/);
  assert.equal(getAccountPermissions({ status: 'expired', grantedScopes: [read] })[0].status, 'Autorización no vigente');
  assert.equal(getAccountPermissions({ status: 'connected', grantedScopes: [read] })[0].status, 'Registrado · pendiente de verificar');
});
