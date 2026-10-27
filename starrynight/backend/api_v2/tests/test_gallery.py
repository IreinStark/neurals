import shutil
import tempfile

import cv2
import numpy as np
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import AccessToken

from api_v2.models import Artwork

MEDIA = tempfile.mkdtemp(prefix="gallery-test-")


def _jpeg(seed=0, size=(48, 64)):
    img = np.random.default_rng(seed).integers(0, 255, (*size, 3), dtype=np.uint8)
    return cv2.imencode(".jpg", img)[1].tobytes()


def _file(name="work.jpg", data=None, ctype="image/jpeg"):
    return SimpleUploadedFile(name, data if data is not None else _jpeg(), content_type=ctype)


@override_settings(MEDIA_ROOT=MEDIA, GALLERY_QUOTA_BYTES=10 * 1024 * 1024, PUBLIC_BASE_URL="")
class GalleryApiTests(APITestCase):
    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(MEDIA, ignore_errors=True)

    def setUp(self):
        User = get_user_model()
        self.alice = User.objects.create_user("alice@neu.edu.tr", "alice@neu.edu.tr", "pw-123456", first_name="Alice")
        self.bob = User.objects.create_user("bob@neu.edu.tr", "bob@neu.edu.tr", "pw-123456")
        self.as_user(self.alice)

    def as_user(self, user):
        if user is None:
            self.client.credentials()
        else:
            self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {AccessToken.for_user(user)}")

    def save(self, **extra):
        data = {"media": _file(), "kind": "image", "title": "Golden Gate — Starry Night", "style": "starry"}
        data.update(extra)
        return self.client.post("/api/v2/gallery/", data, format="multipart")

    # --------------------------------------------------------------- CRUD

    def test_requires_login(self):
        self.as_user(None)
        self.assertEqual(self.client.get("/api/v2/gallery/").status_code, 401)

    def test_save_list_and_stats(self):
        r = self.save()
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(r.data["media_url"].startswith("/media/gallery/"))
        self.assertGreater(r.data["size_bytes"], 0)
        r = self.client.get("/api/v2/gallery/")
        self.assertEqual(len(r.data["works"]), 1)
        self.assertEqual(r.data["stats"]["works"], 1)
        self.assertEqual(r.data["stats"]["used_bytes"], r.data["works"][0]["size_bytes"])
        self.assertEqual(r.data["stats"]["quota_bytes"], 10 * 1024 * 1024)

    def test_users_only_see_their_own_works(self):
        self.save()
        self.as_user(self.bob)
        self.assertEqual(self.client.get("/api/v2/gallery/").data["works"], [])
        art = Artwork.objects.get()
        self.assertEqual(self.client.delete(f"/api/v2/gallery/{art.id}/").status_code, 404)

    def test_video_with_poster(self):
        r = self.save(media=_file("clip.webm", b"\x1aE\xdf\xa3" + b"0" * 200, "video/webm"), poster=_file("p.jpg"),
                      kind="video", duration="00:14")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(r.data["poster_url"].endswith(".jpg"))
        self.assertEqual(r.data["duration"], "00:14")

    def test_rejects_wrong_type_and_missing_title(self):
        self.assertEqual(self.save(media=_file("x.txt", b"hi", "text/plain")).status_code, 400)
        self.assertEqual(self.save(title="  ").status_code, 400)
        self.assertEqual(self.save(kind="gif").status_code, 400)

    def test_client_id_makes_saves_idempotent(self):
        a = self.save(client_id="abc123")
        b = self.save(client_id="abc123")
        self.assertEqual(b.status_code, 200)
        self.assertEqual(a.data["id"], b.data["id"])
        self.assertEqual(Artwork.objects.count(), 1)

    @override_settings(GALLERY_QUOTA_BYTES=1000)
    def test_quota_is_enforced(self):
        r = self.save(media=_file(data=_jpeg(size=(200, 200))))
        self.assertEqual(r.status_code, 413)
        self.assertEqual(r.json()["error"]["code"], "quota_exceeded")

    def test_delete_removes_files(self):
        art_id = self.save().data["id"]
        path = Artwork.objects.get(pk=art_id).media.path
        self.assertEqual(self.client.delete(f"/api/v2/gallery/{art_id}/").status_code, 204)
        import os

        self.assertFalse(os.path.exists(path))

    def test_rename_and_sort(self):
        first = self.save(title="A").data["id"]
        second = self.save(title="B").data["id"]
        self.client.post(f"/api/v2/gallery/{first}/like/")
        self.assertEqual(self.client.patch(f"/api/v2/gallery/{first}/", {"title": "A2"}).data["title"], "A2")
        ids = [w["id"] for w in self.client.get("/api/v2/gallery/?sort=liked").data["works"]]
        self.assertEqual(ids, [first, second])
        self.assertEqual(self.client.get("/api/v2/gallery/?kind=video").data["works"], [])

    # --------------------------------------------------------------- likes

    def test_like_toggles_and_counts_favorites(self):
        art_id = self.save().data["id"]
        r = self.client.post(f"/api/v2/gallery/{art_id}/like/")
        self.assertEqual((r.data["liked"], r.data["likes"]), (True, 1))
        self.assertEqual(self.client.get("/api/v2/gallery/").data["stats"]["favorites"], 1)
        r = self.client.post(f"/api/v2/gallery/{art_id}/like/")
        self.assertEqual((r.data["liked"], r.data["likes"]), (False, 0))

    def test_others_can_like_only_shared_works(self):
        art_id = self.save().data["id"]
        self.as_user(self.bob)
        self.assertEqual(self.client.post(f"/api/v2/gallery/{art_id}/like/").status_code, 404)
        self.as_user(self.alice)
        self.client.post(f"/api/v2/gallery/{art_id}/share/")
        self.as_user(self.bob)
        self.assertEqual(self.client.post(f"/api/v2/gallery/{art_id}/like/").data["likes"], 1)

    # --------------------------------------------------------------- sharing

    def test_share_link_is_public_counts_views_and_can_be_revoked(self):
        art_id = self.save().data["id"]
        r = self.client.post(f"/api/v2/gallery/{art_id}/share/")
        token = r.data["token"]
        self.assertTrue(r.data["url"].endswith(f"/s/{token}/"))
        self.assertEqual(self.client.post(f"/api/v2/gallery/{art_id}/share/").data["token"], token)  # stable

        self.client.get(f"/api/v2/share/{token}/")  # owner viewing: not counted
        self.as_user(None)
        pub = self.client.get(f"/api/v2/share/{token}/")
        self.assertEqual(pub.status_code, 200)
        self.assertEqual(pub.data["views"], 1)
        self.assertEqual(pub.data["owner"], {"name": "Alice"})
        self.assertNotIn("share_token", pub.data)
        self.assertNotIn("email", str(pub.data))

        self.as_user(self.alice)
        self.assertEqual(self.client.delete(f"/api/v2/gallery/{art_id}/share/").status_code, 204)
        self.as_user(None)
        self.assertEqual(self.client.get(f"/api/v2/share/{token}/").status_code, 404)

    @override_settings(ALLOWED_HOSTS=["testserver", "studio.example.com"])
    def test_share_page_has_open_graph_tags_and_redirects(self):
        art_id = self.save(title='Night <script>').data["id"]
        token = self.client.post(f"/api/v2/gallery/{art_id}/share/").data["token"]
        self.as_user(None)
        r = self.client.get(f"/s/{token}/", HTTP_X_FORWARDED_HOST="studio.example.com")
        html = r.content.decode()
        self.assertEqual(r.status_code, 200)
        self.assertIn('property="og:image" content="http://studio.example.com/media/gallery/', html)
        self.assertIn("Night &lt;script&gt;", html)
        self.assertNotIn("Night <script>", html)
        self.assertIn(f"/#/share/{token}", html)
        self.assertEqual(self.client.get("/s/nope/").status_code, 404)
