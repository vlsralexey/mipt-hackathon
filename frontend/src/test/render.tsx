import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import App from '../App'

/** Рендерит приложение целиком на заданном маршруте, как в браузере. */
export function renderApp(route: string | string[] = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={Array.isArray(route) ? route : [route]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
