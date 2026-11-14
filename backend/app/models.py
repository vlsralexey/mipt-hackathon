"""Доменные данные P0; публичный отчёт соответствует docs/api.md.

Исходный Offer хранится отдельно от результатов нормализации и правок. Money
округляется только при JSON-сериализации; исходная цена ЕИС внутри не теряет дробь.
"""

import re
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Annotated, Any, Literal

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    PlainSerializer,
    model_serializer,
    model_validator,
)

Money = Annotated[
    Decimal,
    Field(ge=0, allow_inf_nan=False),
    PlainSerializer(
        lambda v: format(v.quantize(Decimal(".01"), rounding=ROUND_HALF_UP), ".2f"),
        return_type=str,
        when_used="json",
    ),
]
PositiveDec = Annotated[Decimal, Field(gt=0, allow_inf_nan=False)]
Level = Literal[1, 2]
ExclusionReason = Literal[
    "anomalous_price",
    "incomparable",
    "unit_mismatch",
    "insufficient_data",
    "duplicate",
    "same_supplier",
    "user_excluded",
]
PositionStatus = Literal["ok", "insufficient", "heterogeneous"]
SourceStatus = Literal["ok", "empty", "unavailable", "error", "needs_login", "skipped"]


class DomainModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, revalidate_instances="always")


class Characteristic(DomainModel):
    name: str
    value: str
    unit: str | None = None
    essential: bool = True


class Basis(DomainModel):
    unit: str = Field(min_length=1)
    per_tz_unit: PositiveDec = Decimal(1)


class Position(DomainModel):
    index: int = Field(ge=1)
    name: str
    unit: str
    quantity: PositiveDec
    okpd2: str | None = None
    characteristics: list[Characteristic] = Field(default_factory=list)
    basis: Basis
    search_terms: list[str] = Field(default_factory=list)


ANALOGS_YES = "Да, учитывать аналоги"


def asks_about_analogs(text: str) -> bool:
    return any(word in text.casefold() for word in ("аналог", "эквивалент"))


# Варианты, которые по смыслу оставляют только марку из ТЗ: «Нет, только X», «Только X»,
# «Без аналогов», «Не допускаются». Модель не всегда начинает такой вариант со слова «Нет».
_BRAND_ONLY = re.compile(
    r"(нет|только)\b|без\s+(аналог|эквивалент|замен)|не\s+(допуска|учитыва|рассматрива)"
)


def analog_choice(answer: str) -> Literal["yes", "no"] | None:
    """«Да…» допускает аналоги, «Нет…»/«Только…» оставляет марку ТЗ; иначе решает модель."""
    normalized = answer.strip().casefold()
    if re.match(r"да\b", normalized):
        return "yes"
    if _BRAND_ONLY.match(normalized):
        return "no"
    return None


def analog_options(options: list[str], brand: str | None = None) -> list[str]:
    """У вопроса об аналогах всегда есть оба стандартных варианта, которые применяются без LLM."""
    choices = {analog_choice(option) for option in options}
    result = list(options)
    if "no" not in choices:
        result.insert(0, f"Нет, только {brand}" if brand else "Нет, только указанная марка")
    if "yes" not in choices:
        result.append(ANALOGS_YES)
    return result


class Question(DomainModel):
    id: str
    position_index: int = Field(ge=1)
    text: str
    hint: str | None = None
    options: list[str]
    default_answer: str
    answer: str | None = None

    @model_validator(mode="after")
    def default_is_option(self):
        # Модель могла вернуть вопрос об аналогах с одним вариантом; такие вопросы уже
        # сохранены в закупках, поэтому дополняем варианты и при чтении.
        if asks_about_analogs(self.text):
            self.options = analog_options(self.options)
        if self.default_answer not in self.options:
            raise ValueError("Ответ по умолчанию должен входить в варианты ответа")
        return self


class ParsedTZ(DomainModel):
    title: str
    positions: list[Position]
    questions: list[Question] = Field(default_factory=list)
    delivery_terms: str | None = None
    delivery_extras: list[str] = Field(default_factory=list)


class Offer(DomainModel):
    id: str
    source_id: str
    source_name: str
    level: Level
    url: str
    retrieved_at: AwareDatetime
    title: str
    price: Money
    currency: Literal["RUB"] = "RUB"
    amount: PositiveDec
    amount_unit: str = Field(min_length=1)
    vat: Literal["included", "excluded", "exempt", "unknown"] = "unknown"
    vat_rate: Decimal | None = Field(default=None, ge=0, le=Decimal(".3"))
    supplier: str | None = None
    supplier_inn: str | None = None
    delivery: Literal["included", "separate", "unknown"] = "unknown"
    delivery_cost: Money | None = None
    delivery_free_from: Money | None = None
    delivery_note: str | None = None
    price_date: date | None = None
    characteristics: dict[str, str] = Field(default_factory=dict)


class VatResolution(DomainModel):
    status: Literal["included", "added", "exempt", "unknown"]
    factor: PositiveDec = Decimal(1)
    note: str


class IndexResolution(DomainModel):
    status: Literal["applied", "not_needed", "no_data"]
    factor: PositiveDec = Decimal(1)
    note: str


class DeliveryResolution(DomainModel):
    status: Literal["included", "added", "unknown"]
    added_per_unit: Money = Decimal(0)
    note: str


class CharComparison(DomainModel):
    name: str
    required: str
    offered: str | None = None
    essential: bool
    ok: bool | None = None


class OfferEntry(DomainModel):
    label: str = ""
    caption: str = ""
    offer: Offer
    base_price: Money | None = None
    vat: VatResolution | None = None
    indexation: IndexResolution | None = None
    delivery: DeliveryResolution | None = None
    normalized_price: Money | None = None
    comparison: list[CharComparison] = Field(default_factory=list)
    reason: str
    exclusion: ExclusionReason | None = None
    original: dict[str, str] | None = None
    user_marks: list[Literal["corrected", "added", "excluded", "excluded_by_price", "included"]] = (
        Field(default_factory=list)
    )


class SkippedPage(DomainModel):
    url: str
    source_id: str
    reason: str


class Stats(DomainModel):
    n: int = Field(ge=1)
    min: Money
    max: Money
    mean: Money
    std: Money
    cv: Decimal = Field(ge=0)
    outlier_rule: str
    median: Money
    # IQR может дать отрицательную нижнюю границу.
    lower_bound: (
        Annotated[
            Decimal,
            PlainSerializer(
                lambda v: format(v.quantize(Decimal(".01"), rounding=ROUND_HALF_UP), ".2f"),
                return_type=str,
                when_used="json",
            ),
        ]
        | None
    ) = None
    upper_bound: Money | None = None


class SourceRun(DomainModel):
    source_id: str
    name: str
    level: Level
    position_index: int = Field(ge=1)
    queries: list[str] = Field(default_factory=list)
    status: SourceStatus
    error: str | None = None
    found: int = Field(ge=0)
    at: AwareDatetime


class PositionReport(DomainModel):
    position: Position
    status: PositionStatus
    levels_used: list[Level] = Field(default_factory=list)
    included: list[OfferEntry] = Field(default_factory=list)
    excluded: list[OfferEntry] = Field(default_factory=list)
    stats: Stats | None = None
    unit_price: Money | None = None
    reference_price: Money | None = None
    total: Money | None = None
    assumptions: list[str] = Field(default_factory=list)
    spread_hints: list[str] = Field(default_factory=list)
    skipped_pages: list[SkippedPage] = Field(default_factory=list)
    excluded_by_user: bool = False


EditKind = Literal[
    "exclude",
    "include",
    "correct_offer",
    "answer_question",
    "add_offer",
    "exclude_where",
    "edit_position",
    "local_setting",
    "rebase_settings",
    "exclude_position",
]


class EditBase(DomainModel):
    id: str
    seq: int = Field(ge=1)
    created_at: AwareDatetime
    position_index: int | None = Field(default=None, ge=1)
    target: str | None = None
    reason: str
    reason_kind: (
        Literal["characteristics", "source", "date", "supplier", "price", "other"] | None
    ) = None
    origin: Literal["chat", "button"]
    status: Literal["active", "cancelled", "superseded"]
    summary: str


class OfferTarget(DomainModel):
    offer_id: str = Field(min_length=1)


class CorrectOfferPayload(OfferTarget):
    field: Literal[
        "price",
        "amount",
        "amount_unit",
        "vat",
        "vat_rate",
        "delivery",
        "delivery_cost",
        "delivery_free_from",
        "price_date",
        "supplier",
        "supplier_inn",
    ]
    value: str | Decimal | date | None

    @model_validator(mode="after")
    def validate_corrected_value(self):
        from app.units import canonical_unit, parse_price

        value = self.value
        if self.field in {"price", "amount", "delivery_cost", "delivery_free_from"}:
            if isinstance(value, str):
                value = parse_price(value)
        if self.field == "amount_unit" and isinstance(value, str):
            value = canonical_unit(value)
        # Те же ограничения, что у исходного предложения. В исходные данные не пишем.
        candidate = {
            "id": "validation",
            "source_id": "user",
            "source_name": "Пользователь",
            "level": 1,
            "url": "",
            "retrieved_at": "2000-01-01T00:00:00Z",
            "title": "",
            "price": "1",
            "amount": "1",
            "amount_unit": "шт",
            self.field: value,
        }
        if self.field == "supplier_inn" and self.value is not None:
            value = str(self.value)
            if not value.isascii() or not value.isdigit() or len(value) not in (10, 12):
                raise ValueError("ИНН должен состоять из 10 или 12 цифр")
        validated = Offer.model_validate(candidate)
        value = getattr(validated, self.field)
        self.value = str(value) if isinstance(value, Decimal) else value
        return self


class AnswerPayload(DomainModel):
    question_id: str = Field(min_length=1)
    answer: str = Field(min_length=1)
    position: Position
    previous_position: Position | None = None


class ExcludeEdit(EditBase):
    kind: Literal["exclude"]
    payload: OfferTarget


class IncludeEdit(EditBase):
    kind: Literal["include"]
    payload: OfferTarget


class CorrectOfferEdit(EditBase):
    kind: Literal["correct_offer"]
    payload: CorrectOfferPayload


class AnswerQuestionEdit(EditBase):
    kind: Literal["answer_question"]
    payload: AnswerPayload


class OfferFilter(DomainModel):
    source_ids: list[str] = Field(default_factory=list)
    levels: list[Level] = Field(default_factory=list)
    price_date_before: date | None = None
    price_date_after: date | None = None
    normalized_price_above: Money | None = None
    normalized_price_below: Money | None = None
    vat_status: list[Literal["included", "added", "exempt", "unknown"]] = Field(
        default_factory=list
    )
    delivery_status: list[Literal["included", "added", "unknown"]] = Field(default_factory=list)
    supplier: str | None = None


class ExcludeWherePayload(DomainModel):
    position_index: int | None = Field(default=None, ge=1)
    filter: OfferFilter

    @model_validator(mode="after")
    def price_filter_requires_position(self):
        if self.position_index is None and (
            self.filter.normalized_price_above is not None
            or self.filter.normalized_price_below is not None
        ):
            raise ValueError("Ценовой фильтр допустим только для одной позиции")
        return self


class AddOfferPayload(DomainModel):
    run_id: str


class EditPositionPayload(DomainModel):
    field: str
    value: str | bool | Decimal

    @model_validator(mode="after")
    def validate_position_value(self):
        from app.units import parse_price

        if self.field == "quantity":
            if isinstance(self.value, bool):
                raise ValueError("Количество должно быть положительным числом")
            amount = parse_price(str(self.value))
            if amount <= 0:
                raise ValueError("Количество должно быть положительным числом")
            self.value = amount
        elif self.field.startswith("essential:"):
            if not self.field.partition(":")[2].strip() or not isinstance(self.value, bool):
                raise ValueError("Существенность характеристики должна быть true или false")
        elif self.field == "name" or self.field.startswith("characteristic:"):
            if not isinstance(self.value, str) or not self.value.strip():
                raise ValueError("Укажите непустое название или значение характеристики")
            if self.field != "name" and not self.field.partition(":")[2].strip():
                raise ValueError("Укажите название характеристики")
        else:
            raise ValueError("Недопустимое поле позиции")
        return self


class LocalSettingPayload(DomainModel):
    key: str
    value: Any


class RebasePayload(DomainModel):
    rules: dict[str, Any]
    cpi: dict[str, Decimal]
    calc_date: date | None = None


class AddOfferEdit(EditBase):
    kind: Literal["add_offer"]
    payload: AddOfferPayload


class ExcludeWhereEdit(EditBase):
    kind: Literal["exclude_where"]
    payload: ExcludeWherePayload


class EditPositionEdit(EditBase):
    kind: Literal["edit_position"]
    payload: EditPositionPayload


class LocalSettingEdit(EditBase):
    kind: Literal["local_setting"]
    payload: LocalSettingPayload


class RebaseSettingsEdit(EditBase):
    kind: Literal["rebase_settings"]
    payload: RebasePayload


class ExcludePositionEdit(EditBase):
    kind: Literal["exclude_position"]
    payload: dict[str, Any] = Field(default_factory=dict)


Edit = Annotated[
    ExcludeEdit
    | IncludeEdit
    | CorrectOfferEdit
    | AnswerQuestionEdit
    | AddOfferEdit
    | ExcludeWhereEdit
    | EditPositionEdit
    | LocalSettingEdit
    | RebaseSettingsEdit
    | ExcludePositionEdit,
    Field(discriminator="kind"),
]


class AppliedEdit(DomainModel):
    edit: Edit
    applied: bool
    effect: str


class Report(DomainModel):
    @model_serializer(mode="wrap")
    def public_strings(self, handler, info):
        from app.presentation import public_text

        data = handler(self)
        return public_text(data) if info.mode == "json" else data

    procurement_id: str
    version: int = Field(ge=1)
    created_at: AwareDatetime
    title: str
    calc_date: date
    methodology: str
    cause: str
    positions: list[PositionReport]
    sources: list[SourceRun] = Field(default_factory=list)
    questions: list[Question] = Field(default_factory=list)
    delivery_terms: str | None = None
    delivery_extras: list[str] = Field(default_factory=list)
    total: Money | None = None
    total_justified: Money | None = None
    warnings: list[str] = Field(default_factory=list)
    edits: list[AppliedEdit] = Field(default_factory=list)
    rules: dict[str, Any] = Field(default_factory=dict)
    local_settings: list[str] = Field(default_factory=list)


class DeliveryPolicy(DomainModel):
    included: bool = False
    free_from: Money | None = None
    note: str | None = None


class SourcePolicy(DomainModel):
    vat_default: Literal["included", "unknown"] = "unknown"
    vat_note: str | None = None
    price_final: bool = False
    delivery: DeliveryPolicy = Field(default_factory=DeliveryPolicy)


class FoundOffer(DomainModel):
    offer: Offer
    policy: SourcePolicy
    comparison: list[CharComparison] = Field(default_factory=list)

    @model_serializer(mode="wrap")
    def keep_raw_prices(self, handler, info):
        data = handler(self)
        if info.mode == "json":
            # Внутренний результат поиска должен пережить запись в БД без округления.
            # Публичный OfferEntry по-прежнему отдаёт Money с двумя знаками.
            for field in ("price", "delivery_cost", "delivery_free_from"):
                value = getattr(self.offer, field)
                data["offer"][field] = str(value) if value is not None else None
        return data


class ResearchRun(DomainModel):
    id: str
    procurement_id: str
    position_index: int = Field(ge=1)
    created_at: AwareDatetime
    kind: Literal["full", "targeted", "user"]
    offers: list[FoundOffer] = Field(default_factory=list)
    skipped_pages: list[SkippedPage] = Field(default_factory=list)
    sources: list[SourceRun] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)


class Change[T](DomainModel):
    before: T | None
    after: T | None


class PositionChange(DomainModel):
    index: int = Field(ge=1)
    name: str
    status: Change[PositionStatus]
    unit_price: Change[Money]
    n: Change[int]
    cv: Change[Decimal]


class OfferMove(DomainModel):
    offer_id: str
    label: str
    caption: str
    position_index: int = Field(ge=1)
    to: Literal["included", "excluded"]
    reason: str


class RuleChange(DomainModel):
    key: str
    title: str
    before: str
    after: str


class VersionDiff(DomainModel):
    from_version: int | None
    to_version: int = Field(ge=1)
    total: Change[Money]
    total_justified: Change[Money]
    positions: list[PositionChange] = Field(default_factory=list)
    offers_moved: list[OfferMove] = Field(default_factory=list)
    edits_added: list[str] = Field(default_factory=list)
    edits_cancelled: list[str] = Field(default_factory=list)
    rules_changed: list[RuleChange] = Field(default_factory=list)


class Proposal(DomainModel):
    id: str
    text: str
    diff: VersionDiff
    status: Literal["pending", "applied", "rejected", "expired"]


class ConfigChange(DomainModel):
    id: str
    created_at: AwareDatetime
    path: str
    title: str
    before: str
    after: str
    reason: str
    status: Literal["active", "cancelled"]


class ConfigProposal(DomainModel):
    id: str
    created_at: AwareDatetime
    path: str
    value: Any
    reason: str
    turn_id: str
    status: Literal["pending", "applied", "rejected", "expired"]
