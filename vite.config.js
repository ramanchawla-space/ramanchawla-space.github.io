import { defineConfig } from 'vite'

// Deployed to https://ramanchawla-space.github.io/ which is a GitHub *user* site,
// served from the domain root. Hence base '/'. If this ever moves into a project
// repo (e.g. /Racing/), change this to '/Racing/' or asset URLs will 404.
export default defineConfig({
  base: '/',
  build: {
    outDir: 'dist',
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          peer: ['peerjs'],
        },
      },
    },
  },
})
