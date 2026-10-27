from django.urls import path

from .consumers import LiveStyleConsumer

websocket_urlpatterns = [path("ws/live/", LiveStyleConsumer.as_asgi())]
