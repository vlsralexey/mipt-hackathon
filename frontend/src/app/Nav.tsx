import { useQuery } from '@tanstack/react-query'
import { Link, NavLink } from 'react-router'
import { api } from '../api/client'
import { Icon } from '../components/Icon'
import { navSubtitle } from '../nav-subtitle'
import styles from './Nav.module.css'

export function Nav() {
  const list = useQuery({ queryKey: ['procurements'], queryFn: api.listProcurements })

  return (
    <nav className={styles.nav} aria-label="Закупки">
      <div className={styles.lockup}>
        Co7 <span className={styles.x}>×</span> МФТИ
      </div>
      <Link to="/new" className={styles.btnNew}>
        <Icon name="plus" />
        Новая закупка
      </Link>

      <div className={styles.list}>
        {list.isPending && <p className={styles.note}>Загрузка…</p>}
        {list.isError && (
          <div className={styles.note} role="alert">
            {list.error.message}{' '}
            <button type="button" className={styles.retry} onClick={() => void list.refetch()}>
              Повторить
            </button>
          </div>
        )}
        {list.data?.length === 0 && <p className={styles.note}>Закупок пока нет</p>}
        {list.data?.map((p) => {
          const sub = navSubtitle(p)
          return (
            <NavLink key={p.id} to={`/p/${p.id}`} className={styles.item}>
              <span className={styles.title}>{p.title}</span>
              <span className={styles.sub}>
                {sub.dot && <span className={`${styles.dot} ${styles[sub.dot]}`} aria-hidden="true" />}
                {sub.text}
              </span>
            </NavLink>
          )
        })}
      </div>

      <NavLink
        to="/settings"
        className={styles.link}
        title="Ключ OpenRouter, модель, источники и правила расчёта"
      >
        <Icon name="gear" />
        Настройки
      </NavLink>
    </nav>
  )
}
