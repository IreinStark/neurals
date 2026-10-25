from django.apps import AppConfig


class ApiV2Config(AppConfig):
    """GP2 whiteboard API (docs/ARCHITECTURE_SPEC.md §7). v1 endpoints stay in style_transfer/."""

    default_auto_field = "django.db.models.BigAutoField"
    name = "api_v2"
    label = "api_v2"
