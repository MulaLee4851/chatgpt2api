from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone

from services.account_service import account_service
from services.config import config
from services.log_service import LOG_TYPE_ACCOUNT, log_service


class ScheduledAccountRefreshService:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._lock = threading.Lock()
        self._running = False
        self._last_started_at: datetime | None = None
        self._last_finished_at: datetime | None = None

    def start(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop_event.clear()
            self._thread = threading.Thread(target=self._run, name="scheduled-account-refresh", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        thread = self._thread
        if thread and thread.is_alive():
            thread.join(timeout=1)

    def _run(self) -> None:
        while not self._stop_event.wait(30):
            try:
                self.run_scheduled_refresh_if_needed()
            except Exception as exc:
                log_service.add(LOG_TYPE_ACCOUNT, "定时账号刷新失败", {"error": str(exc)})

    def run_scheduled_refresh_if_needed(self) -> None:
        settings = config.get_scheduled_account_refresh_settings()
        if not settings.get("enabled"):
            return

        interval_minutes = max(1, int(settings.get("interval_minutes") or 1))
        now = datetime.now(timezone.utc)
        if self._last_started_at and now - self._last_started_at < timedelta(minutes=interval_minutes):
            return

        self.run_refresh(worker_count=max(1, int(settings.get("worker_count") or 1)), trigger="schedule")

    def run_refresh(self, worker_count: int, trigger: str = "schedule") -> dict[str, object] | None:
        with self._lock:
            if self._running:
                return None
            self._running = True
            self._last_started_at = datetime.now(timezone.utc)

        try:
            result = account_service.refresh_all_accounts(worker_count=worker_count)
            log_service.add(
                LOG_TYPE_ACCOUNT,
                "定时刷新账号完成",
                {
                    "trigger": trigger,
                    "worker_count": worker_count,
                    "refreshed": result.get("refreshed", 0),
                    "errors": len(result.get("errors") or []),
                },
            )
            return result
        finally:
            with self._lock:
                self._running = False
                self._last_finished_at = datetime.now(timezone.utc)


scheduled_account_refresh_service = ScheduledAccountRefreshService()
