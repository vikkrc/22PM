// Desktop app with hot reload: starts Vite, then Electron pointed at it. Ctrl+C stops both.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5173, host: '127.0.0.1' } });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`Vite at ${url}, starting Electron…`);
const electron = (await import('electron')).default;
const child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, ELECTRON_DEV_URL: url } });
child.on('exit', async (code) => { await server.close(); process.exit(code ?? 0); });
process.on('SIGINT', () => child.kill());
