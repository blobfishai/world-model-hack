"""Structured Gemini calls shared by world planning, scan reconstruction and scan review."""
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import TypeVar

from google import genai
from google.genai import types
from pydantic import BaseModel

from task_rooms.config import required_key

Model = TypeVar("Model", bound=BaseModel)


def portable_schema(model: type[BaseModel]) -> dict:
    """The structured-output subset used by room_sim.builds.reconstruction_schema, for any model."""
    schema = model.model_json_schema()
    definitions = schema.get("$defs", {})

    def expand(node):
        if isinstance(node, list):
            return [expand(value) for value in node]
        if not isinstance(node, dict):
            return node
        if "$ref" in node:
            return expand(definitions[node["$ref"].split("/")[-1]])
        if "anyOf" in node:
            options = [expand(option) for option in node["anyOf"] if option.get("type") != "null"]
            return {**options[0], **({"description": node["description"]} if "description" in node else {})} if options else {}
        result = {}
        for key in ("type", "description", "properties", "items", "required"):
            if key in node:
                if key == "properties":
                    result[key] = {name: expand(value) for name, value in node[key].items()}
                else:
                    result[key] = expand(node[key])
        if "enum" in node and all(isinstance(value, str) for value in node["enum"]):
            result["enum"] = node["enum"]
        if "const" in node and isinstance(node["const"], str):
            result["enum"] = [node["const"]]
        return result

    return expand(schema)


def image_part(path: Path) -> types.Part:
    mime = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    return types.Part.from_bytes(data=path.read_bytes(), mime_type=mime)


def video_part(path: Path) -> types.Part:
    return types.Part.from_bytes(data=path.read_bytes(), mime_type="video/mp4")


def transient(error: BaseException) -> bool:
    text = str(error)
    return any(marker in text for marker in ("DEADLINE_EXCEEDED", "504", "503", "UNAVAILABLE", "429", "RESOURCE_EXHAUSTED"))


def generate(model: type[Model], contents: list, *, raw_path: Path | None = None, timeout_ms: int = 180_000) -> Model:
    client = genai.Client(api_key=required_key("GOOGLE_API_KEY"), http_options=types.HttpOptions(timeout=timeout_ms))
    try:
        for attempt in range(3):
            try:
                response = client.models.generate_content(
                    model=os.environ.get("GEMINI_MODEL", "gemini-3.8-flash"), contents=contents,
                    config=types.GenerateContentConfig(response_mime_type="application/json",
                                                       response_json_schema=portable_schema(model), temperature=0))
                break
            except Exception as error:
                # Server-side deadlines and overload are transient; schema and prompt errors are not.
                if attempt == 2 or not transient(error):
                    raise
                time.sleep(5 * (attempt + 1))
        if not response.text:
            raise ValueError("The model returned an empty response")
        if raw_path is not None:
            raw_path.parent.mkdir(parents=True, exist_ok=True)
            raw_path.write_text(response.text)
        return model.model_validate_json(response.text)
    finally:
        client.close()
