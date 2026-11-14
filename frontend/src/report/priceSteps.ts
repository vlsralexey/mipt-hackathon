import type { OfferEntry } from '../api/types'
import { formatMoney, formatNumber, tidyText } from '../format'

export interface PriceStep {
  label: string
  text: string
  /** Шаг меняет цену (множитель не 1 или добавлена доставка): выделяем. */
  changes: boolean
}

const isZero = (money: string) => Number(money) === 0

/**
 * Как цена на странице стала расчётной: страница → единица ТЗ → НДС → индексация → доставка → итог
 * (docs/api.md §5.4). Нейтральные шаги тоже показываем: так видно, что их проверили.
 */
export function priceSteps(entry: OfferEntry): { steps: PriceStep[]; total: string | null } {
  const { offer, base_price, vat, indexation, delivery, normalized_price } = entry
  const steps: PriceStep[] = [
    {
      label: 'На странице',
      text: `${formatMoney(offer.price)} за ${formatNumber(offer.amount)} ${offer.amount_unit}`,
      changes: false,
    },
  ]
  if (base_price !== null && (Number(offer.amount) !== 1 || base_price !== offer.price)) {
    steps.push({ label: 'За единицу ТЗ', text: formatMoney(base_price), changes: true })
  }
  if (vat) steps.push({ label: 'НДС', text: tidyText(vat.note), changes: vat.factor !== '1' })
  if (indexation) {
    steps.push({ label: 'Индексация', text: tidyText(indexation.note), changes: indexation.factor !== '1' })
  }
  if (delivery) {
    const added = isZero(delivery.added_per_unit) ? '' : ` (+${formatMoney(delivery.added_per_unit)})`
    steps.push({ label: 'Доставка', text: `${tidyText(delivery.note)}${added}`, changes: added !== '' })
  }
  return { steps, total: normalized_price === null ? null : formatMoney(normalized_price) }
}
