import styles from './ProcurementPage.module.css'

/** Рабочая область без выбранной закупки. */
export function EmptyWorkspace() {
  return (
    <div className={styles.state}>
      <h1>Выберите закупку</h1>
      <p>Откройте закупку из списка слева или начните новую.</p>
    </div>
  )
}
