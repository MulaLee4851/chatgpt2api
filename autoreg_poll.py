from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BASE_URL = os.getenv("AUTOREG_BASE_URL", "http://127.0.0.1:8000")
BEARER_TOKEN = os.getenv("AUTOREG_BEARER_TOKEN", "")
SUMMARY_PATH = "/api/accounts/summary"
THRESHOLD = int(os.getenv("AUTOREG_THRESHOLD", "50"))
INTERVAL_SECONDS = int(os.getenv("AUTOREG_INTERVAL_SECONDS", "600"))
TARGET_SCRIPT = Path(__file__).resolve().parent / "gptimagezhuceji.py"
LOG_FILE = Path("D:/logs/autoreg.log")


def setup_logger() -> logging.Logger:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("autoreg")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if not logger.handlers:
        handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
        formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
        handler.setFormatter(formatter)
        logger.addHandler(handler)
    return logger


LOGGER = setup_logger()


def fetch_available_count() -> int:
    headers = {"Accept": "application/json"}
    if BEARER_TOKEN:
        headers["Authorization"] = f"Bearer {BEARER_TOKEN}"
    request = Request(f"{BASE_URL.rstrip('/')}{SUMMARY_PATH}", headers=headers, method="GET")
    with urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    normal_count = payload.get("normal_count")
    if not isinstance(normal_count, int):
        raise ValueError(f"invalid normal_count: {payload!r}")
    return normal_count


def run_register_script() -> None:
    if not TARGET_SCRIPT.exists():
        raise FileNotFoundError(f"script not found: {TARGET_SCRIPT}")
    LOGGER.info("normal_count below threshold, starting %s", TARGET_SCRIPT.name)
    result = subprocess.run(
        [sys.executable, str(TARGET_SCRIPT)],
        cwd=str(TARGET_SCRIPT.parent),
        capture_output=True,
        text=True,
        check=False,
         env={
        **os.environ,  # 继承当前所有环境变量
        "HTTP_PROXY":  "http://127.0.0.1:7897",
        "HTTPS_PROXY": "http://127.0.0.1:7897",
        "PYTHONPATH":  str(TARGET_SCRIPT.parent),
    }
    )
    LOGGER.info("%s exited with code %s", TARGET_SCRIPT.name, result.returncode)
    if result.stdout.strip():
        LOGGER.info("stdout: %s", result.stdout.strip())
    if result.stderr.strip():
        LOGGER.warning("stderr: %s", result.stderr.strip())


def main() -> None:
    LOGGER.info(
        "autoreg poller started, base_url=%s, threshold=%s, interval_seconds=%s",
        BASE_URL,
        THRESHOLD,
        INTERVAL_SECONDS,
    )
    while True:
        try:
            normal_count = fetch_available_count()
            LOGGER.info("fetched normal_count=%s", normal_count)
            if normal_count < THRESHOLD:
                run_register_script()
            else:
                LOGGER.info("normal_count is sufficient, skip register")
        except HTTPError as exc:
            message = exc.read().decode("utf-8", errors="ignore")
            LOGGER.exception("http error: status=%s body=%s", exc.code, message)
        except URLError:
            LOGGER.exception("failed to reach %s", BASE_URL)
        except Exception:
            LOGGER.exception("autoreg poll cycle failed")
        time.sleep(max(1, INTERVAL_SECONDS))


if __name__ == "__main__":
    main()
