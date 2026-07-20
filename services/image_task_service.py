from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from services.auth_service import auth_service
from services.config import DATA_DIR, config
from services.content_filter import request_text
from services.log_service import LOG_TYPE_CALL, log_service
from services.protocol import openai_v1_image_edit, openai_v1_image_generations

TASK_STATUS_QUEUED = "queued"
TASK_STATUS_RUNNING = "running"
TASK_STATUS_SUCCESS = "success"
TASK_STATUS_ERROR = "error"
TERMINAL_STATUSES = {TASK_STATUS_SUCCESS, TASK_STATUS_ERROR}
UNFINISHED_STATUSES = {TASK_STATUS_QUEUED, TASK_STATUS_RUNNING}


def _now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _timestamp(value: object) -> float:
    if not isinstance(value, str) or not value.strip():
        return 0.0
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(value[:26], fmt).timestamp()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def _clean(value: object, default: str = "") -> str:
    return str(value or default).strip()


def _owner_id(identity: dict[str, object]) -> str:
    return _clean(identity.get("id")) or "anonymous"


def _task_key(owner_id: str, task_id: str) -> str:
    return f"{owner_id}:{task_id}"


def _collect_image_urls(data: list[Any]) -> list[str]:
    urls: list[str] = []
    for item in data:
        if isinstance(item, dict):
            url = item.get("url")
            if isinstance(url, str) and url:
                urls.append(url)
    return urls


def _strip_inline_image_payloads(data: object) -> object:
    if not isinstance(data, list):
        return data
    cleaned: list[Any] = []
    for item in data:
        if not isinstance(item, dict):
            cleaned.append(item)
            continue
        copied = dict(item)
        copied.pop("b64_json", None)
        cleaned.append(copied)
    return cleaned


def _consume_identity_images(identity: dict[str, object], image_count: int) -> dict[str, object]:
    if identity.get("role") == "admin":
        return identity
    key_id = _clean(identity.get("id"))
    amount = max(0, int(image_count or 0))
    if not key_id or amount <= 0:
        return identity
    updated = auth_service.consume_images(key_id, amount, role="user")
    if updated is not None:
        identity.update(updated)
    return identity


def _public_task(task: dict[str, Any]) -> dict[str, Any]:
    item = {
        "id": task.get("id"),
        "status": task.get("status"),
        "mode": task.get("mode"),
        "model": task.get("model"),
        "size": task.get("size"),
        "created_at": task.get("created_at"),
        "updated_at": task.get("updated_at"),
    }
    if task.get("data") is not None:
        item["data"] = _strip_inline_image_payloads(task.get("data"))
    if task.get("error"):
        item["error"] = task.get("error")
    if task.get("progress_message"):
        item["progress_message"] = task.get("progress_message")
    return item


def _log_image_task_stage(summary: str, detail: dict[str, Any]) -> None:
    try:
        log_service.add("image_upstream_debug", summary, detail)
    except Exception:
        pass


class ImageTaskService:
    def __init__(
        self,
        path: Path,
        *,
        generation_handler: Callable[[dict[str, Any]], dict[str, Any]] = openai_v1_image_generations.handle,
        edit_handler: Callable[[dict[str, Any]], dict[str, Any]] = openai_v1_image_edit.handle,
        retention_days_getter: Callable[[], int] | None = None,
    ):
        self.path = path
        self.generation_handler = generation_handler
        self.edit_handler = edit_handler
        self.retention_days_getter = retention_days_getter or (lambda: config.image_retention_days)
        self._lock = threading.RLock()
        self._tasks: dict[str, dict[str, Any]] = {}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._tasks = self._load_locked()
            changed = self._recover_unfinished_locked()
            changed = self._cleanup_locked() or changed
            if changed:
                self._save_locked()

    def submit_generation(
        self,
        identity: dict[str, object],
        *,
        client_task_id: str,
        prompt: str,
        model: str,
        size: str | None,
        base_url: str,
    ) -> dict[str, Any]:
        payload = {
            "prompt": prompt,
            "model": model,
            "n": 1,
            "size": size,
            "response_format": "b64_json",
            "base_url": base_url,
        }
        return self._submit(identity, client_task_id=client_task_id, mode="generate", payload=payload)

    def submit_edit(
        self,
        identity: dict[str, object],
        *,
        client_task_id: str,
        prompt: str,
        model: str,
        size: str | None,
        base_url: str,
        images: list[tuple[bytes, str, str]],
    ) -> dict[str, Any]:
        payload = {
            "prompt": prompt,
            "images": images,
            "model": model,
            "n": 1,
            "size": size,
            "response_format": "b64_json",
            "base_url": base_url,
        }
        return self._submit(identity, client_task_id=client_task_id, mode="edit", payload=payload)

    def list_tasks(self, identity: dict[str, object], task_ids: list[str]) -> dict[str, Any]:
        owner = _owner_id(identity)
        requested_ids = [_clean(task_id) for task_id in task_ids if _clean(task_id)]
        with self._lock:
            if self._cleanup_locked():
                self._save_locked()
            items = []
            missing_ids = []
            for task_id in requested_ids:
                task = self._tasks.get(_task_key(owner, task_id))
                if task is None:
                    missing_ids.append(task_id)
                else:
                    items.append(_public_task(task))
            if not requested_ids:
                items = [
                    _public_task(task)
                    for task in self._tasks.values()
                    if task.get("owner_id") == owner
                ]
                items.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
                missing_ids = []
            return {"items": items, "missing_ids": missing_ids}

    def _submit(
        self,
        identity: dict[str, object],
        *,
        client_task_id: str,
        mode: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        task_id = _clean(client_task_id)
        if not task_id:
            raise ValueError("client_task_id is required")
        owner = _owner_id(identity)
        key = _task_key(owner, task_id)
        now = _now_iso()
        should_start = False
        with self._lock:
            cleaned = self._cleanup_locked()
            task = self._tasks.get(key)
            if task is not None:
                if cleaned:
                    self._save_locked()
                return _public_task(task)
            task = {
                "id": task_id,
                "owner_id": owner,
                "status": TASK_STATUS_QUEUED,
                "mode": mode,
                "model": _clean(payload.get("model"), "gpt-image-2"),
                "size": _clean(payload.get("size")),
                "created_at": now,
                "updated_at": now,
                "progress_message": "",
            }
            self._tasks[key] = task
            self._save_locked()
            should_start = True

        if should_start:
            _log_image_task_stage(
                "图片任务已入队",
                {
                    "reason": "task_queued",
                    "task_key": key,
                    "task_id": task_id,
                    "owner_id": owner,
                    "mode": mode,
                    "model": task.get("model"),
                    "size": task.get("size"),
                    "request_preview": request_text(payload.get("prompt")),
                },
            )
            thread = threading.Thread(
                target=self._run_task,
                args=(key, mode, payload, dict(identity), _clean(payload.get("model"), "gpt-image-2")),
                name=f"image-task-{task_id[:16]}",
                daemon=True,
            )
            thread.start()
        return _public_task(task)

    def _run_task(
        self,
        key: str,
        mode: str,
        payload: dict[str, Any],
        identity: dict[str, object],
        model: str,
    ) -> None:
        started = time.time()
        request_preview = request_text(payload.get("prompt"))
        self._update_task(key, status=TASK_STATUS_RUNNING, error="", progress_message="")
        _log_image_task_stage(
            "图片任务开始处理",
            {
                "reason": "task_worker_started",
                "task_key": key,
                "mode": mode,
                "model": model,
                "request_preview": request_preview,
            },
        )
        try:
            handler = self.edit_handler if mode == "edit" else self.generation_handler

            def update_progress(message: str) -> None:
                text = _clean(message)
                self._update_task(key, status=TASK_STATUS_RUNNING, error="", progress_message=text)
                if text:
                    _log_image_task_stage(
                        "图片任务准备重试",
                        {
                            "reason": "task_retrying",
                            "task_key": key,
                            "mode": mode,
                            "model": model,
                            "request_preview": request_preview,
                            "progress_message": text,
                        },
                    )

            _log_image_task_stage(
                "图片任务开始请求上游",
                {
                    "reason": "task_upstream_request_started",
                    "task_key": key,
                    "mode": mode,
                    "model": model,
                    "request_preview": request_preview,
                },
            )
            result = handler({**payload, "_task_progress_callback": update_progress})
            if not isinstance(result, dict):
                raise RuntimeError("image task returned streaming result unexpectedly")
            data = result.get("data")
            if not isinstance(data, list) or not data:
                message = _clean(result.get("message"))
                if mode == "edit":
                    terminal_message = message or "未返回可用编辑结果，可能为原图回退或无有效编辑产物"
                    self._update_task(
                        key,
                        status=TASK_STATUS_SUCCESS,
                        data=[],
                        error="",
                        progress_message=terminal_message,
                    )
                    _log_image_task_stage(
                        "编辑图片任务无结果但不记为失败",
                        {
                            "reason": "task_result_empty_edit_treated_success",
                            "task_key": key,
                            "mode": mode,
                            "model": model,
                            "request_preview": request_preview,
                            "result_keys": sorted(result.keys()),
                            "message": terminal_message,
                        },
                    )
                    return
                if not message:
                    _log_image_task_stage(
                        "图片任务未拿到图片或说明文本",
                        {
                            "reason": "task_result_no_data_no_message",
                            "task_key": key,
                            "mode": mode,
                            "model": model,
                            "request_preview": request_preview,
                            "result_keys": sorted(result.keys()),
                            "has_data": False,
                            "has_message": False,
                        },
                    )
                    message = "image task returned no image data"
                raise RuntimeError(message)
            _consume_identity_images(identity, len(data))
            self._update_task(
                key,
                status=TASK_STATUS_SUCCESS,
                data=_strip_inline_image_payloads(data),
                error="",
                progress_message="",
            )
            _log_image_task_stage(
                "图片任务处理成功",
                {
                    "reason": "task_result_success",
                    "task_key": key,
                    "mode": mode,
                    "model": model,
                    "request_preview": request_preview,
                    "image_count": len(data),
                    "duration_ms": int((time.time() - started) * 1000),
                    "urls": _collect_image_urls(data),
                },
            )
            self._log_call(
                identity,
                mode,
                model,
                started,
                "调用完成",
                request_preview=request_preview,
                urls=_collect_image_urls(data),
            )
        except Exception as exc:
            error_message = str(exc) or "image task failed"
            self._update_task(key, status=TASK_STATUS_ERROR, error=error_message, data=[], progress_message="")
            _log_image_task_stage(
                "图片任务处理失败",
                {
                    "reason": "task_result_error",
                    "task_key": key,
                    "mode": mode,
                    "model": model,
                    "request_preview": request_preview,
                    "error": error_message,
                    "duration_ms": int((time.time() - started) * 1000),
                },
            )
            self._log_call(
                identity,
                mode,
                model,
                started,
                "调用失败",
                request_preview=request_preview,
                status="failed",
                error=error_message,
            )

    def _log_call(
        self,
        identity: dict[str, object],
        mode: str,
        model: str,
        started: float,
        suffix: str,
        *,
        request_preview: str = "",
        status: str = "success",
        error: str = "",
        urls: list[str] | None = None,
    ) -> None:
        endpoint = "/v1/images/edits" if mode == "edit" else "/v1/images/generations"
        summary_prefix = "图生图" if mode == "edit" else "文生图"
        detail = {
            "key_id": identity.get("id"),
            "key_name": identity.get("name"),
            "role": identity.get("role"),
            "endpoint": endpoint,
            "model": model,
            "started_at": datetime.fromtimestamp(started).strftime("%Y-%m-%d %H:%M:%S"),
            "ended_at": _now_iso(),
            "duration_ms": int((time.time() - started) * 1000),
            "status": status,
        }
        if request_preview:
            detail["request_text"] = request_preview
        if error:
            detail["error"] = error
        if urls:
            detail["urls"] = list(dict.fromkeys(urls))
        try:
            log_service.add(LOG_TYPE_CALL, f"{summary_prefix}{suffix}", detail)
        except Exception:
            pass

    def _update_task(self, key: str, **updates: Any) -> None:
        with self._lock:
            task = self._tasks.get(key)
            if task is None:
                return
            task.update(updates)
            task["updated_at"] = _now_iso()
            self._save_locked()

    def _load_locked(self) -> dict[str, dict[str, Any]]:
        if not self.path.exists():
            return {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        raw_items = raw.get("tasks") if isinstance(raw, dict) else raw
        if not isinstance(raw_items, list):
            return {}
        tasks: dict[str, dict[str, Any]] = {}
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            task_id = _clean(item.get("id"))
            owner = _clean(item.get("owner_id"))
            if not task_id or not owner:
                continue
            status = _clean(item.get("status"))
            if status not in {TASK_STATUS_QUEUED, TASK_STATUS_RUNNING, TASK_STATUS_SUCCESS, TASK_STATUS_ERROR}:
                status = TASK_STATUS_ERROR
            task = {
                "id": task_id,
                "owner_id": owner,
                "status": status,
                "mode": "edit" if item.get("mode") == "edit" else "generate",
                "model": _clean(item.get("model"), "gpt-image-2"),
                "size": _clean(item.get("size")),
                "created_at": _clean(item.get("created_at"), _now_iso()),
                "updated_at": _clean(item.get("updated_at"), _clean(item.get("created_at"), _now_iso())),
            }
            data = item.get("data")
            if isinstance(data, list):
                task["data"] = _strip_inline_image_payloads(data)
            error = _clean(item.get("error"))
            if error:
                task["error"] = error
            progress_message = _clean(item.get("progress_message"))
            if progress_message:
                task["progress_message"] = progress_message
            tasks[_task_key(owner, task_id)] = task
        return tasks

    def _save_locked(self) -> None:
        items = sorted(self._tasks.values(), key=lambda item: str(item.get("updated_at") or ""), reverse=True)
        safe_items = []
        for item in items:
            copied = dict(item)
            if copied.get("data") is not None:
                copied["data"] = _strip_inline_image_payloads(copied.get("data"))
            safe_items.append(copied)
        tmp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp_path.write_text(json.dumps({"tasks": safe_items}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp_path.replace(self.path)

    def _recover_unfinished_locked(self) -> bool:
        changed = False
        for task in self._tasks.values():
            if task.get("status") in UNFINISHED_STATUSES:
                task["status"] = TASK_STATUS_ERROR
                task["error"] = "服务已重启，未完成的图片任务已中断"
                task["updated_at"] = _now_iso()
                changed = True
        return changed

    def _cleanup_locked(self) -> bool:
        try:
            retention_days = max(1, int(self.retention_days_getter()))
        except Exception:
            retention_days = 30
        cutoff = time.time() - retention_days * 86400
        removed_keys = [
            key
            for key, task in self._tasks.items()
            if task.get("status") in TERMINAL_STATUSES and _timestamp(task.get("updated_at")) < cutoff
        ]
        for key in removed_keys:
            self._tasks.pop(key, None)
        return bool(removed_keys)


image_task_service = ImageTaskService(DATA_DIR / "image_tasks.json")
