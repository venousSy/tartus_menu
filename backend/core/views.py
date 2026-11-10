"""
Project-wide views: the JSON 404 handler that core/urls.py registers as Django's error handler, and the
health check that the uptime monitor and the Docker healthchecks call (system_design.md §3.7).
"""

from django.db import DatabaseError, connection
from django.http import JsonResponse
from rest_framework import status
from rest_framework.exceptions import APIException
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView


def json_not_found(request, exception):
    """
    handler404: a URL that matches no route, for example /api/v1/dashboard/categories/abc/
    (<int:pk> rejects "abc"), answers like every API 404: {"detail": "Not found."} (Global Convention 2).

    Django calls it only when DEBUG=False (tests and production). DRF views answer their own
    404s; this covers the requests that never reach a view.
    """
    return JsonResponse({'detail': 'Not found.'}, status=404)


class DatabaseUnavailable(APIException):
    """503 from the health check. DRF has no 503 exception of its own."""

    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    default_detail = 'Database unavailable.'
    default_code = 'db_unavailable'  # the X-Error-Code header (core/exceptions.py)


class HealthView(APIView):
    """
    GET /api/v1/health/: 200 {"status": "ok"} when Django answers and PostgreSQL runs one query,
    503 {"detail": "Database unavailable."} otherwise. No login and no throttle: it reveals nothing
    and costs one tiny query. No business rule either, so no service layer.
    """

    authentication_classes = []  # a stale Authorization header must not turn the check into a 401
    permission_classes = [AllowAny]

    def get(self, request):
        try:
            with connection.cursor() as cursor:
                cursor.execute('SELECT 1')
        except DatabaseError as error:
            raise DatabaseUnavailable() from error
        return Response({'status': 'ok'})
