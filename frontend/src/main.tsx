import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import App from './App.tsx'
import './styles/tokens.css'
import './styles/global.css'
import { applyTheme, loadTheme } from './theme'

// Пока бэкенд не готов, в разработке отвечают моки из docs/api-examples.
// Отключить: VITE_MOCKS=off npm run dev.
async function enableMocks() {
  if (import.meta.env.DEV && import.meta.env.VITE_MOCKS !== 'off') {
    const { worker } = await import('./mocks/browser')
    await worker.start({ onUnhandledFrame: 'bypass', quiet: true })
  }
}

applyTheme(loadTheme())

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
})

void enableMocks().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  )
})
