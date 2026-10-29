from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from app.main import create_app
from app.settings import (
    BACKEND_DIR,
    ENV_FILE,
    Settings,
    get_settings,
    invalid_settings_message,
    load_settings_or_exit,
)
from tests.conftest import ORIGINAL_ENV_FILE, TEST_KEY, make_settings

SECRET_PART = "LLM_leakcheck_secret_987"
BAD_SECRETS = [
    f"{SECRET_PART} tail",  # inner space
    f"{SECRET_PART}\ntail",  # pasted line break
    f"{SECRET_PART}\x01",  # control character
    f"{SECRET_PART}é",  # non-ASCII
    f"{SECRET_PART}\u00a0tail",  # non-breaking space inside
]


def test_env_file_is_resolved_from_backend_dir_not_cwd() -> None:
    assert ENV_FILE == BACKEND_DIR / ".env"
    assert (BACKEND_DIR / "pyproject.toml").is_file()
    assert ORIGINAL_ENV_FILE == ENV_FILE


def test_defaults_without_env() -> None:
    s = make_settings()
    assert s.key_configured is False
    assert s.app_token_configured is False
    assert s.meta_api_base_url == "https://api.meta.ai/v1"
    assert (s.sam_model, s.spark_model, s.spark_reasoning_effort) == ("sam-3.1", "muse-spark-1.3", "minimal")
    assert s.meta_timeout_seconds == 20.0
    assert s.log_level == "INFO"


def test_loads_from_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MODEL_API_KEY", TEST_KEY)
    monkeypatch.setenv("META_TIMEOUT_SECONDS", "7.5")
    monkeypatch.setenv("SPARK_REASONING_EFFORT", "low")
    monkeypatch.setenv("LOG_LEVEL", "debug")
    s = make_settings()
    assert s.key_configured is True
    assert s.model_api_key is not None and s.model_api_key.get_secret_value() == TEST_KEY
    assert s.meta_timeout_seconds == 7.5
    assert s.spark_reasoning_effort == "low"
    assert s.log_level == "DEBUG"


def test_loads_from_env_file(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    env.write_text(f"MODEL_API_KEY={TEST_KEY}\nHEYNAVI_APP_TOKEN=tok\nSOMETHING_ELSE=ignored\n")
    s = Settings(_env_file=env)  # type: ignore[call-arg]
    assert s.key_configured and s.app_token_configured


def test_empty_values_from_env_example_mean_unset(tmp_path: Path) -> None:
    example = BACKEND_DIR / ".env.example"
    s = Settings(_env_file=example)  # type: ignore[call-arg]
    assert s.key_configured is False
    assert s.heynavi_app_token is None
    assert s.sam_model == "sam-3.1"


def test_whitespace_key_is_not_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MODEL_API_KEY", "   ")
    assert make_settings().key_configured is False


def test_secret_is_not_exposed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MODEL_API_KEY", TEST_KEY)
    monkeypatch.setenv("HEYNAVI_APP_TOKEN", "app-token-secret")
    s = make_settings()
    for text in (repr(s), str(s), s.model_dump_json(), repr(s.model_dump())):
        assert TEST_KEY not in text
        assert "app-token-secret" not in text


def test_secrets_are_stripped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MODEL_API_KEY", f"  {TEST_KEY}\r\n")
    monkeypatch.setenv("HEYNAVI_APP_TOKEN", "\ttok-123 ")
    s = make_settings()
    assert s.model_api_key is not None and s.model_api_key.get_secret_value() == TEST_KEY
    assert s.heynavi_app_token is not None and s.heynavi_app_token.get_secret_value() == "tok-123"


@pytest.mark.parametrize("field", ["MODEL_API_KEY", "HEYNAVI_APP_TOKEN"])
@pytest.mark.parametrize("value", BAD_SECRETS)
def test_secret_with_bad_characters_is_rejected_without_echoing_it(
    monkeypatch: pytest.MonkeyPatch, field: str, value: str
) -> None:
    monkeypatch.setenv(field, value)
    with pytest.raises(ValidationError) as info:
        make_settings()
    exc = info.value
    message = invalid_settings_message(exc)
    for text in (str(exc), repr(exc), str(exc.errors(include_input=False)), message):
        assert SECRET_PART not in text
    assert field in message and str(ENV_FILE) in message and "printable ASCII" in message


def test_load_settings_or_exit_exits_2_with_env_path(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("MODEL_API_KEY", BAD_SECRETS[0])
    with pytest.raises(SystemExit) as info:
        load_settings_or_exit()
    assert info.value.code == 2
    assert info.value.__context__ is None  # the ValidationError is not chained
    err = capsys.readouterr().err
    assert str(ENV_FILE) in err and "MODEL_API_KEY" in err
    assert SECRET_PART not in err


async def test_app_startup_with_invalid_setting_exits_2(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("HEYNAVI_APP_TOKEN", BAD_SECRETS[1])
    app = create_app()  # no settings passed: resolved at startup, like uvicorn
    with pytest.raises(SystemExit) as info:
        async with app.router.lifespan_context(app):
            pass
    assert info.value.code == 2
    err = capsys.readouterr().err
    assert str(ENV_FILE) in err and "HEYNAVI_APP_TOKEN" in err and SECRET_PART not in err


def test_invalid_values_are_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("META_TIMEOUT_SECONDS", "0")
    with pytest.raises(ValidationError):
        make_settings()
    monkeypatch.setenv("META_TIMEOUT_SECONDS", "5")
    monkeypatch.setenv("LOG_LEVEL", "LOUD")
    with pytest.raises(ValidationError):
        make_settings()


def test_get_settings_is_cached() -> None:
    assert get_settings() is get_settings()


def test_env_example_documents_every_setting_with_a_comment() -> None:
    lines = (BACKEND_DIR / ".env.example").read_text().splitlines()
    keys: list[str] = []
    for i, line in enumerate(lines):
        if line and not line.startswith("#"):
            key, _, value = line.partition("=")
            keys.append(key)
            assert lines[i - 1].startswith("# "), f"{key} has no comment line"
            if key in ("MODEL_API_KEY", "HEYNAVI_APP_TOKEN"):
                assert value == "", f"{key} must be empty in the example"
    assert sorted(keys) == sorted(name.upper() for name in Settings.model_fields)
