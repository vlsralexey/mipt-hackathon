import { Outlet } from 'react-router'
import { Nav } from './Nav'
import styles from './AppShell.module.css'

/** Каркас экрана: слева навигация, справа рабочая область выбранного маршрута. */
export function AppShell() {
  return (
    <div className={styles.app}>
      <Nav />
      <Outlet />
    </div>
  )
}
