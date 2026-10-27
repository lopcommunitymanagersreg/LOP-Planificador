import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiPort = 3001;
let backend;
let frontend;
let stopping = false;
let startupTimer;

function stop(exitCode, message = '') {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  clearTimeout(startupTimer);
  if (message) console.error(message);

  const children = [frontend, backend].filter((child) => child && child.exitCode === null);
  if (!children.length) return;

  let remaining = children.length;
  const forceTimer = setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
  }, 5000);
  forceTimer.unref();

  for (const child of children) {
    child.once('exit', () => {
      remaining -= 1;
      if (remaining === 0) clearTimeout(forceTimer);
    });
    child.kill('SIGTERM');
  }
}

backend = spawn(process.execPath, ['-r', './server/load-env.cjs', 'server/index.js'], {
  cwd: projectRoot,
  stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
});

startupTimer = setTimeout(() => {
  stop(1, 'La API no confirmó el puerto 3001 a tiempo; se canceló el inicio.');
}, 15000);

backend.on('message', (message) => {
  if (stopping || message?.type !== 'lop-api-ready' || message.port !== apiPort || frontend) return;
  clearTimeout(startupTimer);
  console.log('API lista en el puerto fijo 3001; iniciando la interfaz.');
  frontend = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  frontend.on('error', (error) => stop(1, `No se pudo iniciar Vite: ${error.message}`));
  frontend.on('exit', (code) => {
    if (!stopping) stop(code ?? 1, 'Vite se detuvo; cerrando también la API.');
  });
});

backend.on('error', (error) => stop(1, `No se pudo iniciar la API: ${error.message}`));
backend.on('exit', (code) => {
  clearTimeout(startupTimer);
  if (!stopping) stop(code ?? 1, 'La API se detuvo; cerrando la interfaz.');
});

process.once('SIGINT', () => stop(0, 'Cerrando interfaz y API...'));
process.once('SIGTERM', () => stop(0, 'Cerrando interfaz y API...'));
