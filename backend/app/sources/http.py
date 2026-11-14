"""Дополнительный CA применяется только к хосту ЕИС, не ко всему процессу."""

import ssl
from pathlib import Path

import httpx

ROOT_CA = Path(__file__).parents[1] / "certs" / "russian_trusted_root_ca.pem"


def eis_ssl_context() -> ssl.SSLContext:
    context = ssl.create_default_context()
    context.load_verify_locations(cafile=ROOT_CA)
    return context


def source_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=20,
        mounts={"https://zakupki.gov.ru": httpx.AsyncHTTPTransport(verify=eis_ssl_context())},
    )
