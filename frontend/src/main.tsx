import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import App from './App.tsx'
import './styles/tokens.css'
import './styles/global.css'

// Реальный API по умолчанию. Демонстрация без бэкенда: VITE_MOCKS=on npm run dev.
async function enableMocks() {
  if (import.meta.env.DEV && import.meta.env.VITE_MOCKS === 'on') {
    const { worker } = await import('./mocks/browser')
    await worker.start({ onUnhandledFrame: 'bypass', quiet: true })
  } else if ('serviceWorker' in navigator) {
    // После демонстрации старый MSW не должен перехватывать реальные запросы.
    const registrations = await navigator.serviceWorker.getRegistrations()
    await Promise.all(registrations.filter((registration) => {
      const worker = registration.active ?? registration.waiting ?? registration.installing
      return worker && new URL(worker.scriptURL).pathname === '/mockServiceWorker.js'
    }).map((registration) => registration.unregister()))
  }
}

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
