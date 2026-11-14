"""Чистые расчёты Decimal; calculate получает цены уже после выбросов.

outlier_prices сохраняет исходную выборку для медианы и коридора в API.
"""

from decimal import ROUND_HALF_UP, Decimal, localcontext
from statistics import median, quantiles

from app.config import Rules
from app.models import DomainModel, PositionStatus, Stats

CENT = Decimal(".01")


def money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def _validated(prices: list[Decimal]) -> None:
    if any(not p.is_finite() or p < 0 for p in prices):
        raise ValueError("Цены должны быть неотрицательными конечными числами")


def outlier_bounds(prices: list[Decimal], rules: Rules) -> tuple[Decimal, Decimal, Decimal, str]:
    _validated(prices)
    if not prices:
        raise ValueError("Для границ выбросов нужна непустая выборка")
    with localcontext() as context:
        context.prec = 50
        middle = median(prices)
        if len(prices) >= rules.iqr_min_n:
            q1, _, q3 = quantiles(prices, n=4, method="inclusive")
            lower, upper = q1 - rules.iqr_k * (q3 - q1), q3 + rules.iqr_k * (q3 - q1)
            text = f"IQR: [Q1 − {rules.iqr_k} × IQR; Q3 + {rules.iqr_k} × IQR]"
        else:
            lower = middle * (1 - rules.median_max_deviation)
            upper = middle * (1 + rules.median_max_deviation)
            percent = rules.median_max_deviation * 100
            text = f"Отклонение от медианы более {percent:g} %"
        return middle, lower, upper, text


def find_outliers(prices: list[Decimal], rules: Rules) -> tuple[set[int], str]:
    if not prices:
        return set(), "Выборка пуста; выбросы не определялись"
    _, lower, upper, text = outlier_bounds(prices, rules)
    return {i for i, price in enumerate(prices) if price < lower or price > upper}, text


def _moments(prices: list[Decimal]) -> tuple[Decimal, Decimal, Decimal]:
    mean = sum(prices) / len(prices)
    variance = (
        sum((price - mean) ** 2 for price in prices) / (len(prices) - 1)
        if len(prices) > 1
        else Decimal(0)
    )
    std = variance.sqrt()
    return mean, std, std / mean if mean else Decimal(0)


def compute_stats(
    prices: list[Decimal],
    rule_text: str,
    *,
    outlier_prices: list[Decimal] | None = None,
    rules: Rules | None = None,
) -> Stats:
    _validated(prices)
    if not prices:
        raise ValueError("Нельзя вычислить статистику пустой выборки")
    with localcontext() as context:
        context.prec = 50
        mean, std, cv = _moments(prices)
        middle, lower, upper, _ = outlier_bounds(
            prices if outlier_prices is None else outlier_prices, rules or Rules()
        )
        return Stats(
            n=len(prices),
            min=money(min(prices)),
            max=money(max(prices)),
            mean=money(mean),
            std=money(std),
            cv=cv.quantize(Decimal(".0001"), rounding=ROUND_HALF_UP),
            outlier_rule=rule_text,
            median=money(middle),
            lower_bound=money(lower),
            upper_bound=money(upper),
        )


class CalcResult(DomainModel):
    stats: Stats | None
    unit_price: Decimal | None
    reference_price: Decimal | None
    status: PositionStatus


def calculate(
    prices: list[Decimal],
    rules: Rules,
    *,
    outlier_prices: list[Decimal] | None = None,
) -> CalcResult:
    _validated(prices)
    if not prices:
        return CalcResult(stats=None, unit_price=None, reference_price=None, status="insufficient")
    original = prices if outlier_prices is None else outlier_prices
    _, _, _, text = outlier_bounds(original, rules)
    stats = compute_stats(prices, text, outlier_prices=original, rules=rules)
    with localcontext() as context:
        context.prec = 50
        _, _, cv = _moments(prices)
        status: PositionStatus = (
            "insufficient"
            if len(prices) < rules.min_prices
            else "heterogeneous"
            if cv > rules.cv_threshold
            else "ok"
        )
    return CalcResult(
        stats=stats,
        status=status,
        unit_price=stats.mean if status == "ok" else None,
        reference_price=stats.mean if status != "ok" else None,
    )
