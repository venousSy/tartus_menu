"""
Project-wide error views. core/urls.py registers them as Django's error handlers.
"""

from django.http import JsonResponse


def json_not_found(request, exception):
    """
    handler404: a URL that matches no route, for example /api/v1/dashboard/categories/abc/
    (<int:pk> rejects "abc"), answers like every API 404: {"detail": "Not found."} (Global Convention 2).

    Django calls it only when DEBUG=False (tests and production). DRF views answer their own
    404s; this covers the requests that never reach a view.
    """
    return JsonResponse({'detail': 'Not found.'}, status=404)
