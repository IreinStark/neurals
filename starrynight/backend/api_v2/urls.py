from django.urls import path

from . import views

app_name = "api_v2"

urlpatterns = [
    path("health/", views.health, name="health"),
    path("styles/", views.styles, name="styles"),
]
