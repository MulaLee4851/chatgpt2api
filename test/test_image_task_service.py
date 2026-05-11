from __future__ import annotations

import json
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest import mock

fake_database_storage = types.ModuleType("services.storage.database_storage")
fake_database_storage.DatabaseStorageBackend = object
sys.modules.setdefault("services.storage.database_storage", fake_database_storage)

fake_git_storage = types.ModuleType("services.storage.git_storage")
fake_git_storage.GitStorageBackend = object
sys.modules.setdefault("services.storage.git_storage", fake_git_storage)

fake_pybase64 = types.ModuleType("pybase64")
fake_pybase64.b64encode = lambda data, altchars=None: data
fake_pybase64.b64decode = lambda data, altchars=None, validate=False: data
sys.modules.setdefault("pybase64", fake_pybase64)

fake_pow = types.ModuleType("utils.pow")
fake_pow.build_legacy_requirements_token = lambda *args, **kwargs: ""
fake_pow.build_proof_token = lambda *args, **kwargs: ""
fake_pow.parse_pow_resources = lambda *args, **kwargs: []
sys.modules.setdefault("utils.pow", fake_pow)

fake_openai_backend_api = types.ModuleType("services.openai_backend_api")

class FakeOpenAIBackendAPI:
    def __init__(self, *args, **kwargs):
        self.access_token = kwargs.get("access_token", "")

    def stream_conversation(self, *args, **kwargs):
        return iter(())

    def get_user_info(self):
        return {}

class FakeInvalidAccessTokenError(Exception):
    pass

fake_openai_backend_api.OpenAIBackendAPI = FakeOpenAIBackendAPI
fake_openai_backend_api.InvalidAccessTokenError = FakeInvalidAccessTokenError
sys.modules.setdefault("services.openai_backend_api", fake_openai_backend_api)

from services.image_task_service import ImageTaskService


OWNER = {"id": "owner-1", "name": "Owner", "role": "admin"}
OTHER_OWNER = {"id": "owner-2", "name": "Other", "role": "user"}
USER_OWNER = {"id": "user-1", "name": "User", "role": "user"}


def wait_for_task(service: ImageTaskService, identity: dict[str, object], task_id: str, status: str, timeout: float = 2.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        result = service.list_tasks(identity, [task_id])
        last = (result.get("items") or [None])[0]
        if last and last.get("status") == status:
            return last
        time.sleep(0.02)
    raise AssertionError(f"task {task_id} did not reach {status}, last={last}")


class ImageTaskServiceTests(unittest.TestCase):
    def make_service(self, path: Path, handler=None) -> ImageTaskService:
        return ImageTaskService(
            path,
            generation_handler=handler or (lambda _payload: {"data": [{"b64_json": "ZmFrZQ=="}]}),
            edit_handler=handler or (lambda _payload: {"data": [{"b64_json": "ZWRpdA=="}]}),
            retention_days_getter=lambda: 30,
        )

    def test_duplicate_submit_uses_existing_task(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            calls = 0

            def handler(_payload):
                nonlocal calls
                calls += 1
                time.sleep(0.05)
                return {"data": [{"b64_json": "ZmFrZQ=="}]}

            service = self.make_service(Path(tmp_dir) / "image_tasks.json", handler)
            first = service.submit_generation(
                OWNER,
                client_task_id="task-1",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )
            second = service.submit_generation(
                OWNER,
                client_task_id="task-1",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )

            self.assertEqual(first["id"], "task-1")
            self.assertEqual(second["id"], "task-1")
            task = wait_for_task(service, OWNER, "task-1", "success")
            self.assertEqual(task["data"][0]["b64_json"], "ZmFrZQ==")
            self.assertEqual(calls, 1)

    def test_different_owner_cannot_query_task(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "image_tasks.json")
            service.submit_generation(
                OWNER,
                client_task_id="private-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )

            wait_for_task(service, OWNER, "private-task", "success")
            result = service.list_tasks(OTHER_OWNER, ["private-task"])

            self.assertEqual(result["items"], [])
            self.assertEqual(result["missing_ids"], ["private-task"])

    def test_success_task_persists_to_new_service_instance(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            service = self.make_service(path)
            service.submit_generation(
                OWNER,
                client_task_id="persisted-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )
            wait_for_task(service, OWNER, "persisted-task", "success")

            reloaded = self.make_service(path)
            result = reloaded.list_tasks(OWNER, ["persisted-task"])

            self.assertEqual(result["missing_ids"], [])
            self.assertEqual(result["items"][0]["status"], "success")
            self.assertEqual(result["items"][0]["data"][0]["b64_json"], "ZmFrZQ==")

    def test_startup_marks_unfinished_tasks_as_error(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            path.write_text(
                json.dumps(
                    {
                        "tasks": [
                            {
                                "id": "queued-task",
                                "owner_id": "owner-1",
                                "status": "queued",
                                "mode": "generate",
                                "model": "gpt-image-2",
                                "created_at": "2099-01-01 00:00:00",
                                "updated_at": "2099-01-01 00:00:00",
                            },
                            {
                                "id": "running-task",
                                "owner_id": "owner-1",
                                "status": "running",
                                "mode": "generate",
                                "model": "gpt-image-2",
                                "created_at": "2099-01-01 00:00:00",
                                "updated_at": "2099-01-01 00:00:00",
                            },
                        ]
                    }
                ),
                encoding="utf-8",
            )

            service = self.make_service(path)
            result = service.list_tasks(OWNER, ["queued-task", "running-task"])

            self.assertEqual([item["status"] for item in result["items"]], ["error", "error"])
            self.assertTrue(all("已中断" in item.get("error", "") for item in result["items"]))

    def test_success_task_consumes_image_quota_for_user_keys(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            service = self.make_service(path, lambda _payload: {"data": [{"b64_json": "a"}, {"b64_json": "b"}]})

            with mock.patch("services.image_task_service.auth_service.consume_images") as consume_images:
                service.submit_generation(
                    USER_OWNER,
                    client_task_id="quota-task",
                    prompt="cat",
                    model="gpt-image-2",
                    size=None,
                    base_url="http://local.test",
                )
                wait_for_task(service, USER_OWNER, "quota-task", "success")

            consume_images.assert_called_once_with("user-1", 2, role="user")


if __name__ == "__main__":
    unittest.main()
