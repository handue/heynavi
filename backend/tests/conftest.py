from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from app.settings import Settings, get_settings

TEST_KEY = "LLM_test_secret_key_do_not_leak_123"
BASE_URL = "https://api.meta.ai/v1"
# Captured before any test patches it.
ORIGINAL_ENV_FILE = Settings.model_config.get("env_file")


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Keep the developer's shell variables and real backend/.env out of every test."""
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    for name in Settings.model_fields:
        monkeypatch.delenv(name.upper(), raising=False)
        monkeypatch.delenv(name, raising=False)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def make_settings(**overrides: Any) -> Settings:
    """Settings that never read backend/.env, and never write usage or metrics files unless a
    test passes its own paths."""
    defaults: dict[str, Any] = {"usage_file": None, "metrics_file": None}
    return Settings(_env_file=None, **{**defaults, **overrides})  # type: ignore[call-arg]
