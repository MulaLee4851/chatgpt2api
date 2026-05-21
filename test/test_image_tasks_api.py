from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from unittest import mock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

MULTIPART_AVAILABLE = importlib.util.find_spec("python_multipart") is not None or importlib.util.find_spec("multipart") is not None

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

fake_api_app = types.ModuleType("api.app")
fake_api_app.create_app = lambda *args, **kwargs: None
sys.modules.setdefault("api.app", fake_api_app)

fake_multipart = types.ModuleType("multipart")
fake_multipart.__version__ = "0.0-test"
sys.modules.setdefault("multipart", fake_multipart)

fake_multipart_submodule = types.ModuleType("multipart.multipart")
fake_multipart_submodule.parse_options_header = lambda value: (value, {})
sys.modules.setdefault("multipart.multipart", fake_multipart_submodule)

import api.image_tasks as image_tasks_module


AUTH_HEADERS = {"Authorization": "Bearer chatgpt2api"}
PNG_BYTES = b"\x89PNG\r\n\x1a\n"
DATA_IMAGE_URL = f"data:image/png;base64,{base64.b64encode(PNG_BYTES).decode('ascii')}"


class FakeImageTaskService:
    def __init__(self):
        self.generation_calls = []
        self.edit_calls = []

    def submit_generation(self, identity, **kwargs):
        self.generation_calls.append((identity, kwargs))
        return {
            "id": kwargs["client_task_id"],
            "status": "success",
            "mode": "generate",
            "created_at": "2026-01-01 00:00:00",
            "updated_at": "2026-01-01 00:00:00",
            "data": [{"b64_json": "ZmFrZQ=="}],
        }

    def submit_edit(self, identity, **kwargs):
        self.edit_calls.append((identity, kwargs))
        return {
            "id": kwargs["client_task_id"],
            "status": "queued",
            "mode": "edit",
            "created_at": "2026-01-01 00:00:00",
            "updated_at": "2026-01-01 00:00:00",
        }

    def list_tasks(self, _identity, ids):
        return {
            "items": [
                {
                    "id": task_id,
                    "status": "success",
                    "mode": "generate",
                    "created_at": "2026-01-01 00:00:00",
                    "updated_at": "2026-01-01 00:00:00",
                    "data": [{"b64_json": "ZmFrZQ=="}],
                }
                for task_id in ids
                if task_id != "missing"
            ],
            "missing_ids": [task_id for task_id in ids if task_id == "missing"],
        }


class ImageTasksApiTests(unittest.TestCase):
    def setUp(self):
        self.fake_service = FakeImageTaskService()
        self.identity = {"id": "user-1", "name": "User", "role": "user"}
        self.service_patcher = mock.patch.object(image_tasks_module, "image_task_service", self.fake_service)
        self.require_identity_patcher = mock.patch.object(image_tasks_module, "require_identity", return_value=self.identity)
        self.ensure_image_patcher = mock.patch.object(image_tasks_module, "ensure_identity_can_use_image")
        self.service_patcher.start()
        self.require_identity = self.require_identity_patcher.start()
        self.ensure_identity_can_use_image = self.ensure_image_patcher.start()
        self.addCleanup(self.service_patcher.stop)
        self.addCleanup(self.require_identity_patcher.stop)
        self.addCleanup(self.ensure_image_patcher.stop)
        app = FastAPI()
        app.include_router(image_tasks_module.create_router())
        self.client = TestClient(app)

    def test_create_generation_task(self):
        response = self.client.post(
            "/api/image-tasks/generations",
            headers=AUTH_HEADERS,
            json={"client_task_id": "task-1", "prompt": "cat", "model": "gpt-image-2"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["id"], "task-1")
        self.assertEqual(payload["status"], "success")
        self.assertEqual(len(self.fake_service.generation_calls), 1)
        self.ensure_identity_can_use_image.assert_called_once_with(self.identity, 1)

    @unittest.skipUnless(MULTIPART_AVAILABLE, "python-multipart is not installed")
    def test_create_edit_task_accepts_multiple_images(self):
        """测试图片编辑任务接口支持多个上传图片。"""
        response = self.client.post(
            "/api/image-tasks/edits",
            headers=AUTH_HEADERS,
            data={"client_task_id": "edit-1", "prompt": "edit", "model": "gpt-image-2"},
            files=[
                ("image", ("one.png", b"one", "image/png")),
                ("image", ("two.png", b"two", "image/png")),
            ],
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["id"], "edit-1")
        self.assertEqual(len(self.fake_service.edit_calls), 1)
        self.ensure_identity_can_use_image.assert_called_once_with(self.identity, 1)
        images = self.fake_service.edit_calls[0][1]["images"]
        self.assertEqual(len(images), 2)

    def test_create_edit_task_accepts_image_url(self):
        """测试图片编辑任务接口支持表单 image_url 引用。"""
        response = self.client.post(
            "/api/image-tasks/edits",
            headers=AUTH_HEADERS,
            data={
                "client_task_id": "edit-url-1",
                "prompt": "edit",
                "model": "gpt-image-2",
                "image_url": DATA_IMAGE_URL,
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(self.fake_service.edit_calls), 1)
        images = self.fake_service.edit_calls[0][1]["images"]
        self.assertEqual(images, [(PNG_BYTES, "image_url.png", "image/png")])

    def test_list_tasks_reports_missing_ids(self):
        response = self.client.get("/api/image-tasks?ids=task-1,missing", headers=AUTH_HEADERS)

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual([item["id"] for item in payload["items"]], ["task-1"])
        self.assertEqual(payload["missing_ids"], ["missing"])

    def test_create_generation_task_rejects_key_without_image_access(self):
        self.ensure_identity_can_use_image.side_effect = HTTPException(status_code=403, detail={"error": "当前密钥没有生图权限"})

        response = self.client.post(
            "/api/image-tasks/generations",
            headers=AUTH_HEADERS,
            json={"client_task_id": "task-2", "prompt": "cat", "model": "gpt-image-2"},
        )

        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(response.json()["detail"]["error"], "当前密钥没有生图权限")
        self.assertEqual(len(self.fake_service.generation_calls), 0)


if __name__ == "__main__":
    unittest.main()
