from django.test import SimpleTestCase
from django.urls import reverse


class HealthTests(SimpleTestCase):
    def test_health_ok(self):
        res = self.client.get(reverse("api_v2:health"))
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {"status": "ok", "service": "starrynight-backend", "api": "v2"})

    def test_health_rejects_post(self):
        self.assertEqual(self.client.post(reverse("api_v2:health")).status_code, 405)


class StylesTests(SimpleTestCase):
    def test_lists_all_eight_styles_with_contract_fields(self):
        body = self.client.get(reverse("api_v2:styles")).json()
        ids = [s["id"] for s in body["styles"]]
        self.assertEqual(
            sorted(ids),
            sorted(["starry-night", "mosaic", "udnie", "wave", "tokyo-ghoul", "lazy", "bayanihan", "pointilism"]),
        )
        for style in body["styles"]:
            self.assertEqual(set(style), {"id", "label", "serverAvailable", "onnx"})

    def test_server_availability_reflects_checkpoints(self):
        styles = {s["id"]: s for s in self.client.get(reverse("api_v2:styles")).json()["styles"]}
        self.assertTrue(styles["starry-night"]["serverAvailable"])  # models/starry/starry80.pth is in the repo
        self.assertFalse(styles["pointilism"]["serverAvailable"])  # browser-only model
        self.assertEqual(styles["pointilism"]["onnx"], "/models/pointilism-10.onnx")
