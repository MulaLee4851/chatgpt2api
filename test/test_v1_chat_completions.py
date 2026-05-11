from __future__ import annotations

import json
import time
import unittest
from unittest import mock

import requests

from services.protocol import openai_v1_chat_complete
from utils.helper import save_images_from_text

AUTH_KEY = "chatgpt2api"
BASE_URL = "http://localhost:8000"


class ChatCompletionsTests(unittest.TestCase):
    def test_gpt_web_stream_uses_dedicated_backend(self):
        body = {
            "model": "gpt-web",
            "stream": True,
            "messages": [{"role": "user", "content": "你好。"}],
        }
        backend = object()
        with (
            mock.patch.object(openai_v1_chat_complete, "is_image_chat_request", return_value=False),
            mock.patch.object(openai_v1_chat_complete, "gpt_web_text_backend", return_value=backend) as gpt_backend_mock,
            mock.patch.object(openai_v1_chat_complete, "text_backend") as text_backend_mock,
            mock.patch.object(openai_v1_chat_complete, "stream_text_chat_completion", return_value=iter(())) as stream_mock,
        ):
            result = openai_v1_chat_complete.handle(body)
        self.assertIsInstance(result, type(iter(())))
        gpt_backend_mock.assert_called_once_with()
        text_backend_mock.assert_not_called()
        stream_mock.assert_called_once_with(backend, [{"role": "user", "content": "你好。"}], "gpt-web")

    def test_auto_non_stream_keeps_default_backend(self):
        body = {
            "model": "auto",
            "messages": [{"role": "user", "content": "你好。"}],
        }
        backend = object()
        with (
            mock.patch.object(openai_v1_chat_complete, "is_image_chat_request", return_value=False),
            mock.patch.object(openai_v1_chat_complete, "text_backend", return_value=backend) as text_backend_mock,
            mock.patch.object(openai_v1_chat_complete, "gpt_web_text_backend") as gpt_backend_mock,
            mock.patch.object(
                openai_v1_chat_complete,
                "conversation_events",
                return_value=iter([{"type": "conversation.delta", "delta": "ok", "sources": []}]),
            ),
        ):
            result = openai_v1_chat_complete.handle(body)
        gpt_backend_mock.assert_not_called()
        text_backend_mock.assert_called_once_with()
        self.assertEqual(result["model"], "auto")
        self.assertEqual(result["choices"][0]["message"]["content"], "ok")

    def test_gpt_web_non_stream_includes_sources_extension(self):
        body = {
            "model": "gpt-web",
            "messages": [{"role": "user", "content": "今天有什么新闻？"}],
        }
        backend = object()
        sources = [{
            "type": "grouped_webpages",
            "items": [{
                "id": "https://example.com/news",
                "title": "Example News",
                "url": "https://example.com/news",
                "attribution": "Example",
                "snippet": "Summary",
                "ref_indices": ["turn0search7"],
            }],
        }]
        events = iter([
            {"type": "conversation.delta", "delta": "给你整理了今天新闻", "sources": []},
            {"type": "conversation.event", "sources": sources},
        ])
        with (
            mock.patch.object(openai_v1_chat_complete, "is_image_chat_request", return_value=False),
            mock.patch.object(openai_v1_chat_complete, "gpt_web_text_backend", return_value=backend) as gpt_backend_mock,
            mock.patch.object(openai_v1_chat_complete, "text_backend") as text_backend_mock,
            mock.patch.object(openai_v1_chat_complete, "conversation_events", return_value=events),
        ):
            result = openai_v1_chat_complete.handle(body)
        gpt_backend_mock.assert_called_once_with()
        text_backend_mock.assert_not_called()
        self.assertEqual(result["choices"][0]["message"]["content"], "给你整理了今天新闻")
        self.assertEqual(result["x_gpt_web"]["sources"], sources)

    def test_gpt_web_stream_includes_sources_extension(self):
        backend = object()
        sources = [{
            "type": "grouped_webpages",
            "items": [{
                "id": "https://example.com/news",
                "title": "Example News",
                "url": "https://example.com/news",
                "attribution": "Example",
                "snippet": "Summary",
                "ref_indices": ["turn0search7"],
            }],
        }]
        events = iter([
            {"type": "conversation.delta", "delta": "给你整理了", "sources": []},
            {"type": "conversation.event", "sources": sources},
            {"type": "conversation.delta", "delta": "今天新闻", "sources": sources},
        ])
        with mock.patch.object(openai_v1_chat_complete, "conversation_events", return_value=events):
            chunks = list(openai_v1_chat_complete.stream_text_chat_completion(backend, [{"role": "user", "content": "今天有什么新闻？"}], "gpt-web"))
        self.assertEqual(chunks[0]["choices"][0]["delta"]["role"], "assistant")
        self.assertEqual(chunks[0]["choices"][0]["delta"]["content"], "给你整理了")
        self.assertEqual(chunks[1]["x_gpt_web"]["sources"], sources)
        self.assertEqual(chunks[2]["x_gpt_web"]["sources"], sources)
        self.assertEqual(chunks[-1]["choices"][0]["finish_reason"], "stop")

    def test_gpt_web_non_stream_includes_inline_links_extension(self):
        body = {
            "model": "gpt-web",
            "messages": [{"role": "user", "content": "给我直接下载链接。"}],
        }
        backend = object()
        inline_links = [{
            "id": "https://example.com/audio.mp3",
            "label": "Stories.mp3 直接下载",
            "url": "https://example.com/audio.mp3",
            "ref_indices": ["turn0search7"],
        }]
        events = iter([
            {"type": "conversation.delta", "delta": "直接下载：", "sources": [], "inline_links": []},
            {"type": "conversation.event", "sources": [], "inline_links": inline_links},
        ])
        with (
            mock.patch.object(openai_v1_chat_complete, "is_image_chat_request", return_value=False),
            mock.patch.object(openai_v1_chat_complete, "gpt_web_text_backend", return_value=backend),
            mock.patch.object(openai_v1_chat_complete, "text_backend"),
            mock.patch.object(openai_v1_chat_complete, "conversation_events", return_value=events),
        ):
            result = openai_v1_chat_complete.handle(body)
        self.assertEqual(result["choices"][0]["message"]["content"], "直接下载：")
        self.assertEqual(result["x_gpt_web"]["inline_links"], inline_links)

    def test_gpt_web_stream_includes_inline_links_extension(self):
        backend = object()
        inline_links = [{
            "id": "https://example.com/audio.mp3",
            "label": "Stories.mp3 直接下载",
            "url": "https://example.com/audio.mp3",
            "ref_indices": ["turn0search7"],
        }]
        events = iter([
            {"type": "conversation.delta", "delta": "直接下载：", "sources": [], "inline_links": []},
            {"type": "conversation.event", "sources": [], "inline_links": inline_links},
            {"type": "conversation.delta", "delta": "Stories", "sources": [], "inline_links": inline_links},
        ])
        with mock.patch.object(openai_v1_chat_complete, "conversation_events", return_value=events):
            chunks = list(openai_v1_chat_complete.stream_text_chat_completion(backend, [{"role": "user", "content": "给我直接下载链接。"}], "gpt-web"))
        self.assertEqual(chunks[1]["x_gpt_web"]["inline_links"], inline_links)
        self.assertEqual(chunks[2]["x_gpt_web"]["inline_links"], inline_links)
        self.assertEqual(chunks[-1]["x_gpt_web"]["inline_links"], inline_links)

    def test_text_completion_http(self):
        """测试文本对话的非流式 HTTP 调用。"""
        response = requests.post(
            f"{BASE_URL}/v1/chat/completions",
            headers={"Authorization": f"Bearer {AUTH_KEY}"},
            json={
                "model": "auto",
                "messages": [
                    {"role": "user", "content": "你好。"},
                    {"role": "assistant", "content": "你好，我可以帮助你处理文本和图片相关请求。"},
                    {"role": "user", "content": "那你再简单介绍一下你自己。"},
                ],
            },
            timeout=300,
        )
        print("text non-stream status:")
        print(response.status_code)
        print("text non-stream result:")
        print(json.dumps(response.json(), ensure_ascii=False, indent=2))

    def test_text_completion_stream_http(self):
        """测试文本对话的流式 HTTP 调用。"""
        response = requests.post(
            f"{BASE_URL}/v1/chat/completions",
            headers={"Authorization": f"Bearer {AUTH_KEY}"},
            json={
                "model": "auto",
                "stream": True,
                "messages": [
                    {"role": "user", "content": "你好。"},
                    {"role": "assistant", "content": "你好，我的名字是Claude。"},
                    {"role": "user", "content": "那你再简单介绍一下你自己，比如你的名字是什么。"},
                ],
            },
            stream=True,
            timeout=300,
        )
        print("text stream status:")
        print(response.status_code)
        print("text stream result:")
        for line in response.iter_lines():
            if line:
                print(line.decode("utf-8", errors="replace"))

    def test_image_completion_http(self):
        """测试图片对话的非流式 HTTP 调用。"""
        response = requests.post(
            f"{BASE_URL}/v1/chat/completions",
            headers={"Authorization": f"Bearer {AUTH_KEY}"},
            json={
                "model": "gpt-image-2",
                "messages": [
                    {"role": "user", "content": "我想做一张南京城市宣传海报图。"},
                ],
                "n": 1,
            },
            timeout=300,
        )
        payload = response.json()
        content = str((((payload.get("choices") or [{}])[0].get("message") or {}).get("content") or ""))
        saved_paths = save_images_from_text(content, "chat_completions_image_non_stream")
        print("image non-stream status:")
        print(response.status_code)
        print("image non-stream saved files:")
        for path in saved_paths:
            print(path)

    def test_image_completion_stream_http(self):
        """测试图片对话的流式 HTTP 调用。"""
        response = requests.post(
            f"{BASE_URL}/v1/chat/completions",
            headers={"Authorization": f"Bearer {AUTH_KEY}"},
            json={
                "model": "gpt-image-2",
                "stream": True,
                "messages": [
                    {"role": "user", "content": "我想做一张南京城市宣传海报图。"},
                ],
                "n": 1,
            },
            stream=True,
            timeout=300,
        )
        parts: list[str] = []
        started_at = time.time()
        print("image stream status:")
        print(response.status_code)
        print("image stream chunks:")
        for line in response.iter_lines():
            if not line:
                continue
            text = line.decode("utf-8", errors="replace")
            print(f"{time.time() - started_at:6.2f}s {text}")
            if not text.startswith("data:"):
                continue
            payload = text[5:].strip()
            if payload == "[DONE]":
                break
            try:
                chunk = json.loads(payload)
            except Exception:
                continue
            delta = ((chunk.get("choices") or [{}])[0].get("delta") or {})
            content = str(delta.get("content") or "")
            if content:
                parts.append(content)
        saved_paths = save_images_from_text("".join(parts), "chat_completions_image_stream")
        print("image stream saved files:")
        for path in saved_paths:
            print(path)
