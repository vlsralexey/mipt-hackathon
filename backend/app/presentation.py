"""Пунктуация публичных текстов; идентификаторы и ссылки остаются исходными."""


def public_text(value):
    if isinstance(value, str):
        return value.replace("—", ":").replace("–", "-")
    if isinstance(value, list):
        return [public_text(item) for item in value]
    if isinstance(value, dict):
        identity = {
            "id",
            "offer_id",
            "source_id",
            "procurement_id",
            "run_id",
            "url",
            "filename",
            "original",
        }
        return {key: item if key in identity else public_text(item) for key, item in value.items()}
    return value
