import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer as createNetServer } from 'node:net';
import { basename, join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';

const runFile = promisify(execFile);
const browser = [
  process.env.LOP_TEST_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].find((path) => path && existsSync(path));

// This fixture is injected only by this temporary test server. It never uses real
// sessions, credentials, SQLite files or the running localhost API.
function browserScenario() {
  const key = 'lop-ui-regression-fixture';
  const initial = {
    stage: 0, passed: [], activeWorkspaceId: 'workspace-ui',
    selections: { 'workspace-ui': 'brand-a', 'workspace-second': 'brand-c' },
    writes: [], verification: 'success', verifiedAt: '2026-01-01T00:00:00.000Z', status: 'connected', orders: {}, orderWrites: 0,
  };
  const state = JSON.parse(localStorage.getItem(key) || 'null') || initial;
  const store = () => localStorage.setItem(key, JSON.stringify(state));
  const user = { id: 'ui-owner', name: 'Usuario de prueba', email: 'ui@example.test' };
  const workspaces = [
    { id: 'workspace-ui', name: 'Espacio UI', brands: [
      { id: 'brand-a', name: 'Marca A', settings: {} }, { id: 'brand-b', name: 'Marca B con un nombre mucho más largo para comprobar las columnas', settings: {} },
    ] },
    { id: 'workspace-second', name: 'Segundo espacio con un nombre mucho más largo', brands: [{ id: 'brand-c', name: 'Marca C', settings: {} }] },
  ];
  const accounts = () => state.activeWorkspaceId === 'workspace-ui' ? [
    { id: 'account-youtube', connectionId: 'youtube-ui', connectionNetwork: 'youtube', networkId: 'youtube',
      name: 'Canal de prueba', customUrl: '@canalprueba', channelId: 'UC1111111111111111111111',
      workspaceId: 'workspace-ui', brandId: 'brand-a', status: state.status, verifiedAt: state.verifiedAt,
      grantedScopes: ['https://www.googleapis.com/auth/youtube.readonly'] },
    { id: 'account-facebook', connectionId: 'facebook-ui', connectionNetwork: 'facebook', networkId: 'facebook',
      name: 'Página de prueba', workspaceId: 'workspace-ui', brandId: 'brand-b', status: 'connected', verifiedAt: '2026-01-01T00:00:00.000Z', verificationError: state.facebookError || null, grantedScopes: [] },
  ] : [];
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  const nativeFetch = window.fetch.bind(window);
  const unexpected = [];
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return nativeFetch(input, options);
    const path = url.pathname.slice(4);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : {};
    if (path === '/auth/session') return reply({ user });
    if (path === '/auth/methods') return reply({ google: true, emailDelivery: false });
    if (path === '/connections/methods') return reply({ facebook: { available: true }, youtube: { available: true }, instagram: { available: false }, tiktok: { available: Boolean(state.tiktokAvailable) } });
    if (path.endsWith('/pending')) return reply({ pending: null });
    if (path === '/data' && method === 'GET') return reply({ profile: user, workspaceId: state.activeWorkspaceId, activeBrandId: state.selections[state.activeWorkspaceId], accounts: accounts(), posts: state.savedPost ? [state.savedPost] : [], accountOrder: state.orders[state.activeWorkspaceId] || accounts().map((account) => account.id) });
    if (path.startsWith('/data/posts/') && method === 'PUT') { state.savedPost = body; store(); return reply(body); }
    const order = path.match(/^\/workspaces\/([^/]+)\/account-order$/);
    if (order && method === 'PUT') {
      await pause(30);
      if (window.failNextOrderSave) { window.failNextOrderSave = false; return reply({ error: 'Fallo controlado de orden' }, 500); }
      state.orders[order[1]] = body.accountIds; state.orderWrites += 1; store(); return reply({ accountOrder: body.accountIds });
    }
    if (path === '/workspaces') return reply({ workspaces, activeWorkspaceId: state.activeWorkspaceId, activeBrandId: state.selections[state.activeWorkspaceId] });
    if (path === '/workspaces/active' && method === 'PUT') {
      state.activeWorkspaceId = body.workspaceId; store();
      return reply({ activeWorkspaceId: body.workspaceId, activeBrandId: state.selections[body.workspaceId] });
    }
    const selection = path.match(/^\/workspaces\/([^/]+)\/active-brand$/);
    if (selection && method === 'PUT') {
      await pause(30);
      if (window.failNextBrandSave) { window.failNextBrandSave = false; return reply({ error: 'Fallo controlado de guardado' }, 500); }
      state.selections[selection[1]] = body.brandId;
      state.writes.push(body.brandId); store();
      return reply({ workspaceId: selection[1], activeBrandId: body.brandId });
    }
    if (path === '/connections/summary') {
      const brandId = url.searchParams.get('brandId');
      const selected = accounts().filter((account) => !brandId || account.brandId === brandId);
      return reply({ registeredAccounts: selected.length, officialConnections: selected.filter((account) => account.status === 'connected').length });
    }
    if (path === '/connections/facebook-ui/verify' && method === 'POST') {
      await pause(250); state.facebookError = window.blockFacebook ? 'api-blocked' : null; store();
      return reply({ verified: !window.blockFacebook, message: window.blockFacebook ? 'Meta bloqueó el acceso de la aplicación (API access blocked).' : 'Meta confirmó la página y sus permisos.' });
    }
    if (path === '/connections/youtube-ui/verify' && method === 'POST') {
      await pause(250);
      if (state.verification === 'error') return reply({ error: 'Fallo controlado de YouTube; inténtalo de nuevo.' }, 502);
      const verified = state.verification !== 'expired';
      state.status = verified ? 'connected' : 'expired';
      state.verifiedAt = verified ? new Date().toISOString() : state.verifiedAt; store();
      return reply({ verified, message: verified ? 'YouTube confirmó el canal de prueba y renovó su autorización.' : 'La autorización venció. Reconecta YouTube con Google.' });
    }
    unexpected.push(`${method} ${path}`);
    return reply({ error: `Solicitud inesperada: ${method} ${path}` }, 500);
  };
  const check = (condition, message) => { if (!condition) throw new Error(message); state.passed.push(message); store(); };
  const contextPositions = () => {
    const top = [...document.querySelectorAll('[data-testid="active-context"] > div')].map((item) => item.getBoundingClientRect().left);
    const bottom = ['home-active-workspace', 'home-active-brand'].map((id) => document.querySelector(`label[for="${id}"]`).getBoundingClientRect().left);
    return { top, bottom, aligned: top.every((left, index) => Math.abs(left - bottom[index]) < 1) };
  };
  const until = async (condition, message) => {
    for (let count = 0; count < 300; count += 1) { if (condition()) return; await pause(30); }
    throw new Error(message);
  };
  const button = (label, root = document) => [...root.querySelectorAll('button')].find((item) => item.textContent.trim().endsWith(label));
  const click = (label, root = document) => { const item = button(label, root); if (!item) throw new Error(`No existe el botón ${label}`); item.click(); };
  const select = (id, value) => {
    const item = document.getElementById(id);
    if (!item) throw new Error(`No existe el selector ${id}`);
    item.value = value;
    item.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const input = (id, value) => {
    const item = document.getElementById(id);
    Object.getOwnPropertyDescriptor(item.constructor.prototype, 'value').set.call(item, value);
    item.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const saved = async (id) => until(() => state.selections['workspace-ui'] === id && !document.body.textContent.includes('Guardando selección…'), 'La selección no se guardó');
  const finish = (error) => {
    const result = document.createElement('pre'); result.id = 'lop-ui-test-result';
    result.textContent = JSON.stringify({ ok: !error, passed: state.passed, unexpected, error: error?.stack || null });
    document.body.append(result);
  };
  (async () => {
    await until(() => document.getElementById('home-active-brand'), 'Inicio no cargó');
    if (state.stage === 3) {
      check(document.querySelector('.social-home-card')?.dataset.accountId === 'account-youtube', 'El orden de las tarjetas se conserva al recargar');
      check(unexpected.length === 0, 'El nuevo formulario solo guarda borradores locales y no llama a APIs de publicación');
      finish(); return;
    }
    if (state.stage === 0) {
      const columns = contextPositions();
      check(columns.aligned, 'Espacio y Marca comparten exactamente los ejes de sus selectores');
      select('home-active-workspace', '__create__');
      await until(() => document.getElementById('workspace-name'), 'No abrió Crear espacio desde el selector');
      check(Boolean(document.getElementById('workspace-name')), 'El selector compacto permite crear espacios');
      click('Cancelar', document.querySelector('[role="dialog"]'));
      select('home-active-brand', '__create__');
      await until(() => document.getElementById('brand-name'), 'No abrió Crear marca desde el selector');
      check(Boolean(document.getElementById('brand-name')), 'El selector compacto permite crear marcas');
      click('Cancelar', document.querySelector('[role="dialog"]'));
      check(document.querySelector('[data-testid="active-context"]').textContent.includes('Espacio UI'), 'Inicio muestra el nombre real del espacio');
      check(document.querySelector('[data-testid="active-context"]').textContent.includes('Marca A'), 'Inicio muestra la marca activa');
      select('home-active-brand', 'brand-b'); await saved('brand-b');
      check(document.querySelector('[data-testid="active-context"]').textContent.includes('Marca B'), 'Inicio actualiza automáticamente la marca activa');
      check(contextPositions().aligned && contextPositions().top.every((left, index) => Math.abs(left - columns.top[index]) < 1), 'Un nombre de marca largo no mueve ninguna columna');
      state.stage = 1; store(); location.reload(); return;
    }
    if (state.stage === 1) {
      check(document.getElementById('home-active-brand').value === 'brand-b', 'La selección de marca se restaura al recargar');
      select('home-active-brand', ''); await saved(null);
      state.stage = 2; store(); location.reload(); return;
    }
    check(document.getElementById('home-active-brand').value === '', 'Sin marca seleccionada se conserva al recargar');
    check(contextPositions().aligned, 'Sin marca activa se conserva la alineación de ambas columnas');
    click('Cuentas sociales');
    await until(() => document.getElementById('accounts-brand-filter'), 'Cuentas no cargó');
    await until(() => document.querySelector('.tiktok-connect-button img')?.naturalWidth > 0, 'No cargó el logotipo oficial de TikTok');
    check(document.querySelector('button.tiktok-connect-button')?.disabled && !document.querySelector('a.tiktok-connect-button'), 'TikTok muestra su botón oficial deshabilitado cuando falta configuración');
    check(document.querySelectorAll('.registered-accounts .registered-account').length === 2, 'Sin marca se muestran todas las cuentas del espacio');
    check(!document.querySelector('a[href*="youtube/authorize"]'), 'Una conexión nueva exige seleccionar una marca');
    select('accounts-brand-filter', 'brand-a'); await saved('brand-a');
    const accountCard = document.querySelector('.registered-account');
    const size = accountCard.getBoundingClientRect();
    check(Math.abs(size.width - size.height) < 2 && getComputedStyle(accountCard).boxShadow !== 'none', 'Cuentas sociales usa tarjetas cuadradas con relieve');
    check(!document.querySelector('.registered-account .sample-label'), 'Las tarjetas no muestran franjas técnicas de permisos');
    document.querySelector('[aria-label="Opciones de Canal de prueba"]').click();
    await until(() => button('Ver permisos'), 'No aparece Ver permisos');
    click('Ver permisos');
    await until(() => document.querySelector('.permissions-table'), 'No abrió el diálogo de permisos');
    check(document.querySelector('.permissions-table').textContent.includes('Pendiente de autorización'), 'Un permiso de carga no concedido aparece pendiente');
    check(document.querySelector('.permissions-table').textContent.includes('youtube.readonly') && document.querySelector('.permissions-table').textContent.includes('Consultar tu canal'), 'El diálogo muestra permisos técnicos y su explicación');
    click('Cerrar', document.querySelector('[role="dialog"]'));
    await until(() => document.querySelector('.google-connect-button img')?.naturalWidth > 0, 'No cargó el logotipo oficial');
    const google = document.querySelector('.google-connect-button');
    check(google.textContent === 'Conectar YouTube con Google' && google.getAttribute('href') === '/api/connections/youtube/authorize?brandId=brand-a', 'Botón Google con logotipo, texto y ruta OAuth conservada');
    state.tiktokAvailable = true; store();

    document.querySelector('.workspace-switcher').click();
    await until(() => document.querySelector('.managed-workspace'), 'No abrió espacios');
    click('Desactivar marca', document.querySelector('.managed-brand.selected'));
    await saved(null);
    check(!document.querySelector('.managed-brand.selected'), 'Desactivar la marca cambia el contexto sin eliminarla');
    select('managed-brand-select', 'brand-a'); await saved('brand-a');
    click('Seleccionar', [...document.querySelectorAll('.managed-workspace')].find((item) => item.textContent.includes('Segundo espacio')));
    await until(() => document.querySelector('[data-testid="active-context"]')?.textContent.includes('Segundo espacio'), 'No cambió el espacio');
    check(document.getElementById('home-active-brand').value === 'brand-c', 'Cada espacio mantiene su marca activa');
    check(contextPositions().aligned, 'Cambiar a un espacio con nombre largo conserva la alineación');
    document.querySelector('.workspace-switcher').click();
    await until(() => document.querySelector('.managed-workspace'), 'No abrió espacios de nuevo');
    click('Seleccionar', [...document.querySelectorAll('.managed-workspace')].find((item) => item.textContent.includes('Espacio UI')));
    await until(() => document.getElementById('home-active-brand')?.value === 'brand-a', 'No restauró la marca al regresar');
    check(true, 'Volver al espacio restaura su selección');
    window.failNextBrandSave = true;
    select('home-active-brand', 'brand-b');
    await until(() => document.querySelector('.brand-context-selector [role="alert"]'), 'No se muestra error de guardado');
    check(document.getElementById('home-active-brand').value === 'brand-a', 'Un error de guardado informa y restaura la marca persistida');
    const writeCount = state.writes.length;
    select('home-active-brand', 'brand-b'); select('home-active-brand', ''); select('home-active-brand', 'brand-a');
    await until(() => state.writes.length === writeCount + 3, 'No terminó la secuencia de selección');
    check(JSON.stringify(state.writes.slice(-3)) === JSON.stringify(['brand-b', null, 'brand-a']), 'Los cambios rápidos de marca se guardan en orden');

    document.querySelector('[aria-label="Abrir menú de perfil"]').click();
    await until(() => button('Configuración'), 'No abrió el menú de perfil');
    click('Configuración');
    await until(() => document.querySelector('.settings-row'), 'No abrió configuración');
    const row = [...document.querySelectorAll('.settings-row')].find((item) => item.textContent.includes('Notificaciones visuales'));
    row.querySelector('button').click();
    await until(() => row.querySelector('button').getAttribute('aria-pressed') === 'false', 'No se desactivaron las notificaciones');
    click('Listo'); click('Cuentas sociales');
    await until(() => document.querySelector('a.tiktok-connect-button img')?.naturalWidth > 0, 'No aparece el botón habilitado de TikTok');
    check(document.querySelector('a.tiktok-connect-button').getAttribute('href') === '/api/connections/tiktok/authorize?brandId=brand-a' && document.querySelector('a.tiktok-connect-button').textContent === 'Conectar TikTok', 'El botón TikTok con logotipo usa el OAuth existente y la marca activa');
    await until(() => document.querySelector('[aria-label="Opciones de Canal de prueba"]'), 'No encontró la cuenta');
    document.querySelector('[aria-label="Opciones de Canal de prueba"]').click();
    await until(() => button('Ver detalles'), 'No abrió el menú de la cuenta');
    click('Ver detalles');
    await until(() => document.querySelector('[role="dialog"]'), 'No abrió detalle');
    click('Verificar conexión', document.querySelector('[role="dialog"]'));
    await until(() => document.querySelector('[role="dialog"] .connection-feedback.checking'), 'No aparece estado de verificación');
    check(button('Verificando…', document.querySelector('[role="dialog"]')).disabled, 'La verificación muestra progreso y evita envíos duplicados');
    await until(() => document.querySelector('[role="dialog"] .connection-feedback.success'), 'No se muestra éxito en el detalle');
    check(document.querySelector('[role="dialog"] .connection-feedback.success').textContent.includes('YouTube confirmó'), 'El resultado exitoso se ve en el detalle con notificaciones desactivadas');
    check(Number(getComputedStyle(document.querySelector('.toast-message')).zIndex) > Number(getComputedStyle(document.querySelector('.modal-backdrop')).zIndex), 'El aviso queda visible sobre el modal');
    state.verification = 'error';
    click('Verificar conexión', document.querySelector('[role="dialog"]'));
    await until(() => document.querySelector('[role="dialog"] .connection-feedback.error'), 'No se muestra error de proveedor');
    check(document.querySelector('[role="dialog"] .connection-feedback.error').textContent.includes('Fallo controlado de YouTube'), 'Los errores de YouTube se muestran sin eliminar la conexión');
    check(state.status === 'connected', 'Un fallo temporal conserva la conexión');
    state.verification = 'expired';
    click('Verificar conexión', document.querySelector('[role="dialog"]'));
    await until(() => document.querySelector('[role="dialog"] .connection-feedback.error')?.textContent.includes('Reconecta'), 'No se muestra la autorización vencida');
    click('Cerrar', document.querySelector('[role="dialog"]'));
    await until(() => !document.querySelector('[role="dialog"]'), 'No se cerró el detalle');
    document.querySelector('[aria-label="Opciones de Canal de prueba"]').click();
    await until(() => document.querySelector('a[role="menuitem"][href="/api/connections/youtube/authorize?brandId=brand-a"]'), 'No aparece la opción de reconectar');
    check(document.querySelector('a[role="menuitem"][href="/api/connections/youtube/authorize?brandId=brand-a"]').textContent.includes('Reconectar'), 'La autorización vencida ofrece reconectar a la misma marca');
    state.verification = 'success'; click('Verificar conexión');
    await until(() => document.querySelector('.registered-accounts .connection-feedback.success'), 'No se muestra resultado en la tarjeta');
    check(true, 'Verificar desde el menú muestra el resultado en la tarjeta');
    select('accounts-brand-filter', ''); await saved(null);
    check(document.querySelectorAll('.registered-accounts .registered-account').length === 2, 'La verificación conserva las cuentas de YouTube y Facebook sin duplicarlas');
    check(unexpected.length === 0, 'La interfaz no envía escrituras inesperadas ni sobrescribe cuentas oficiales');
    click('Inicio'); await until(() => document.querySelector('.social-home-card'), 'No aparecen tarjetas de Inicio');
    check(getComputedStyle(document.querySelector('.connected-accounts-list')).gridTemplateColumns.split(' ').length === (innerWidth <= 640 ? 1 : innerWidth <= 1050 ? 2 : 3), 'Las tarjetas usan tres columnas en escritorio y una en móvil');
    const cards = [...document.querySelectorAll('.social-home-card')];
    const transfer = new DataTransfer();
    cards[1].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
    cards[0].dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    await until(() => state.orderWrites === 1, 'No se guardó el arrastre');
    check(document.querySelector('.social-home-card').dataset.accountId === 'account-facebook', 'Arrastrar cambia y guarda el orden sin reasignar cuentas');
    document.querySelector('[aria-label="Mover Canal de prueba antes"]').click();
    await until(() => state.orderWrites === 2, 'No se guardó la ordenación accesible');
    check(document.querySelector('.social-home-card').dataset.accountId === 'account-youtube', 'Los botones permiten ordenar también con teclado o pantalla táctil');
    window.failNextOrderSave = true;
    document.querySelector('[aria-label="Mover Canal de prueba después"]').click();
    await until(() => document.querySelector('[role="alert"]')?.textContent.includes('orden'), 'No aparece error de orden');
    check(document.querySelector('.social-home-card').dataset.accountId === 'account-youtube', 'Si falla el guardado se restaura el orden anterior');
    click('Cuentas sociales');
    await until(() => document.querySelector('[aria-label="Opciones de Página de prueba"]'), 'No aparece la página');
    document.querySelector('[aria-label="Opciones de Página de prueba"]').click();
    await until(() => button('Ver detalles'), 'No aparece el menú de Facebook'); click('Ver detalles');
    await until(() => document.querySelector('[role="dialog"]'), 'No abrió el detalle de Facebook');
    check(Boolean(button('Verificar conexión', document.querySelector('[role="dialog"]'))), 'Facebook ofrece Verificar conexión en el detalle');
    click('Verificar conexión', document.querySelector('[role="dialog"]'));
    await until(() => document.querySelector('[role="dialog"] .connection-feedback.success'), 'No muestra éxito de Facebook');
    check(document.querySelector('[role="dialog"] .connection-feedback.success').textContent.includes('Meta confirmó'), 'El éxito de Facebook muestra un resultado explícito');
    window.blockFacebook = true; click('Verificar conexión', document.querySelector('[role="dialog"]'));
    await until(() => document.querySelector('[role="dialog"] .connection-feedback.error'), 'No muestra el bloqueo de Meta');
    check(document.querySelector('[role="dialog"] .connection-feedback.error').textContent.includes('API access blocked'), 'Un bloqueo de Meta muestra un error concreto y conserva la página');
    window.blockFacebook = false; click('Verificar conexión', document.querySelector('[role="dialog"]'));
    await until(() => document.querySelector('[role="dialog"] .connection-feedback.success'), 'No se recuperó la página de prueba');
    click('Cerrar', document.querySelector('[role="dialog"]')); click('Inicio');
    await until(() => document.getElementById('home-active-brand'), 'No volvió a Inicio');
    select('home-active-brand', 'brand-a'); await saved('brand-a');
    document.querySelector('.topbar-new-button').click();
    await until(() => document.querySelector('.composer-accounts'), 'No abrió el nuevo formulario');
    const form = document.querySelector('.composer-accounts').closest('form');
    check(form.querySelector('.modal-heading').nextElementSibling.classList.contains('composer-accounts'), 'La selección de cuentas aparece inmediatamente debajo del encabezado');
    check(form.querySelectorAll('.composer-accounts input').length === 1 && form.querySelector('.composer-accounts').textContent.includes('Canal de prueba'), 'Solo se ofrece la cuenta verificada de la marca activa');
    input('post-text', 'Descripción general que debe conservarse');
    form.querySelector('.composer-accounts input').click();
    await until(() => document.getElementById('new-network-youtube-title'), 'No aparecen los campos de YouTube');
    check(document.getElementById('draft-format').options.length === 1 && document.getElementById('draft-format').value === 'video', 'YouTube muestra título y descripción propios y solo formato vídeo');
    input('new-network-youtube-title', 'Título de prueba'); input('new-network-youtube-description', 'Descripción específica');
    form.querySelector('.composer-accounts input').click();
    await until(() => !document.getElementById('new-network-youtube-title'), 'No se ocultó YouTube al deseleccionar');
    form.querySelector('.composer-accounts input').click();
    await until(() => document.getElementById('new-network-youtube-description'), 'No reaparece la personalización');
    check(document.getElementById('post-text').value === 'Descripción general que debe conservarse' && document.getElementById('new-network-youtube-description').value === 'Descripción específica', 'Personalizar o deseleccionar una red conserva la descripción general y sus campos propios');
    select('draft-brand', 'brand-b'); await saved('brand-b');
    check(form.querySelectorAll('.composer-accounts input').length === 1 && form.querySelector('.composer-accounts').textContent.includes('Página de prueba'), 'Cambiar de marca actualiza automáticamente las cuentas disponibles');
    form.querySelector('.composer-accounts input').click();
    await until(() => document.getElementById('new-network-facebook-description'), 'No aparece la descripción de Facebook');
    check(!document.getElementById('new-network-facebook-title') && !document.getElementById('new-network-youtube-title'), 'Facebook no muestra campos específicos de YouTube ni opciones ajenas');
    select('draft-brand', 'brand-a'); await saved('brand-a');
    form.querySelector('.composer-accounts input').click();
    await until(() => document.getElementById('new-network-youtube-title'), 'No recuperó YouTube');
    form.querySelector('.calendar-undated-toggle input').click();
    click('Guardar borrador', form);
    await until(() => state.savedPost, 'No se guardó el borrador');
    check(state.savedPost.accountIds.join() === 'account-youtube' && state.savedPost.networkIds.join() === 'youtube' && state.savedPost.text === 'Descripción general que debe conservarse' && state.savedPost.networkContent.youtube.description === 'Descripción específica', 'El borrador guarda la cuenta concreta y las descripciones general y personalizada');
    await until(() => !document.querySelector('.composer-accounts'), 'No se cerró el formulario');
    select('home-active-brand', ''); await saved(null);
    state.stage = 3; store(); location.reload();
  })().catch(finish);
}

test('frontend: context selection, visible verification feedback, recovery and Google button', { skip: !browser, timeout: 90_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lop-frontend-test-'));
  const reservation = createNetServer();
  await new Promise((done, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', done); });
  const testPort = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const vite = await createServer({
    configFile: false, root: process.cwd(), cacheDir: join(directory, 'vite-cache'), logLevel: 'silent',
    plugins: [react(), { name: 'lop-ui-regression-fixture', transformIndexHtml() {
      return [{ tag: 'script', children: `(${browserScenario.toString()})();`, injectTo: 'head-prepend' }];
    } }],
    server: { host: '127.0.0.1', port: testPort, strictPort: true, hmr: false },
  });
  try {
    await vite.listen();
    const port = vite.httpServer.address().port;
    for (const viewport of ['1440,1000', '768,1024', '390,844']) {
    const { stdout } = await runFile(browser, [
      '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-extensions', '--no-sandbox',
      `--user-data-dir=${join(directory, `browser-${viewport}`)}`, `--window-size=${viewport}`, '--virtual-time-budget=30000', '--dump-dom',
      `http://127.0.0.1:${port}/`,
    ], { windowsHide: true, timeout: 75_000, maxBuffer: 3_000_000 });
    const match = stdout.match(/<pre id="lop-ui-test-result">([\s\S]*?)<\/pre>/);
    assert.ok(match, `El navegador no terminó las comprobaciones: ${stdout.slice(-2500)}`);
    const result = JSON.parse(match[1].replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.unexpected.length, 0);
    assert.equal(result.passed.length, 50);
    console.log(`Frontend ${viewport}: ${result.passed.length} comprobaciones de navegador superadas.`);
    }
  } finally {
    await vite.close();
    const absolute = resolve(directory);
    if (!absolute.startsWith(`${resolve(tmpdir())}${sep}`) || !basename(absolute).startsWith('lop-frontend-test-')) throw new Error('Unexpected frontend test directory');
    rmSync(absolute, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});
