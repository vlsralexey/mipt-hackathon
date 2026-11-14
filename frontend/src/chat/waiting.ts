import { plural } from '../plural'

/** Сколько вопросов ждут ответа: «1 вопрос ждёт», «2 вопроса ждут», «5 вопросов ждут». */
export function waitingLabel(n: number): string {
  return `${n} ${plural(n, 'вопрос ждёт', 'вопроса ждут', 'вопросов ждут')} ответа`
}
