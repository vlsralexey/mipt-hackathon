import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Тесты проверяют время в подписях: часовой пояс фиксируем до запуска рабочих процессов.
process.env.TZ = 'Europe/Moscow'

// Бэкенд в разработке — на :8000; фронтенд всегда ходит на относительный /api.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://localhost:8000' },
    // моки читают примеры контракта из docs/api-examples
    fs: { allow: ['..'] },
  },
  test: {
    environment: './src/test/jsdom-fetch.ts',
    setupFiles: ['./src/test/setup.ts'],
    globals: false,
    css: false,
  },
})
