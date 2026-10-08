from __future__ import annotations

import os
from pathlib import Path

import certifi
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def configure() -> None:
    """Load project-local keys without replacing values supplied by the caller."""
    load_dotenv(PROJECT_ROOT / ".env.local")
    load_dotenv(PROJECT_ROOT / ".env")
    # python.org's macOS builds may have no default CA bundle. Keep TLS verified.
    os.environ.setdefault("SSL_CERT_FILE", certifi.where())


def required_key(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not configured")
    return value


def safe_error(error: BaseException) -> str:
    message = str(error)
    for name in ("REACTOR_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"):
        value = os.environ.get(name)
        if value:
            message = message.replace(value, "[redacted]")
    return message


def runtime_root() -> Path:
    return Path(os.environ.get("TASK_ROOMS_HOME", PROJECT_ROOT / ".task-rooms")).resolve()
