import { useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router'

/**
 * Возврат на предыдущую страницу приложения. Если страницу открыли напрямую (в истории
 * приложения до неё ничего нет), `navigate(-1)` вывел бы человека из приложения, поэтому
 * ведём на запасной адрес.
 */
export function useGoBack(fallback = '/') {
  const navigate = useNavigate()
  const { key } = useLocation()
  return useCallback(() => {
    // у первой записи истории ключ 'default'
    void (key === 'default' ? navigate(fallback, { replace: true }) : navigate(-1))
  }, [key, navigate, fallback])
}
