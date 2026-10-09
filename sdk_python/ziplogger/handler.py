"""ZipLogger logging handler.

Design goals (mirroring the official .NET client):
  * a logging call never blocks and never raises — delivery is fully asynchronous;
  * bounded queue with drop-on-backpressure (counted, never unbounded memory);
  * NDJSON batches over HTTP with retry + exponential backoff, honoring 429 Retry-After;
  * automatic enrichment: source, release, commit SHA, environment, hostname;
  * standard library only — no dependencies.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import random
import socket
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .session import ReleaseSession

# LogRecord attributes that are internal to the logging module — everything else
# passed via `extra=` becomes a searchable ZipLogger field.
_RESERVED = frozenset(
    "name msg args levelname levelno pathname filename module exc_info exc_text stack_info "
    "lineno funcName created msecs relativeCreated thread threadName processName process "
    "taskName message asctime".split()
)

_SEVERITY = {
    logging.DEBUG: "debug",
    logging.INFO: "info",
    logging.WARNING: "warn",
    logging.ERROR: "error",
    logging.CRITICAL: "fatal",
}


class ZipLoggerHandler(logging.Handler):
    """Ships log records to a ZipLogger server in the background."""

    def __init__(
        self,
        endpoint: str,
        api_key: str,
        *,
        source: Optional[str] = None,
        release: Optional[str] = None,
        commit_sha: Optional[str] = None,
        environment: Optional[str] = None,
        tags: Optional[List[str]] = None,
        queue_size: int = 10_000,
        batch_size: int = 100,
        flush_interval: float = 2.0,
        max_retries: int = 5,
        retry_base_delay: float = 0.5,
        retry_max_delay: float = 30.0,
        timeout: float = 10.0,
        level: int = logging.NOTSET,
        track_sessions: bool = True,
        session_distinct_id: Optional[str] = None,
    ) -> None:
        super().__init__(level)
        if not endpoint:
            raise ValueError("ZipLogger: endpoint is required")
        if not api_key:
            raise ValueError("ZipLogger: api_key is required")

        trimmed = endpoint.rstrip("/")
        self._url = trimmed if trimmed.endswith("/logs") else trimmed + "/ingest/v1/logs"
        self._api_key = api_key
        self._batch_size = max(1, batch_size)
        self._flush_interval = flush_interval
        self._max_retries = max_retries
        self._retry_base_delay = retry_base_delay
        self._retry_max_delay = retry_max_delay
        self._timeout = timeout

        self._source = source or os.environ.get("ZIPLOGGER_SOURCE") or _default_source()
        self._release = release or os.environ.get("ZIPLOGGER_RELEASE")
        self._commit_sha = (
            commit_sha
            or os.environ.get("ZIPLOGGER_COMMIT_SHA")
            or os.environ.get("GIT_COMMIT")
            or os.environ.get("COMMIT_SHA")
        )
        self._environment = (
            environment
            or os.environ.get("ZIPLOGGER_ENVIRONMENT")
            or os.environ.get("ENVIRONMENT")
            or "production"
        )
        self._hostname = socket.gethostname()
        self._tags = list(tags) if tags else None

        self.dropped = 0  # entries lost to backpressure or exhausted retries
        self._queue: "queue.Queue[Optional[dict]]" = queue.Queue(maxsize=max(1, queue_size))
        self._closing = threading.Event()
        self._worker = threading.Thread(target=self._pump, name="ziplogger-shipper", daemon=True)
        self._worker.start()

        # Release health: one session per process when a release is known (see session.py).
        base = trimmed[: -len("/ingest/v1/logs")] if trimmed.endswith("/ingest/v1/logs") else trimmed
        self._session = (
            ReleaseSession(base + "/ingest/v1/sessions", api_key, self._release, self._environment, session_distinct_id, timeout)
            if track_sessions and self._release
            else None
        )

    @property
    def session_status(self) -> Optional[str]:
        """This process's release-health session status ("ok", "exited", "crashed"), or None when not tracked."""
        return self._session.status if self._session else None

    # ------------------------------------------------------------------ emit

    def emit(self, record: logging.LogRecord) -> None:  # never blocks, never raises
        try:
            entry = self._to_entry(record)
        except Exception:  # noqa: BLE001 — formatting must not break the app
            self.handleError(record)
            return
        try:
            self._queue.put_nowait(entry)
        except queue.Full:
            self.dropped += 1
        if record.levelno >= logging.ERROR and self._session:
            self._session.error()

    def _to_entry(self, record: logging.LogRecord) -> dict:
        fields: Dict[str, Any] = {"category": record.name}
        for key, value in record.__dict__.items():
            if key in _RESERVED or key.startswith("_"):
                continue
            fields[key] = value if isinstance(value, (str, int, float, bool)) or value is None else str(value)
        fields["environment"] = self._environment
        fields["machineName"] = self._hostname

        entry: Dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "severity": _SEVERITY.get(record.levelno, "info" if record.levelno < logging.WARNING else "error"),
            "message": record.getMessage(),
            "source": self._source,
            "fields": fields,
        }
        if self._release:
            entry["release"] = self._release
        if self._commit_sha:
            entry["commitSha"] = self._commit_sha
        if self._tags:
            entry["tags"] = self._tags

        if record.exc_info and record.exc_info[0] is not None:
            entry["stackTrace"] = "".join(traceback.format_exception(*record.exc_info)).rstrip()
            fields["exceptionType"] = record.exc_info[0].__name__
            fields["exceptionMessage"] = str(record.exc_info[1])
        return entry

    # ------------------------------------------------------------------ worker

    def _pump(self) -> None:
        batch: List[dict] = []
        # When the batch must go out, regardless of what arrives next. flush_interval is the
        # maximum age of the oldest entry in a batch, not an idle timeout: re-arming the wait on
        # every arrival meant a service logging steadily faster than the interval never went idle,
        # so nothing shipped until the batch hit batch_size -- 100 seconds of held logs at one
        # record a second.
        deadline: Optional[float] = None
        while True:
            timeout = None if deadline is None else max(0.0, deadline - time.monotonic())
            try:
                item = self._queue.get(timeout=timeout)
            except queue.Empty:
                item = ...  # flush marker: the oldest entry reached flush_interval
            if item is None:  # close sentinel
                self._send(batch)
                return
            if item is not ...:
                batch.append(item)
                if deadline is None:  # first entry of a new batch starts the clock
                    deadline = time.monotonic() + self._flush_interval
            if len(batch) >= self._batch_size or (item is ... and batch):
                self._send(batch)
                batch = []
                deadline = None

    def _send(self, batch: List[dict]) -> None:
        if not batch:
            return
        payload = ("\n".join(json.dumps(entry, default=str) for entry in batch)).encode("utf-8")

        for attempt in range(self._max_retries + 1):
            retry_after: Optional[float] = None
            try:
                request = urllib.request.Request(
                    self._url,
                    data=payload,
                    headers={"Content-Type": "application/x-ndjson", "X-Api-Key": self._api_key},
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=self._timeout):
                    return  # 2xx
            except urllib.error.HTTPError as error:
                if error.code not in (408, 429) and error.code < 500:
                    self.dropped += len(batch)  # 400/401/... — retrying cannot help
                    return
                header = error.headers.get("Retry-After") if error.headers else None
                if header:
                    try:
                        retry_after = float(header)
                    except ValueError:
                        retry_after = None
            except OSError:
                pass  # network failure / timeout — transient

            if attempt >= self._max_retries:
                self.dropped += len(batch)
                return
            delay = retry_after if retry_after is not None else min(
                self._retry_base_delay * (2**attempt), self._retry_max_delay
            ) * (1 + random.random() * 0.2)
            if self._closing.wait(min(delay, self._retry_max_delay)):
                # Closing: one immediate final attempt happens via the loop; don't sleep out the shutdown.
                pass

    # ------------------------------------------------------------------ close

    def close(self) -> None:
        """Flush buffered entries (bounded wait) and stop the worker."""
        if not self._closing.is_set():
            self._closing.set()
            try:
                self._queue.put_nowait(None)
            except queue.Full:
                pass
            self._worker.join(timeout=5.0)
            if self._session:
                self._session.end()
        super().close()


def _default_source() -> str:
    main = sys.modules.get("__main__")
    path = getattr(main, "__file__", None)
    return os.path.splitext(os.path.basename(path))[0] if path else "python"
