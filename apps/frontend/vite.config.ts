import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Root .env (not apps/frontend/.env) is the documented source of
  // VITE_* variables -- see root .env.example.
  envDir: '../../',
  server: {
    port: 5173,
  },
});
