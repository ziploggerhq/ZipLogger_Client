"""Release health: one session per process, sent to ``POST /ingest/v1/sessions``.

The update has the shape Sentry SDKs use (``sid, did, started, timestamp, status, errors, attrs.release``); the server
keeps the latest update per ``sid``.

  * started: when the handler is created (sent in the background);
  * first ERROR-level record: ``errors`` is sent once (later errors are not re-sent);
  * normal end: status ``exited`` when the handler is closed, which ``logging`` does at interpreter exit;
  * crash: status ``crashed`` from an uncaught exception in the main thread, sent synchronously (at most 3 seconds) from
    ``sys.excepthook`` before the previous hook runs, so tracebacks and other hooks behave as before.

Best effort throughout: nothing here raises or retries.
"""

from __future__ import annotations

import json
import sys
import threading
import urllib.request
import uuid
from datetime import datetime, timezone
from typing import Optional


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ReleaseSession:
    def __init__(self, url: str, api_key: str, release: str, environment: str, distinct_id: Optional[str], timeout: float) -> None:
        self._url = url
        self._api_key = api_key
        self._release = release
        self._environment = environment
        self._distinct_id = distinct_id
        self._timeout = timeout
        self.sid = str(uuid.uuid4())
        self.started = _now()
        self.status = "ok"
        self.errors = 0
        self._lock = threading.Lock()
        self._previous_hook = sys.excepthook
        sys.excepthook = self._excepthook
        self._send_in_background()

    def error(self) -> None:
        with self._lock:
            if self.status != "ok":
                return
            self.errors += 1
            first = self.errors == 1
        if first:
            self._send_in_background()

    def end(self) -> None:
        """Ends the session normally and sends it (synchronously, bounded by the handler's timeout)."""
        with self._lock:
            if self.status != "ok":
                return
            self.status = "exited"
        self._restore_hook()
        self._send(self._timeout)

    def crash(self) -> None:
        with self._lock:
            if self.status != "ok":
                return
            self.status = "crashed"
            self.errors = max(1, self.errors)
        self._send(min(self._timeout, 3.0))

    def _excepthook(self, exc_type, exc, tb) -> None:  # type: ignore[no-untyped-def]
        if not issubclass(exc_type, KeyboardInterrupt):  # Ctrl+C is someone stopping it, not a crash
            self.crash()
        self._previous_hook(exc_type, exc, tb)

    def _restore_hook(self) -> None:
        if sys.excepthook is self._excepthook:  # only when nobody chained on top of us
            sys.excepthook = self._previous_hook

    def _send_in_background(self) -> None:
        threading.Thread(target=self._send, args=(self._timeout,), name="ziplogger-session", daemon=True).start()

    def _send(self, timeout: float) -> None:
        with self._lock:
            update = {
                "sid": self.sid, "did": self._distinct_id, "started": self.started, "timestamp": _now(),
                "status": self.status, "errors": self.errors,
                "attrs": {"release": self._release, "environment": self._environment},
            }
        try:
            request = urllib.request.Request(
                self._url,
                data=json.dumps([update]).encode("utf-8"),
                headers={"Content-Type": "application/json", "X-Api-Key": self._api_key},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=timeout):
                pass
        except Exception:  # noqa: BLE001 — release health is best effort
            pass
