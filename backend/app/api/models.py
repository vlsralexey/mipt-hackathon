"""Публичные модели REST и карточек чата из docs/api.md."""

from typing import Annotated, Literal

from pydantic import AwareDatetime, Field, model_serializer

from app.models import (
    DomainModel,
    Money,
    PositiveDec,
    Proposal,
    Question,
    SourceStatus,
    VersionDiff,
)


class SettingsView(DomainModel):
    has_api_key: bool
    key_source: Literal["settings", "env"] | None
    model: str


class SettingsUpdate(DomainModel):
    openrouter_api_key: str | None = None
    model: str | None = Field(default=None, min_length=1, max_length=200)


class MessageInput(DomainModel):
    text: str = Field(min_length=1, max_length=50000, pattern=r"\S")
    viewing_version: int | None = Field(default=None, ge=1)


class AnswerInput(DomainModel):
    answer: str = Field(min_length=1, max_length=10000, pattern=r"\S")


class CancelInput(DomainModel):
    edit_ids: list[str] = Field(min_length=1)


class FileData(DomainModel):
    filename: str
    size_bytes: int = Field(ge=0)


class PositionSummary(DomainModel):
    index: int = Field(ge=1)
    name: str
    quantity: PositiveDec
    unit: str


class TzSummary(DomainModel):
    title: str
    positions: list[PositionSummary]


class RunStep(DomainModel):
    source_id: str
    name: str
    level: Literal[1, 2]
    position_index: int = Field(ge=1)
    status: Literal["queued", "running"] | SourceStatus
    found: int = Field(ge=0)
    relevant: int | None = Field(default=None, ge=0)
    note: str | None = None


class RunState(DomainModel):
    run_id: str
    kind: Literal["full", "targeted", "user"]
    state: Literal["running", "done", "failed"]
    summary: str
    position_indexes: list[int]
    started_at: AwareDatetime
    finished_at: AwareDatetime | None = None
    steps: list[RunStep] = Field(default_factory=list)


class VersionCard(DomainModel):
    version: int
    cause: str
    diff: VersionDiff
    edit_ids: list[str]
    cancellable: bool


class ErrorData(DomainModel):
    code: Literal["llm_auth", "llm_unavailable", "tz_parse_failed", "internal"]


class SourceBlocked(DomainModel):
    source_id: str
    name: str
    url: str
    reason: Literal["captcha", "login"]
    status: Literal["waiting", "resolved", "skipped"]


class MessageBase(DomainModel):
    @model_serializer(mode="wrap")
    def public_strings(self, handler, info):
        from app.presentation import public_text

        data = handler(self)
        return public_text(data) if info.mode == "json" else data

    id: str
    created_at: AwareDatetime
    role: Literal["user", "agent", "system"]
    text: str | None = None


class TextMessage(MessageBase):
    kind: Literal["text"] = "text"
    data: None = None


class FileMessage(MessageBase):
    kind: Literal["file"] = "file"
    data: FileData


class SummaryMessage(MessageBase):
    kind: Literal["tz_summary"] = "tz_summary"
    data: TzSummary


class QuestionMessage(MessageBase):
    kind: Literal["question"] = "question"
    data: Question


class RunMessage(MessageBase):
    kind: Literal["run"] = "run"
    data: RunState


class VersionMessage(MessageBase):
    kind: Literal["version"] = "version"
    data: VersionCard


class ErrorMessage(MessageBase):
    kind: Literal["error"] = "error"
    data: ErrorData


class ProposalMessage(MessageBase):
    kind: Literal["proposal"] = "proposal"
    data: Proposal


class BlockedMessage(MessageBase):
    kind: Literal["source_blocked"] = "source_blocked"
    data: SourceBlocked


Message = Annotated[
    TextMessage
    | FileMessage
    | SummaryMessage
    | QuestionMessage
    | RunMessage
    | VersionMessage
    | ErrorMessage
    | ProposalMessage
    | BlockedMessage,
    Field(discriminator="kind"),
]


class ProcurementSummary(DomainModel):
    @model_serializer(mode="wrap")
    def public_strings(self, handler, info):
        from app.presentation import public_text

        data = handler(self)
        return public_text(data) if info.mode == "json" else data

    id: str
    title: str
    created_at: AwareDatetime
    updated_at: AwareDatetime
    status: Literal["new", "running", "needs_user", "ready", "failed"]
    latest_version: int | None = None
    total: Money | None = None
    total_justified: Money | None = None
    positions_total: int = 0
    positions_unjustified: int = 0


class Procurement(ProcurementSummary):
    filename: str | None = None
    agent_busy: bool = False
    messages: list[Message] = Field(default_factory=list)


class VersionInfo(DomainModel):
    version: int
    created_at: AwareDatetime
    cause: str
    total: Money | None
    total_justified: Money | None
