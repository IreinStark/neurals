# User Gallery and Social Sharing (GP2 feature 3)

## What the user gets

| Design element | Now does |
|---|---|
| **Save to Gallery** (Image Transfer, Video Upload) | Signed in: uploads the styled image, or the styled video plus a poster frame, to the account. Signed out: kept in this browser (IndexedDB) and uploaded automatically the next time you open the gallery signed in. |
| **Gallery grid**, tabs, sort | The user's own works from the server (`?kind=`, `?sort=newest\|liked\|views`). The demo works only show when signed out. |
| **♥ like** | A real like (one per user, counted on the server). The "Favorites" stat counts works you've liked. |
| **Delete** | Deletes the record and its files from storage. Any share link stops working. |
| **Share → link → Copy** | Creates a public link `https://<site>/s/<token>/`. No login needed to view it. |
| **Shared page** (`#/share/<token>`) | Loads the work from the public API (with a video player for videos) and shows the owner's initials. A revoked link says it's no longer available. |
| **Cloud Storage bar** | Real usage vs the per-user quota (`GALLERY_QUOTA_MB`, default 1 GB). |

**Social previews.** WhatsApp, X, Instagram DMs, Slack and similar apps don't run JavaScript or read `#fragments`, so the
share link points at `/s/<token>/`. That's a small Django page with Open Graph and Twitter-card tags (title, preview
image or video poster) which redirects people into the studio. Pasting the link into a chat shows a preview card.

## API (`/api/v2`, JWT)

```
GET    gallery/?kind=&sort=           {works:[…], stats:{works, views, favorites, used_bytes, quota_bytes}}
POST   gallery/                       multipart: media, poster?, kind, title, style?, duration?, client_id?   → 201
GET/PATCH/DELETE gallery/<id>/        PATCH {title}
POST   gallery/<id>/like/             toggle → {liked, likes}   (others can like only shared works)
POST   gallery/<id>/share/            → {token, url, page_url}  (stable token)
DELETE gallery/<id>/share/            revoke
GET    share/<token>/                 public; counts a view unless the owner is viewing; no email or private fields
GET    /s/<token>/                    Open Graph preview page → /#/share/<token>
```

Validation:
- images: JPEG, PNG or WebP, up to 15 MB;
- videos: MP4 or WebM, up to 100 MB;
- the quota is checked before saving (413 `quota_exceeded`);
- `client_id` makes retries idempotent.

Models: `api_v2.Artwork` and `api_v2.ArtworkLike` (migration `0001_gallery`). Tests: `api_v2/tests/test_gallery.py` (13). The e2e
tests are in `web/e2e/studio.spec.ts` (signed-in gallery, sharing, revoked link).

## Storage (cloud)

Files go through Django's default storage. Locally that's `media/gallery/<user>/`. For cloud storage, install
`django-storages[s3]` and set:

```
MEDIA_STORAGE=s3  S3_BUCKET=…  S3_ACCESS_KEY_ID=…  S3_SECRET_ACCESS_KEY=…
S3_ENDPOINT_URL=https://<project>.supabase.co/storage/v1/s3   # Supabase Storage / R2 / MinIO; omit for AWS
S3_REGION=…
```

Deploying behind a public domain: set `ALLOWED_HOSTS=your.domain`, and `PUBLIC_BASE_URL=https://your.domain` if the
proxy doesn't forward the host (Next.js does, so `USE_X_FORWARDED_HOST` is on by default).

The access token lasts 5 minutes. The studio now refreshes it automatically (`/accounts/login/refresh/`), so long
sessions don't fail with "authentication credentials were not provided".
