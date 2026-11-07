"""Server-Sent Events parsing for `GET /api/v1/events/sse`.

Frames are `id: N`, `event: <type>`, `data: <json>`, separated by a blank
line; lines starting with `:` are comments (connect banner, keepalives).
Control frames have no id: `subscription_revoked`, `credential_revoked`,
`auth_unavailable`, `reauthenticate`, `cursor_expired`, `replay_truncated`.
See docs/realtime.md.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator, List, Optional

CONTROL_EVENTS = frozenset(
    {
        "subscription_revoked",
        "credential_revoked",
        "auth_unavailable",
        "reauthenticate",
        "cursor_expired",
        "replay_truncated",
    }
)


@dataclass
class SseFrame:
    event: str = "message"
    data: str = ""
    id: Optional[str] = None
    retry: Optional[int] = None

    @property
    def is_control(self) -> bool:
        return self.event in CONTROL_EVENTS

    def json(self) -> Any:
        try:
            return json.loads(self.data) if self.data else None
        except ValueError:
            return None


@dataclass
class SseParser:
    """Incremental parser: feed lines, get complete frames."""

    _event: Optional[str] = None
    _data: List[str] = field(default_factory=list)
    _id: Optional[str] = None
    _retry: Optional[int] = None

    def feed_line(self, line: str) -> Optional[SseFrame]:
        line = line.rstrip("\r\n")
        if line == "":
            return self._dispatch()
        if line.startswith(":"):
            return None
        name, sep, value = line.partition(":")
        if sep and value.startswith(" "):
            value = value[1:]
        if name == "event":
            self._event = value
        elif name == "data":
            self._data.append(value)
        elif name == "id":
            if "\0" not in value:
                self._id = value
        elif name == "retry":
            if value.isdigit():
                self._retry = int(value)
        return None

    def _dispatch(self) -> Optional[SseFrame]:
        if self._event is None and not self._data and self._id is None:
            # A blank line after a comment or a retry-only block.
            self._retry = None
            return None
        frame = SseFrame(
            event=self._event or "message",
            data="\n".join(self._data),
            id=self._id,
            retry=self._retry,
        )
        self._event, self._data, self._id, self._retry = None, [], None, None
        return frame


def parse_sse(lines: Iterable[str]) -> Iterator[SseFrame]:
    """Every complete frame in `lines` (a trailing partial frame is dropped)."""
    parser = SseParser()
    for line in lines:
        frame = parser.feed_line(line)
        if frame is not None:
            yield frame
