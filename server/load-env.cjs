const path = require('node:path');
const dotenv = require('dotenv');

const envPath = path.resolve(__dirname, '..', '.env');
const result = dotenv.config({ path: envPath });

if (result.error && result.error.code !== 'ENOENT') {
  throw new Error(`No se pudo cargar la configuración local: ${result.error.message}`);
}

// Local development keeps its known credentials; production preserves injected secrets.
if (process.env.NODE_ENV !== 'production') {
  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']) {
    if (Object.hasOwn(result.parsed || {}, key)) {
      process.env[key] = result.parsed[key];
    }
  }
}
