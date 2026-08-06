#!/usr/bin/env python3
"""Small dependency-free static server for this viewer prototype."""

from __future__ import annotations

import argparse
import mimetypes
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


PROJECT_ROOT = Path(__file__).resolve().parent.parent
MIME_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
}


class StaticHandler(BaseHTTPRequestHandler):
    """Serve only files that resolve beneath PROJECT_ROOT; no directory listings."""

    server_version = "D2BViewerStatic/0.1"

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlsplit(self.path)
        requested = unquote(parsed.path)
        if chr(0) in requested:
            self.send_error(HTTPStatus.BAD_REQUEST, "invalid path")
            return
        relative = requested.lstrip("/") or "index.html"
        candidate = (PROJECT_ROOT / relative).resolve()
        try:
            candidate.relative_to(PROJECT_ROOT)
        except ValueError:
            self.send_error(HTTPStatus.FORBIDDEN, "path escapes project root")
            return
        if candidate.is_dir():
            candidate = (candidate / "index.html").resolve()
            try:
                candidate.relative_to(PROJECT_ROOT)
            except ValueError:
                self.send_error(HTTPStatus.FORBIDDEN, "path escapes project root")
                return
        if not candidate.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "file not found")
            return
        try:
            body = candidate.read_bytes()
        except OSError:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "could not read file")
            return
        content_type = MIME_TYPES.get(candidate.suffix.lower())
        if content_type is None:
            content_type = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        # Request logs are intentional local terminal output, not telemetry.
        super().log_message(format, *args)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Serve the local Device-to-Browser Viewer static tree without opening a browser."
    )
    parser.add_argument("--host", default="127.0.0.1", help="bind host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8080, help="bind TCP port (default: 8080)")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not 1 <= args.port <= 65535:
        raise SystemExit("--port must be between 1 and 65535")
    server = ThreadingHTTPServer((args.host, args.port), StaticHandler)
    print(f"Serving {PROJECT_ROOT} at http://{args.host}:{args.port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping static server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
