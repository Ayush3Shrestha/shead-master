import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3001);
const dataFile = process.env.DATA_FILE ?? resolve(here, '../../data/db.json');
const staticDir = process.env.STATIC_DIR ?? resolve(here, '../../client/dist');

const app = createApp({
  dataFile,
  staticDir,
  corsOrigin: process.env.CORS_ORIGIN?.split(','),
});

app.http.listen(port, () => {
  console.log(`Shithead server listening on http://localhost:${port}`);
});

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    console.log('Shutting down — refunding any running ranked games…');
    await app.close();
    process.exit(0);
  });
}
