from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-auth")

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

fake_backup_service = types.ModuleType("services.backup_service")

class FakeBackupError(Exception):
    pass

class FakeBackupService:
    def test_connection(self):
        return {"ok": True}

    def list_backups(self):
        return []

    def get_status(self):
        return {}

    def get_settings(self):
        return {}

    def run_backup(self):
        return {"ok": True}

    def delete_backup(self, _key):
        return None

    def get_backup_detail(self, _key):
        return {}

    def download_backup(self, _key):
        return {"name": "backup.bin", "size": 0, "payload": b"", "content_type": "application/octet-stream"}

fake_backup_service.BackupError = FakeBackupError
fake_backup_service.backup_service = FakeBackupService()
sys.modules.setdefault("services.backup_service", fake_backup_service)

fake_multipart = types.ModuleType("multipart")
fake_multipart.__version__ = "0.0-test"
sys.modules.setdefault("multipart", fake_multipart)

fake_multipart_submodule = types.ModuleType("multipart.multipart")
fake_multipart_submodule.parse_options_header = lambda value: (value, {})
sys.modules.setdefault("multipart.multipart", fake_multipart_submodule)

import api.accounts as accounts_module
import api.ai as ai_module
import api.system as system_module
from services.account_service import AccountService
from services.auth_service import AuthService
from services.storage.json_storage import JSONStorageBackend
from utils.helper import anonymize_token


class AccountCapabilityTests(unittest.TestCase):
    def test_unknown_quota_accounts_are_available_only_when_not_throttled(self) -> None:
        self.assertFalse(
            AccountService._is_image_account_available(
                {"status": "限流", "image_quota_unknown": True, "quota": 0}
            )
        )
        self.assertTrue(
            AccountService._is_image_account_available(
                {"status": "正常", "image_quota_unknown": True, "quota": 0}
            )
        )

    def test_prolite_variants_are_normalized(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            self.assertEqual(service._normalize_account_type("prolite"), "ProLite")
            self.assertEqual(service._normalize_account_type("pro_lite"), "ProLite")

    def test_search_account_type_ignores_unrelated_scalar_values(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            self.assertIsNone(
                service._search_account_type(
                    {
                        "amr": ["pwd", "otp", "mfa"],
                        "chatgpt_compute_residency": "no_constraint",
                        "chatgpt_data_residency": "no_constraint",
                        "user_id": "user-I52GFfLGFM0dokFk2dBiKEBn",
                    }
                )
            )

    def test_mark_image_result_does_not_consume_unknown_quota(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_accounts(["token-1"])
            service.update_account(
                "token-1",
                {
                    "status": "正常",
                    "quota": 0,
                    "image_quota_unknown": True,
                },
            )

            updated = service.mark_image_result("token-1", success=True)

            self.assertIsNotNone(updated)
            self.assertEqual(updated["quota"], 0)
            self.assertEqual(updated["status"], "正常")
            self.assertTrue(updated["image_quota_unknown"])


class TokenLogTests(unittest.TestCase):
    def test_anonymize_token_hides_raw_value(self) -> None:
        token = "super-secret-token"
        token_ref = anonymize_token(token)

        self.assertTrue(token_ref.startswith("token:"))
        self.assertNotIn(token, token_ref)


class AuthServiceTests(unittest.TestCase):
    def test_create_authenticate_disable_and_delete_user_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AuthService(JSONStorageBackend(Path(tmp_dir) / "accounts.json", Path(tmp_dir) / "auth_keys.json"))

            item, raw_key = service.create_key(role="user", name="Alice")

            self.assertEqual(item["role"], "user")
            self.assertEqual(item["name"], "Alice")
            self.assertTrue(item["enabled"])
            self.assertTrue(raw_key.startswith("sk-"))

            authed = service.authenticate(raw_key)
            self.assertIsNotNone(authed)
            self.assertEqual(authed["id"], item["id"])
            self.assertEqual(authed["role"], "user")
            self.assertIsNotNone(authed["last_used_at"])

            updated = service.update_key(item["id"], {"enabled": False}, role="user")
            self.assertIsNotNone(updated)
            self.assertFalse(updated["enabled"])
            self.assertIsNone(service.authenticate(raw_key))

            self.assertTrue(service.delete_key(item["id"], role="user"))
            self.assertFalse(service.delete_key(item["id"], role="user"))
            self.assertEqual(service.list_keys(role="user"), [])

    def test_authenticate_ignores_last_used_save_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AuthService(JSONStorageBackend(Path(tmp_dir) / "accounts.json", Path(tmp_dir) / "auth_keys.json"))
            item, raw_key = service.create_key(role="user", name="Alice")

            def fail_save() -> None:
                raise OSError("disk unavailable")

            service._save = fail_save

            authed = service.authenticate(raw_key)

            self.assertIsNotNone(authed)
            self.assertEqual(authed["id"], item["id"])
            self.assertIsNotNone(authed["last_used_at"])

    def test_update_user_key_replaces_raw_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AuthService(JSONStorageBackend(Path(tmp_dir) / "accounts.json", Path(tmp_dir) / "auth_keys.json"))
            item, raw_key = service.create_key(role="user", name="Alice")

            updated = service.update_key(item["id"], {"key": "sk-user-custom-key"}, role="user")

            self.assertIsNotNone(updated)
            self.assertIsNone(service.authenticate(raw_key))

            authed = service.authenticate("sk-user-custom-key")
            self.assertIsNotNone(authed)
            self.assertEqual(authed["id"], item["id"])

    def test_user_key_name_must_be_unique(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AuthService(JSONStorageBackend(Path(tmp_dir) / "accounts.json", Path(tmp_dir) / "auth_keys.json"))
            first, _ = service.create_key(role="user", name="Alice")
            second, _ = service.create_key(role="user", name="Bob")

            with self.assertRaisesRegex(ValueError, "这个名称已经在使用中了"):
                service.create_key(role="user", name="Alice")

            with self.assertRaisesRegex(ValueError, "这个名称已经在使用中了"):
                service.update_key(second["id"], {"name": "Alice"}, role="user")

            updated = service.update_key(first["id"], {"name": "Alice"}, role="user")
            self.assertIsNotNone(updated)
            self.assertEqual(updated["name"], "Alice")

    def test_user_key_includes_permissions_limits_and_usage(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AuthService(JSONStorageBackend(Path(tmp_dir) / "accounts.json", Path(tmp_dir) / "auth_keys.json"))

            item, _ = service.create_key(
                role="user",
                name="Quota User",
                permissions={"chat": True, "image": False},
                limits={"expires_at": "2026-05-20T12:30:00+00:00", "max_tokens": 1234, "max_images": 8},
            )

            self.assertEqual(item["permissions"], {"chat": True, "image": False})
            self.assertEqual(item["limits"]["max_tokens"], 1234)
            self.assertEqual(item["limits"]["max_images"], 8)
            self.assertEqual(item["usage"], {"used_tokens": 0, "used_images": 0})

    def test_legacy_user_key_is_normalized_with_unlimited_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            backend = JSONStorageBackend(Path(tmp_dir) / "accounts.json", Path(tmp_dir) / "auth_keys.json")
            backend.save_auth_keys([
                {
                    "id": "legacy-user",
                    "name": "Legacy",
                    "role": "user",
                    "key_hash": "abc123",
                    "enabled": True,
                    "created_at": "2026-05-01T00:00:00+00:00",
                    "last_used_at": None,
                }
            ])

            service = AuthService(backend)
            item = service.list_keys(role="user")[0]

            self.assertEqual(item["permissions"], {"chat": True, "image": True})
            self.assertEqual(item["limits"], {"expires_at": None, "max_tokens": None, "max_images": None})
            self.assertEqual(item["usage"], {"used_tokens": 0, "used_images": 0})

    def test_consume_usage_updates_user_key_counters(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AuthService(JSONStorageBackend(Path(tmp_dir) / "accounts.json", Path(tmp_dir) / "auth_keys.json"))
            item, _ = service.create_key(role="user", name="Usage User")

            service.consume_tokens(item["id"], 42, role="user")
            updated = service.consume_images(item["id"], 3, role="user")

            self.assertIsNotNone(updated)
            self.assertEqual(updated["usage"], {"used_tokens": 42, "used_images": 3})


class FakeAuthService:
    def __init__(self):
        self.create_calls = []
        self.items = [
            {
                "id": "user-1",
                "name": "Alice",
                "role": "user",
                "enabled": True,
                "created_at": "2026-05-01T00:00:00+00:00",
                "last_used_at": None,
                "permissions": {"chat": True, "image": True},
                "limits": {"expires_at": None, "max_tokens": None, "max_images": None},
                "usage": {"used_tokens": 0, "used_images": 0},
            }
        ]

    def list_keys(self, role=None):
        return list(self.items)

    def create_key(self, **kwargs):
        self.create_calls.append(kwargs)
        return self.items[0], "sk-test"

    def update_key(self, *_args, **_kwargs):
        return self.items[0]

    def delete_key(self, *_args, **_kwargs):
        return True


class FakeAccountService:
    def list_accounts(self):
        return []

    def get_summary(self):
        return {"normal_count": 3}


class AccountsApiTests(unittest.TestCase):
    def setUp(self):
        self.fake_auth = FakeAuthService()
        self.fake_accounts = FakeAccountService()
        self.require_admin_patcher = mock.patch.object(accounts_module, "require_admin", return_value={"id": "admin", "role": "admin"})
        self.auth_patcher = mock.patch.object(accounts_module, "auth_service", self.fake_auth)
        self.account_patcher = mock.patch.object(accounts_module, "account_service", self.fake_accounts)
        self.require_admin_patcher.start()
        self.auth_patcher.start()
        self.account_patcher.start()
        self.addCleanup(self.require_admin_patcher.stop)
        self.addCleanup(self.auth_patcher.stop)
        self.addCleanup(self.account_patcher.stop)
        app = FastAPI()
        app.include_router(accounts_module.create_router())
        self.client = TestClient(app)

    def test_create_user_key_requires_permissions_and_limits(self):
        response = self.client.post("/api/auth/users", headers={"Authorization": "Bearer test-auth"}, json={"name": "Alice"})

        self.assertEqual(response.status_code, 422, response.text)

    def test_create_user_key_passes_permissions_and_limits_to_service(self):
        response = self.client.post(
            "/api/auth/users",
            headers={"Authorization": "Bearer test-auth"},
            json={
                "name": "Alice",
                "permissions": {"chat": True, "image": False},
                "limits": {"expires_at": None, "max_tokens": 5000, "max_images": 12},
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.fake_auth.create_calls[0]["permissions"], {"chat": True, "image": False})
        self.assertEqual(self.fake_auth.create_calls[0]["limits"], {"expires_at": None, "max_tokens": 5000, "max_images": 12})

    def test_accounts_summary_returns_normal_count(self):
        response = self.client.get("/api/accounts/summary", headers={"Authorization": "Bearer test-auth"})

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"normal_count": 3})


class AIApiPermissionTests(unittest.TestCase):
    def setUp(self):
        self.require_identity_patcher = mock.patch.object(ai_module, "require_identity")
        self.filter_patcher = mock.patch.object(ai_module, "filter_or_log", new=mock.AsyncMock())
        self.consume_tokens_patcher = mock.patch.object(ai_module, "consume_identity_tokens")
        self.chat_handler_patcher = mock.patch.object(
            ai_module.openai_v1_chat_complete,
            "handle",
            return_value={
                "id": "chatcmpl-test",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 4, "completion_tokens": 3, "total_tokens": 7},
            },
        )
        self.require_identity = self.require_identity_patcher.start()
        self.filter_patcher.start()
        self.consume_tokens = self.consume_tokens_patcher.start()
        self.chat_handler_patcher.start()
        self.addCleanup(self.require_identity_patcher.stop)
        self.addCleanup(self.filter_patcher.stop)
        self.addCleanup(self.consume_tokens_patcher.stop)
        self.addCleanup(self.chat_handler_patcher.stop)
        app = FastAPI()
        app.include_router(ai_module.create_router())
        self.client = TestClient(app)

    def test_chat_only_key_cannot_call_image_generation(self):
        self.require_identity.return_value = {
            "id": "user-1",
            "name": "Chat Only",
            "role": "user",
            "permissions": {"chat": True, "image": False},
            "limits": {"expires_at": None, "max_tokens": None, "max_images": None},
            "usage": {"used_tokens": 0, "used_images": 0},
        }

        response = self.client.post(
            "/v1/images/generations",
            headers={"Authorization": "Bearer key"},
            json={"prompt": "cat", "model": "gpt-image-2", "n": 1},
        )

        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(response.json()["detail"]["error"], "当前密钥没有生图权限")

    def test_image_only_key_cannot_call_chat_completion(self):
        self.require_identity.return_value = {
            "id": "user-1",
            "name": "Image Only",
            "role": "user",
            "permissions": {"chat": False, "image": True},
            "limits": {"expires_at": None, "max_tokens": None, "max_images": None},
            "usage": {"used_tokens": 0, "used_images": 0},
        }

        response = self.client.post(
            "/v1/chat/completions",
            headers={"Authorization": "Bearer key"},
            json={"model": "auto", "messages": [{"role": "user", "content": "hi"}]},
        )

        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(response.json()["detail"]["error"], "当前密钥没有对话权限")

    def test_token_exhausted_key_is_rejected(self):
        self.require_identity.return_value = {
            "id": "user-1",
            "name": "Exhausted",
            "role": "user",
            "permissions": {"chat": True, "image": True},
            "limits": {"expires_at": None, "max_tokens": 5, "max_images": None},
            "usage": {"used_tokens": 5, "used_images": 0},
        }

        response = self.client.post(
            "/v1/chat/completions",
            headers={"Authorization": "Bearer key"},
            json={"model": "auto", "messages": [{"role": "user", "content": "hi"}]},
        )

        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(response.json()["detail"]["error"], "当前密钥的 tokens 已用完")

    def test_chat_completion_consumes_total_tokens_after_success(self):
        identity = {
            "id": "user-1",
            "name": "Normal",
            "role": "user",
            "permissions": {"chat": True, "image": True},
            "limits": {"expires_at": None, "max_tokens": 100, "max_images": None},
            "usage": {"used_tokens": 1, "used_images": 0},
        }
        self.require_identity.return_value = identity

        response = self.client.post(
            "/v1/chat/completions",
            headers={"Authorization": "Bearer key"},
            json={"model": "auto", "messages": [{"role": "user", "content": "hi"}]},
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.consume_tokens.assert_called_once_with(identity, 7)


class SystemLoginTests(unittest.TestCase):
    def setUp(self):
        self.require_identity_patcher = mock.patch.object(system_module, "require_identity")
        self.ensure_not_expired_patcher = mock.patch.object(system_module, "_ensure_identity_not_expired")
        self.require_identity = self.require_identity_patcher.start()
        self.ensure_not_expired = self.ensure_not_expired_patcher.start()
        self.addCleanup(self.require_identity_patcher.stop)
        self.addCleanup(self.ensure_not_expired_patcher.stop)
        app = FastAPI()
        app.include_router(system_module.create_router("test-version"))
        self.client = TestClient(app)

    def test_login_returns_permissions_for_user_key(self):
        self.require_identity.return_value = {
            "id": "user-1",
            "name": "Image Only",
            "role": "user",
            "permissions": {"chat": False, "image": True},
        }

        response = self.client.post("/auth/login", headers={"Authorization": "Bearer key"})

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            response.json(),
            {
                "ok": True,
                "version": "test-version",
                "role": "user",
                "subject_id": "user-1",
                "name": "Image Only",
                "permissions": {"chat": False, "image": True},
            },
        )
        self.ensure_not_expired.assert_called_once_with(self.require_identity.return_value)

    def test_login_rejects_expired_key(self):
        identity = {
            "id": "user-1",
            "name": "Expired",
            "role": "user",
            "permissions": {"chat": True, "image": True},
        }
        self.require_identity.return_value = identity
        self.ensure_not_expired.side_effect = ai_module.HTTPException(
            status_code=403,
            detail={"error": "当前密钥已过期"},
        )

        response = self.client.post("/auth/login", headers={"Authorization": "Bearer key"})

        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(response.json()["detail"]["error"], "当前密钥已过期")
        self.ensure_not_expired.assert_called_once_with(identity)


if __name__ == "__main__":
    unittest.main()
