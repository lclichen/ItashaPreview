import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    allowedHosts: ['.monkeycode-ai.online'],
    proxy: {
      '/removebg-api': {
        target: 'https://api.remove.bg',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/removebg-api/, '')
      }
    }
  },
  preview: {
    allowedHosts: ['.monkeycode-ai.online'],
    proxy: {
      '/removebg-api': {
        target: 'https://api.remove.bg',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/removebg-api/, '')
      }
    }
  }
});
