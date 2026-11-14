import type { OfferEntry } from '../api/types'
import { formatMoney, formatNumber } from '../format'

const isZero = (money: string) => Number(money) === 0

/**
 * Как цена на странице стала расчётной: строки для раскрывающегося блока (docs/api.md §5.4).
 * Множители «1» и нулевую доставку не показываем, если нечего пояснять.
 */
export function priceSteps(entry: OfferEntry): string[] {
  const { offer, base_price, vat, indexation, delivery, normalized_price } = entry
  const steps = [
    `На странице: ${formatMoney(offer.price)} за ${formatNumber(offer.amount)} ${offer.amount_unit}`,
  ]
  if (base_price !== null) steps.push(`За единицу ТЗ: ${formatMoney(base_price)}`)
  if (vat && (vat.factor !== '1' || vat.status === 'unknown')) steps.push(`НДС: ${vat.note}`)
  if (indexation && (indexation.factor !== '1' || indexation.status === 'no_data')) {
    steps.push(`Индексация: ${indexation.note}`)
  }
  if (delivery && (!isZero(delivery.added_per_unit) || delivery.status === 'unknown')) {
    const added = isZero(delivery.added_per_unit) ? '' : ` (+${formatMoney(delivery.added_per_unit)})`
    steps.push(`Доставка: ${delivery.note}${added}`)
  }
  if (normalized_price !== null) steps.push(`Расчётная цена: ${formatMoney(normalized_price)}`)
  return steps
}
