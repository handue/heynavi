from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from app.main import create_app
from tests.conftest import make_settings

APP_TOKEN = "metrics-app-token"
AUTH = {"X-HeyNavi-Token": APP_TOKEN}


def client(**settings: Any) -> TestClient:
    return TestClient(create_app(make_settings(heynavi_app_token=APP_TOKEN, **settings)))


def test_appends_metric_lines(tmp_path: Path) -> None:
    path = tmp_path / "var" / "metrics.jsonl"
    lines = ['[heynavi-metrics] {"reason":"scene","rttMs":3900}', "[heynavi-scene] line spoken"]
    with client(metrics_file=path) as c:
        response = c.post("/v1/metrics", json={"session_id": "s1", "lines": lines}, headers=AUTH)
    assert response.status_code == 204
    stored = [json.loads(row) for row in path.read_text().splitlines()]
    assert [row["line"] for row in stored] == lines
    assert all(row["session"] == "s1" and isinstance(row["t"], float) for row in stored)


def test_refuses_anything_but_metric_lines(tmp_path: Path) -> None:
    path = tmp_path / "metrics.jsonl"
    with client(metrics_file=path) as c:
        for lines in (["hello"], ["[heynavi-metrics] é"], [], ["[heynavi-metrics] " + "x" * 2001]):
            response = c.post("/v1/metrics", json={"session_id": "s1", "lines": lines}, headers=AUTH)
            assert response.status_code == 422, lines
        assert c.post("/v1/metrics", json={"session_id": "s1", "lines": ["[heynavi-metrics] {}"]}).status_code == 401
    assert not path.exists()
