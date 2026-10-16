import { defineConfig } from 'vite';

// Two pages: the game and the track editor.
export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: 'index.html', editor: 'editor.html' },
    },
  },
});
