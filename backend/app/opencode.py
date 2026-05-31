import base64
import shlex

import requests


class OpenCodeClient:
    def __init__(self, base_url: str, username: str = "", password: str = ""):
        self.base_url = base_url.rstrip("/")
        self._auth_header = None
        if username and password:
            token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode(
                "utf-8"
            )
            self._auth_header = f"Basic {token}"

    def _headers(self) -> dict:
        headers = {"Accept": "application/json"}
        if self._auth_header:
            headers["Authorization"] = self._auth_header
        return headers

    @property
    def event_headers(self) -> dict:
        headers = self._headers()
        headers["Accept"] = "text/event-stream"
        return headers

    def health(self) -> dict:
        response = requests.get(
            f"{self.base_url}/global/health", headers=self._headers(), timeout=10
        )
        response.raise_for_status()
        return response.json()

    def create_session(self, directory: str, title: str | None = None) -> dict:
        payload: dict = {}
        if title:
            payload["title"] = title

        response = requests.post(
            f"{self.base_url}/session",
            params={"directory": directory},
            json=payload,
            headers=self._headers(),
            timeout=15,
        )
        response.raise_for_status()
        return response.json()

    def get_session(self, session_id: str) -> dict:
        response = requests.get(
            f"{self.base_url}/session/{session_id}",
            headers=self._headers(),
            timeout=10,
        )
        response.raise_for_status()
        return response.json()

    def delete_session(self, session_id: str) -> None:
        response = requests.delete(
            f"{self.base_url}/session/{session_id}",
            headers=self._headers(),
            timeout=15,
        )
        response.raise_for_status()

    def abort_session(self, session_id: str, directory: str | None = None) -> bool:
        params = {"directory": directory} if directory else None
        response = requests.post(
            f"{self.base_url}/session/{session_id}/abort",
            params=params,
            headers=self._headers(),
            timeout=20,
        )
        response.raise_for_status()
        data = response.json()
        return bool(data)

    def list_messages(
        self, session_id: str, limit: int = 100, directory: str | None = None
    ) -> list:
        params = {"limit": limit}
        if directory:
            params["directory"] = directory
        response = requests.get(
            f"{self.base_url}/session/{session_id}/message",
            params=params,
            headers=self._headers(),
            timeout=20,
        )
        response.raise_for_status()
        data = response.json()
        if isinstance(data, list):
            return data
        return []

    def list_projects(self) -> list[dict]:
        response = requests.get(
            f"{self.base_url}/project",
            headers=self._headers(),
            timeout=20,
        )
        response.raise_for_status()
        data = response.json()
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
        return []

    def list_sessions(
        self, limit: int = 200, directory: str | None = None
    ) -> list[dict]:
        params = {"limit": limit}
        if directory:
            params["directory"] = directory
        response = requests.get(
            f"{self.base_url}/session",
            params=params,
            headers=self._headers(),
            timeout=20,
        )
        response.raise_for_status()
        data = response.json()
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
        return []

    def get_config(self) -> dict:
        response = requests.get(
            f"{self.base_url}/config",
            headers=self._headers(),
            timeout=20,
        )
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, dict) else {}

    def list_config_providers(self) -> dict:
        response = requests.get(
            f"{self.base_url}/config/providers",
            headers=self._headers(),
            timeout=20,
        )
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, dict) else {}

    def send_message(
        self,
        session_id: str,
        directory: str,
        text: str,
        model: str | None = None,
        agent: str | None = None,
        timeout_seconds: int | None = None,
    ) -> dict:
        payload = {
            "directory": directory,
            "parts": [{"type": "text", "text": text}],
        }
        if model:
            provider_id, separator, model_id = model.partition("/")
            if separator and provider_id and model_id:
                payload["model"] = {
                    "providerID": provider_id,
                    "modelID": model_id,
                }
        if agent:
            payload["agent"] = agent
        response = requests.post(
            f"{self.base_url}/session/{session_id}/message",
            params={"directory": directory},
            json=payload,
            headers=self._headers(),
            timeout=max(1, int(timeout_seconds)) if timeout_seconds is not None else 180,
        )
        response.raise_for_status()
        return response.json()

    def send_message_async(
        self,
        session_id: str,
        directory: str,
        text: str,
        model: str | None = None,
        agent: str | None = None,
    ) -> None:
        payload = {
            "directory": directory,
            "parts": [{"type": "text", "text": text}],
        }
        if model:
            provider_id, separator, model_id = model.partition("/")
            if separator and provider_id and model_id:
                payload["model"] = {
                    "providerID": provider_id,
                    "modelID": model_id,
                }
        if agent:
            payload["agent"] = agent
        response = requests.post(
            f"{self.base_url}/session/{session_id}/prompt_async",
            params={"directory": directory},
            json=payload,
            headers=self._headers(),
            timeout=15,
        )
        response.raise_for_status()

    def run_command(
        self,
        session_id: str,
        command: str,
        arguments: list[str],
        directory: str | None = None,
    ) -> dict:
        serialized_arguments = shlex.join(arguments) if arguments else ""
        payload = {
            "command": command,
            "arguments": serialized_arguments,
        }
        params = {"directory": directory} if directory else None
        response = requests.post(
            f"{self.base_url}/session/{session_id}/command",
            params=params,
            json=payload,
            headers=self._headers(),
            timeout=120,
        )
        response.raise_for_status()
        return response.json()

    def get_diff(self, session_id: str, directory: str | None = None) -> list:
        params = {"directory": directory} if directory else None
        response = requests.get(
            f"{self.base_url}/session/{session_id}/diff",
            params=params,
            headers=self._headers(),
            timeout=20,
        )
        response.raise_for_status()
        data = response.json()
        if isinstance(data, list):
            return data
        return []

    def list_commands(self) -> list[dict]:
        response = requests.get(
            f"{self.base_url}/command",
            headers=self._headers(),
            timeout=15,
        )
        response.raise_for_status()
        data = response.json()
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
        return []

    def list_questions(self, directory: str | None = None) -> list[dict]:
        params = {"directory": directory} if directory else None
        response = requests.get(
            f"{self.base_url}/question",
            params=params,
            headers=self._headers(),
            timeout=15,
        )
        response.raise_for_status()
        data = response.json()
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
        return []

    def reply_question(
        self,
        request_id: str,
        answers: list[list[str]],
        directory: str | None = None,
    ) -> bool:
        params = {"directory": directory} if directory else None
        response = requests.post(
            f"{self.base_url}/question/{request_id}/reply",
            params=params,
            json={"answers": answers},
            headers=self._headers(),
            timeout=20,
        )
        response.raise_for_status()
        data = response.json()
        return bool(data)

    def reject_question(self, request_id: str, directory: str | None = None) -> bool:
        params = {"directory": directory} if directory else None
        response = requests.post(
            f"{self.base_url}/question/{request_id}/reject",
            params=params,
            headers=self._headers(),
            timeout=20,
        )
        response.raise_for_status()
        data = response.json()
        return bool(data)

    def compact_session(self, session_id: str, directory: str | None = None) -> bool:
        params = {"directory": directory} if directory else None
        response = requests.post(
            f"{self.base_url}/session/{session_id}/compact",
            params=params,
            headers=self._headers(),
            timeout=30,
        )
        response.raise_for_status()
        return response.status_code == 204

    def summarize_session(
        self,
        session_id: str,
        provider_id: str,
        model_id: str,
        directory: str | None = None,
        auto: bool = False,
    ) -> bool:
        params = {"directory": directory} if directory else None
        payload = {
            "providerID": provider_id,
            "modelID": model_id,
            "auto": auto,
        }
        response = requests.post(
            f"{self.base_url}/session/{session_id}/summarize",
            params=params,
            json=payload,
            headers=self._headers(),
            timeout=30,
        )
        response.raise_for_status()
        return response.status_code in (200, 204)

    def respond_permission(
        self,
        session_id: str,
        directory: str | None,
        permission_id: str,
        response_value: str,
        remember: bool = False,
    ) -> bool:
        params = {"directory": directory} if directory else None
        response = requests.post(
            f"{self.base_url}/session/{session_id}/permissions/{permission_id}",
            params=params,
            json={"response": response_value, "remember": remember},
            headers=self._headers(),
            timeout=20,
        )
        response.raise_for_status()
        data = response.json()
        return bool(data)
