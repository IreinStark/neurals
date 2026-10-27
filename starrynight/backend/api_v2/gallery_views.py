"""
Gallery + social sharing (GP2 feature 3).

Authenticated (JWT):
  GET    /api/v2/gallery/?kind=image|video|webcam&sort=newest|liked|views   → {works, stats}
  POST   /api/v2/gallery/            multipart: media, poster?, kind, title, style?, duration?, client_id?
  GET    /api/v2/gallery/<id>/       PATCH {title}     DELETE
  POST   /api/v2/gallery/<id>/like/  toggle            → {liked, likes}
  POST   /api/v2/gallery/<id>/share/ create link       → {token, url, page_url}
  DELETE /api/v2/gallery/<id>/share/ revoke link
Public:
  GET    /api/v2/share/<token>/      shared work (counts a view unless the owner is looking)
  GET    /s/<token>/                 HTML with Open Graph / Twitter card tags → redirects to the studio
"""
from html import escape

from django.conf import settings
from django.db import transaction
from django.db.models import F, Sum
from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.authentication import JWTAuthentication

from .errors import error_response
from .models import Artwork, ArtworkLike

IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
VIDEO_TYPES = {"video/mp4", "video/webm", "video/quicktime"}
MAX_IMAGE_BYTES = 15 * 1024 * 1024
MAX_VIDEO_BYTES = 100 * 1024 * 1024
SORTS = {"newest": ["-created_at"], "liked": ["-like_count", "-created_at"], "views": ["-views", "-created_at"]}


def quota_bytes() -> int:
    return int(getattr(settings, "GALLERY_QUOTA_BYTES", 1024 ** 3))


def _url(request, f):
    if not f:
        return None
    url = f.url  # relative /media/... (served through the Next proxy) unless storage returns absolute URLs
    base = getattr(settings, "PUBLIC_BASE_URL", "")
    return base.rstrip("/") + url if base and not url.startswith("http") else url


def _abs(request, path):
    base = getattr(settings, "PUBLIC_BASE_URL", "")
    return base.rstrip("/") + path if base else request.build_absolute_uri(path)


def _display_name(user):
    full = f"{user.first_name} {user.last_name}".strip()
    return full or user.username.split("@")[0]


def serialize(request, a: Artwork, liked=None, public=False):
    data = {
        "id": a.id,
        "title": a.title,
        "kind": a.kind,
        "style": a.style,
        "media_url": _url(request, a.media),
        "poster_url": _url(request, a.poster),
        "duration": a.duration,
        "likes": a.like_count,
        "views": a.views,
        "created_at": a.created_at.isoformat(),
        "owner": {"name": _display_name(a.owner)},
    }
    if not public:
        data.update({
            "liked": bool(liked),
            "size_bytes": a.size_bytes,
            "client_id": a.client_id,
            "shared": bool(a.share_token),
            "share_token": a.share_token,
        })
    return data


def _stats(user):
    qs = Artwork.objects.filter(owner=user)
    agg = qs.aggregate(views=Sum("views"), used=Sum("size_bytes"))
    return {
        "works": qs.count(),
        "views": agg["views"] or 0,
        "favorites": ArtworkLike.objects.filter(user=user).count(),
        "used_bytes": agg["used"] or 0,
        "quota_bytes": quota_bytes(),
    }


def _validate_upload(upload, kind):
    ctype = (getattr(upload, "content_type", "") or "").split(";")[0].strip().lower()
    if kind == Artwork.KIND_IMAGE:
        if ctype not in IMAGE_TYPES:
            return error_response(400, "invalid_media", "Images must be JPEG, PNG or WebP.")
        if upload.size > MAX_IMAGE_BYTES:
            return error_response(413, "file_too_large", "Images must be under 15 MB.")
    else:
        if ctype not in VIDEO_TYPES and ctype not in IMAGE_TYPES:
            return error_response(400, "invalid_media", "Videos must be MP4 or WebM.")
        if upload.size > MAX_VIDEO_BYTES:
            return error_response(413, "file_too_large", "Videos must be under 100 MB.")
    return None



@api_view(["GET", "POST"])
@authentication_classes([JWTAuthentication])
@permission_classes([IsAuthenticated])
def gallery(request):
    user = request.user
    if request.method == "GET":
        qs = Artwork.objects.filter(owner=user).select_related("owner")
        kind = request.GET.get("kind")
        if kind in dict(Artwork.KIND_CHOICES):
            qs = qs.filter(kind=kind)
        qs = qs.order_by(*SORTS.get(request.GET.get("sort", "newest"), SORTS["newest"]))
        liked = set(ArtworkLike.objects.filter(user=user, artwork__in=qs).values_list("artwork_id", flat=True))
        return Response({"works": [serialize(request, a, a.id in liked) for a in qs], "stats": _stats(user)})

    media, poster = request.FILES.get("media"), request.FILES.get("poster")
    kind = request.data.get("kind", Artwork.KIND_IMAGE)
    title = (request.data.get("title") or "").strip()[:120]
    if kind not in dict(Artwork.KIND_CHOICES):
        return error_response(400, "invalid_kind", "kind must be image, video or webcam.")
    if media is None:
        return error_response(400, "missing_media", "Attach the artwork file as 'media'.")
    if not title:
        return error_response(400, "missing_title", "Give the artwork a title.")
    err = _validate_upload(media, kind)
    if err:
        return err
    if poster is not None:
        if (getattr(poster, "content_type", "") or "") not in IMAGE_TYPES or poster.size > MAX_IMAGE_BYTES:
            return error_response(400, "invalid_poster", "The poster must be an image under 15 MB.")
    client_id = (request.data.get("client_id") or "")[:32]
    if client_id:
        existing = Artwork.objects.filter(owner=user, client_id=client_id).first()
        if existing:  # idempotent retry of the same save
            return Response(serialize(request, existing, ArtworkLike.objects.filter(user=user, artwork=existing).exists()), status=200)

    size = media.size + (poster.size if poster else 0)
    used = _stats(user)["used_bytes"]
    if used + size > quota_bytes():
        return error_response(413, "quota_exceeded", "Your gallery storage is full. Delete some works to make room.",
                              {"used_bytes": used, "quota_bytes": quota_bytes()})

    art = Artwork(owner=user, kind=kind, title=title, style=(request.data.get("style") or "")[:64],
                  duration=(request.data.get("duration") or "")[:8], size_bytes=size, client_id=client_id)
    art.media.save(media.name or "work", media, save=False)
    if poster is not None:
        art.poster.save("poster.jpg", poster, save=False)
    art.save()
    return Response(serialize(request, art, False), status=201)


@api_view(["GET", "PATCH", "DELETE"])
@authentication_classes([JWTAuthentication])
@permission_classes([IsAuthenticated])
def artwork_detail(request, pk):
    art = get_object_or_404(Artwork, pk=pk, owner=request.user)
    if request.method == "DELETE":
        art.delete()
        return Response(status=204)
    if request.method == "PATCH":
        title = (request.data.get("title") or "").strip()[:120]
        if not title:
            return error_response(400, "missing_title", "Give the artwork a title.")
        art.title = title
        art.save(update_fields=["title"])
    liked = ArtworkLike.objects.filter(user=request.user, artwork=art).exists()
    return Response(serialize(request, art, liked))


@api_view(["POST"])
@authentication_classes([JWTAuthentication])
@permission_classes([IsAuthenticated])
def artwork_like(request, pk):
    with transaction.atomic():
        art = get_object_or_404(Artwork.objects.select_for_update(), pk=pk)
        if art.owner_id != request.user.id and not art.share_token:
            return error_response(404, "not_found", "Artwork not found.")
        like = ArtworkLike.objects.filter(user=request.user, artwork=art).first()
        if like:
            like.delete()
            Artwork.objects.filter(pk=art.pk, like_count__gt=0).update(like_count=F("like_count") - 1)
        else:
            ArtworkLike.objects.create(user=request.user, artwork=art)
            Artwork.objects.filter(pk=art.pk).update(like_count=F("like_count") + 1)
        art.refresh_from_db(fields=["like_count"])
    return Response({"liked": not like, "likes": art.like_count})


@api_view(["POST", "DELETE"])
@authentication_classes([JWTAuthentication])
@permission_classes([IsAuthenticated])
def artwork_share(request, pk):
    art = get_object_or_404(Artwork, pk=pk, owner=request.user)
    if request.method == "DELETE":
        art.share_token = None
        art.save(update_fields=["share_token"])
        return Response(status=204)
    token = art.ensure_share_token()
    return Response({"token": token, "url": _abs(request, f"/s/{token}/"), "page_url": _abs(request, f"/#/share/{token}")})


@api_view(["GET"])
@authentication_classes([JWTAuthentication])
@permission_classes([AllowAny])
def shared(request, token):
    art = get_object_or_404(Artwork.objects.select_related("owner"), share_token=token)
    if not (request.user.is_authenticated and request.user.id == art.owner_id):
        Artwork.objects.filter(pk=art.pk).update(views=F("views") + 1)
        art.views += 1
    return Response(serialize(request, art, public=True))


def share_page(request, token):
    """Link-preview page for social apps (they don't run JS or read #fragments), then redirect to the studio."""
    art = Artwork.objects.select_related("owner").filter(share_token=token).first()
    target = f"/#/share/{token}"
    if art is None:
        return HttpResponse("<!doctype html><title>Link expired</title><p>This share link was removed by its owner.</p>",
                            status=404)
    image = art.poster if art.kind != Artwork.KIND_IMAGE and art.poster else art.media
    img_url = _abs(request, image.url) if image and not image.url.startswith("http") else (image.url if image else "")
    title = escape(f"{art.title} · Neural Style Studio")
    desc = escape(f"Styled by {_display_name(art.owner)} with Neural Style Studio. Create your own — free, in the browser.")
    page = _abs(request, f"/s/{token}/")
    video = ""
    if art.kind != Artwork.KIND_IMAGE:
        video = f'<meta property="og:video" content="{escape(_abs(request, art.media.url))}">'
    html = f"""<!doctype html><html><head><meta charset="utf-8"><title>{title}</title>
<meta property="og:type" content="{'video.other' if video else 'website'}"><meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}"><meta property="og:url" content="{escape(page)}">
<meta property="og:image" content="{escape(img_url)}">{video}
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{desc}"><meta name="twitter:image" content="{escape(img_url)}">
<meta http-equiv="refresh" content="0;url={escape(target)}"></head>
<body><script>location.replace({target!r})</script><a href="{escape(target)}">Open the artwork</a></body></html>"""
    return HttpResponse(html)
