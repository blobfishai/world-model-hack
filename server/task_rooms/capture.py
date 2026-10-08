from __future__ import annotations

import queue
import subprocess
import threading
from pathlib import Path


class VideoCapture:
    """Encode received BGRA frames without blocking the native WebRTC callback."""

    def __init__(self, path: Path, fps: float = 24, *, preset: str = "veryfast", queue_frames: int = 64) -> None:
        self.path = path
        self.fps = fps
        self.preset = preset
        self.frames = 0
        self.error: BaseException | None = None
        self._queue: queue.Queue[tuple[bytes, int, int] | None] = queue.Queue(maxsize=queue_frames)
        self._thread = threading.Thread(target=self._encode, name="reactor-video-capture", daemon=True)
        self._closed = False
        self._thread.start()

    def add(self, bgra, width: int, height: int) -> None:
        if self._closed or self.error:
            return
        try:
            # Own the buffer: the native callback's memory can be reused on return.
            self._queue.put_nowait((bytes(bgra), width, height))
        except queue.Full:
            self.error = RuntimeError("Video encoder fell behind; output would lose frames")

    def _encode(self) -> None:
        process = None
        dimensions = None
        log = None
        try:
            while True:
                item = self._queue.get()
                if item is None:
                    break
                data, width, height = item
                if len(data) != width * height * 4:
                    raise ValueError("Received an incomplete BGRA video frame")
                if process is None:
                    dimensions = (width, height)
                    log = self.path.with_suffix(".encoder.log").open("wb")
                    process = subprocess.Popen(
                        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgra",
                         "-s", f"{width}x{height}", "-framerate", str(self.fps), "-i", "pipe:0",
                         "-an", "-c:v", "libx264", "-preset", self.preset, "-crf", "20",
                         "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(self.path)],
                        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=log,
                    )
                if dimensions != (width, height):
                    raise ValueError("Reactor changed output resolution during one clip")
                assert process.stdin is not None
                process.stdin.write(data)
                self.frames += 1
            if process is not None:
                assert process.stdin is not None
                process.stdin.close()
                if process.wait(timeout=15) != 0:
                    raise RuntimeError("Video encoding failed; inspect the encoder log")
        except BaseException as exc:
            self.error = exc
        finally:
            if process is not None and process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            if log:
                log.close()

    def finish(self) -> None:
        if self._closed:
            if self.error:
                raise self.error
            return
        self._closed = True
        if self._thread.is_alive():
            try:
                self._queue.put(None, timeout=10)
            except queue.Full:
                self.error = RuntimeError("Video encoder could not finish its queued frames")
        self._thread.join(timeout=20)
        if self._thread.is_alive():
            raise RuntimeError("Video encoder did not stop")
        if self.error:
            raise self.error
        if self.frames == 0:
            raise ValueError("Reactor returned no video frames")
