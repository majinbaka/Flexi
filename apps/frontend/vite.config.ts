import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Root .env (not apps/frontend/.env) is the documented source of
  // VITE_* variables -- see root .env.example.
  envDir: '../../',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'i18n-vendor': ['i18next', 'react-i18next'],
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // The root .env that normally supplies VITE_* is gitignored, so it does
    // not exist in CI and api-client.ts throws at import time without it.
    // Pin the value the specs already hardcode as the expected base URL
    // (src/lib/api-client.spec.ts, dynamic-tables-api.spec.ts,
    // auth/AuthContext.spec.tsx) so the suite is hermetic.
    env: {
      VITE_API_BASE_URL: 'http://localhost:3000/api',
    },
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.stories.{ts,tsx}', 'src/**/*.d.ts', 'src/test/**'],
    },
  },
});
