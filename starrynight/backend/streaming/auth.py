"""Channels middleware: authenticate a WebSocket from a SimpleJWT access token in the query string (?token=)."""
from urllib.parse import parse_qs

from channels.db import database_sync_to_async
from django.contrib.auth.models import AnonymousUser


@database_sync_to_async
def _user_for(token: str):
    from django.contrib.auth import get_user_model
    from rest_framework_simplejwt.exceptions import TokenError
    from rest_framework_simplejwt.tokens import AccessToken

    try:
        user_id = AccessToken(token)["user_id"]
        return get_user_model().objects.get(pk=user_id)
    except (TokenError, KeyError, Exception):
        return AnonymousUser()


class JwtQueryAuthMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        token = (parse_qs(scope.get("query_string", b"").decode()).get("token") or [""])[0]
        scope = dict(scope, user=(await _user_for(token)) if token else AnonymousUser())
        return await self.app(scope, receive, send)
