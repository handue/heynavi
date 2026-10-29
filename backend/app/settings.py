"""Backend configuration, loaded from environment variables and backend/.env."""

from __future__ import annotations

import logging
import re
import sys
from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr, ValidationError, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[1]
# Resolved from this file, not the cwd, so the server, tests and bench all find the same file.
ENV_FILE = BACKEND_DIR / ".env"
EXIT_INVALID_SETTINGS = 2
# Keys and tokens go into HTTP headers: printable ASCII only, so a pasted line break,
# inner space or non-ASCII character fails at startup instead of inside an HTTP library.
_SECRET_CHARS = re.compile(r"[\x21-\x7e]+")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        # "MODEL_API_KEY=" (empty, as in .env.example) means "not set", not an empty key.
        env_ignore_empty=True,
        extra="ignore",
        # Never echo a rejected value (it may be the key) in ValidationError text.
        hide_input_in_errors=True,
    )

    # repr=False keeps secrets out of repr()/str() entirely; SecretStr masks them in dumps.
    model_api_key: SecretStr | None = Field(default=None, repr=False)
    meta_api_base_url: str = "https://api.meta.ai/v1"
    sam_model: str = "sam-3.1"
    spark_model: str = "muse-spark-1.3"
    spark_reasoning_effort: str = "minimal"
    meta_timeout_seconds: float = Field(default=20.0, gt=0)
    heynavi_app_token: SecretStr | None = Field(default=None, repr=False)
    log_level: str = "INFO"

    @field_validator("model_api_key", "heynavi_app_token")
    @classmethod
    def _clean_secret(cls, value: SecretStr | None) -> SecretStr | None:
        if value is None:
            return None
        cleaned = value.get_secret_value().strip()
        if not cleaned:
            return None  # blank means "not set", as with an empty line in .env
        if _SECRET_CHARS.fullmatch(cleaned) is None:
            # The message must never contain the value itself.
            raise ValueError(
                "must contain only printable ASCII characters, with no spaces, line breaks "
                "or non-ASCII characters inside it (copy it again and re-paste it)"
            )
        return SecretStr(cleaned)

    @field_validator("log_level")
    @classmethod
    def _upper_log_level(cls, value: str) -> str:
        level = value.strip().upper()
        if level not in logging.getLevelNamesMapping():
            raise ValueError(f"unknown log level {value!r}")
        return level

    @property
    def key_configured(self) -> bool:
        return _has_value(self.model_api_key)

    @property
    def app_token_configured(self) -> bool:
        return _has_value(self.heynavi_app_token)


def _has_value(secret: SecretStr | None) -> bool:
    return secret is not None and bool(secret.get_secret_value().strip())


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def invalid_settings_message(exc: ValueError) -> str:
    """Names the env file and each bad setting, never the rejected value."""
    lines = [f"invalid setting in {ENV_FILE} (or in your shell environment):"]
    if isinstance(exc, ValidationError):
        for error in exc.errors(include_url=False, include_context=False, include_input=False):
            name = ".".join(str(part) for part in error["loc"]).upper() or "settings"
            lines.append(f"  {name}: {error['msg']}")
    else:
        lines.append(f"  {type(exc).__name__}")
    lines.append("  Fix that line in the file above, then run the command again.")
    return "\n".join(lines)


def load_settings_or_exit() -> Settings:
    """get_settings() for process entry points: an invalid value ends the process with
    exit code 2 and a message naming the env file, instead of a traceback."""
    try:
        return get_settings()
    except ValueError as exc:  # pydantic's ValidationError is a ValueError
        message = invalid_settings_message(exc)
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(EXIT_INVALID_SETTINGS)
