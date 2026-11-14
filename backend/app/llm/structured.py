"""Pydantic-схемы без необязательных полей для strict structured outputs."""

import json

from pydantic import BaseModel, ValidationError

from app.llm.client import LLM, LLMFormatError


def strict_schema(model: type[BaseModel]) -> dict:
    schema = model.model_json_schema()

    def visit(node):
        if isinstance(node, dict):
            node.pop("default", None)
            if node.get("type") == "object":
                node["additionalProperties"] = False
                node["required"] = list(node.get("properties", {}))
            for child in node.values():
                visit(child)
        elif isinstance(node, list):
            for child in node:
                visit(child)

    visit(schema)
    return schema


async def complete_model[T: BaseModel](llm: LLM, system: str, data, model: type[T], name: str) -> T:
    try:
        raw = await llm.complete_json(
            system, json.dumps(data, ensure_ascii=False, default=str), name, strict_schema(model)
        )
        return model.model_validate(raw)
    except (ValidationError, ValueError, TypeError) as exc:
        raise LLMFormatError("Ответ модели не соответствует структуре данных") from exc
