"""Meta Model API list prices (dev.meta.ai, checked 2026-10-29). Used for the daily spending
guard and the per-call cost in responses; Meta has no API that reports the real charge."""

from __future__ import annotations

SAM_USD_PER_IMAGE = 2.50 / 1000
SPARK_USD_PER_INPUT_TOKEN = 1.25 / 1_000_000
SPARK_USD_PER_OUTPUT_TOKEN = 4.25 / 1_000_000  # reasoning tokens are billed as output


def estimate_cost(sam_images: int = 0, spark_input_tokens: int = 0, spark_output_tokens: int = 0) -> float:
    return (
        sam_images * SAM_USD_PER_IMAGE
        + spark_input_tokens * SPARK_USD_PER_INPUT_TOKEN
        + spark_output_tokens * SPARK_USD_PER_OUTPUT_TOKEN
    )
