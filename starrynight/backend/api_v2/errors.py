"""v2 error envelope: {"error": {"code", "message", "details"}} (spec §7.4)."""
from typing import Any, Dict, Optional

from django.http import JsonResponse


def error_response(status: int, code: str, message: str, details: Optional[Dict[str, Any]] = None) -> JsonResponse:
    body: Dict[str, Any] = {"error": {"code": code, "message": message}}
    if details:
        body["error"]["details"] = details
    return JsonResponse(body, status=status)
