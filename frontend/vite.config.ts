import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

function localPort(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a port between 1 and 65535.`);
  }
  return port;
}

const apiOrigin = `http://127.0.0.1:${localPort('ALBUM_API_PORT', 18764)}`;
const devPort = localPort('ALBUM_DEV_PORT', 5173);

export default defineConfig(({ command }) => ({
  base: command === 'serve' ? '/' : '/web/dist/',
  plugins: [
    {
      name: 'album-local-development-proxy',
      configureServer(server) {
        // Check requests before the proxy translates them to the backend origin.
        const devOrigin = `http://127.0.0.1:${server.config.server.port}`;
        server.middlewares.use((request, response, next) => {
          if (!request.url?.startsWith('/api/')) return next();
          const validHost = request.headers.host === new URL(devOrigin).host;
          const validOrigin = !request.headers.origin || request.headers.origin === devOrigin;
          if (!validHost || !validOrigin || request.headers['sec-fetch-site'] === 'cross-site') {
            response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ error: '开发接口只允许从当前本机相册页面访问。' }));
            return;
          }
          next();
        });
      },
    },
    react(),
    tailwindcss(),
  ],
  build: {
    outDir: '../web/dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, '/');
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(normalized)) return 'react-vendor';
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: devPort,
    strictPort: true,
    cors: false,
    proxy: {
      '/api/': {
        target: apiOrigin,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (forwarded, request) => {
            if (request.headers.origin) forwarded.setHeader('Origin', apiOrigin);
          });
        },
      },
    },
  },
}));
