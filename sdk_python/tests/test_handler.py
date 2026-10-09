"""Tests for ZipLoggerHandler against a local in-process HTTP server (stdlib only).

Run:  py -3 -m unittest discover sdk_python/tests -v
"""

import json
import logging
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ziplogger import ZipLoggerHandler  # noqa: E402


class _Server:
    """Scriptable HTTP server capturing NDJSON bodies."""

    def __init__(self):
        self.requests = []
        self.responses = []  # queued status codes; default 202
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                status = outer.responses.pop(0) if outer.responses else 202
                outer.requests.append({
                    "path": self.path,
                    "api_key": self.headers.get("X-Api-Key"),
                    "lines": [json.loads(l) for l in body.decode().splitlines() if l],
                    "status": status,
                })
                self.send_response(status)
                if status == 429:
                    self.send_header("Retry-After", "0")
                self.end_headers()

            def log_message(self, *args):  # silence
                pass

        self.httpd = HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def url(self):
        return f"http://127.0.0.1:{self.port}"

    def wait_for(self, count, timeout=5.0):
        deadline = time.time() + timeout
        while len(self.requests) < count:
            if time.time() > deadline:
                raise TimeoutError(f"expected {count} requests, saw {len(self.requests)}")
            time.sleep(0.02)

    def stop(self):
        self.httpd.shutdown()


def make_handler(server, **kw):
    defaults = dict(flush_interval=0.05, retry_base_delay=0.01, track_sessions=False)
    defaults.update(kw)
    return ZipLoggerHandler(endpoint=server.url(), api_key="zk_test", **defaults)


class HandlerTests(unittest.TestCase):
    def setUp(self):
        self.server = _Server()

    def tearDown(self):
        self.server.stop()

    def _logger(self, handler):
        logger = logging.getLogger(f"test.{id(handler)}")
        logger.setLevel(logging.DEBUG)
        logger.handlers = [handler]
        logger.propagate = False
        return logger

    def test_batches_ndjson_with_api_key_and_enrichment(self):
        handler = make_handler(self.server, source="unit-test", release="1.2.3", commit_sha="abc1234")
        log = self._logger(handler)
        for i in range(5):
            log.info("event %d", i, extra={"orderId": i})
        handler.close()

        self.server.wait_for(1)
        req = self.server.requests[0]
        self.assertEqual(req["path"], "/ingest/v1/logs")
        self.assertEqual(req["api_key"], "zk_test")
        self.assertEqual(len(req["lines"]), 5)
        first = req["lines"][0]
        self.assertEqual(first["message"], "event 0")
        self.assertEqual(first["severity"], "info")
        self.assertEqual(first["source"], "unit-test")
        self.assertEqual(first["release"], "1.2.3")
        self.assertEqual(first["commitSha"], "abc1234")
        self.assertEqual(first["fields"]["orderId"], 0)
        self.assertIn("machineName", first["fields"])

    def test_exception_maps_to_stack_trace(self):
        handler = make_handler(self.server)
        log = self._logger(handler)
        try:
            raise ValueError("boom")
        except ValueError:
            log.exception("it failed")
        handler.close()

        self.server.wait_for(1)
        entry = self.server.requests[0]["lines"][0]
        self.assertEqual(entry["severity"], "error")
        self.assertIn("ValueError: boom", entry["stackTrace"])
        self.assertEqual(entry["fields"]["exceptionType"], "ValueError")

    def test_severity_mapping(self):
        handler = make_handler(self.server)
        log = self._logger(handler)
        log.debug("d"); log.info("i"); log.warning("w"); log.error("e"); log.critical("c")
        handler.close()

        self.server.wait_for(1)
        severities = [l["severity"] for l in self.server.requests[0]["lines"]]
        self.assertEqual(severities, ["debug", "info", "warn", "error", "fatal"])

    def test_retries_on_429_then_succeeds(self):
        self.server.responses = [429, 429, 202]
        handler = make_handler(self.server)
        log = self._logger(handler)
        log.info("retry me")
        handler.close()

        self.server.wait_for(3)
        self.assertEqual([r["status"] for r in self.server.requests], [429, 429, 202])
        self.assertEqual(handler.dropped, 0)

    def test_drops_after_max_retries(self):
        self.server.responses = [500, 500, 500]
        handler = make_handler(self.server, max_retries=2)
        log = self._logger(handler)
        log.info("doomed")
        handler.close()

        self.server.wait_for(3)
        self.assertEqual(handler.dropped, 1)

    def test_non_transient_errors_do_not_retry(self):
        self.server.responses = [401]
        handler = make_handler(self.server)
        log = self._logger(handler)
        log.info("bad key")
        handler.close()

        self.server.wait_for(1)
        self.assertEqual(len(self.server.requests), 1)
        self.assertEqual(handler.dropped, 1)

    def test_queue_overflow_drops_instead_of_blocking(self):
        handler = make_handler(self.server, queue_size=3, flush_interval=60)
        log = self._logger(handler)
        start = time.time()
        for i in range(50):
            log.info("burst %d", i)
        self.assertLess(time.time() - start, 1.0)  # never blocked
        self.assertGreaterEqual(handler.dropped, 40)
        handler.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
