import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({ base: './', plugins: [react()], worker: { format: 'es' }, test: { testTimeout: 120000 } } as any)
