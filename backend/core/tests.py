"""
Tests for the project-wide pieces in core/: the JSON 404 handler (use_cases.md Global Convention 2).
"""

from django.test import SimpleTestCase


class JsonNotFoundTests(SimpleTestCase):
    """handler404. The test runner sets DEBUG=False, as in production, so Django uses the handler."""

    def test_unmatched_urls_answer_the_api_404(self):
        urls = [
            '/api/v1/dashboard/categories/abc/',  # <int:pk> rejects "abc" before any view runs
            '/api/v1/admin/cafes/1/unknown/',
            '/api/v1/not-an-endpoint/',
        ]
        for url in urls:
            with self.subTest(url=url):
                response = self.client.get(url)

                self.assertEqual(response.status_code, 404)
                self.assertEqual(response['Content-Type'], 'application/json')
                self.assertEqual(response.json(), {'detail': 'Not found.'})
