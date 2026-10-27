"""
ASGI entry point: Django HTTP plus the live-streaming WebSocket (Django Channels).

`python manage.py runserver` serves both (daphne is in INSTALLED_APPS); in production run
`daphne writer_backend.asgi:application`.
"""
import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "writer_backend.settings")
django_app = get_asgi_application()

from channels.routing import ProtocolTypeRouter, URLRouter  # noqa: E402
from channels.security.websocket import AllowedHostsOriginValidator  # noqa: E402

from streaming.auth import JwtQueryAuthMiddleware  # noqa: E402
from streaming.routing import websocket_urlpatterns  # noqa: E402

application = ProtocolTypeRouter({
    "http": django_app,
    "websocket": AllowedHostsOriginValidator(JwtQueryAuthMiddleware(URLRouter(websocket_urlpatterns))),
})
