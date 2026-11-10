"""
Analytics: the public menu open counter (use_cases.md UC-GUEST-004) and the owner's reads
(UC-OWNER-015 and UC-OWNER-016).

Views stay thin: validate with the serializer, call one service function, return a response.
In owner views the cafe always comes from request.user.cafe; IsCafeOwner guarantees that it exists.
"""

from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from users.permissions import IsActiveCafe, IsCafeOwner

from . import services
from .serializers import (
    AnalyticsDetailSerializer,
    AnalyticsSummarySerializer,
    MenuViewSerializer,
    PeriodSerializer,
)


class MenuViewCountView(APIView):
    """POST /api/v1/menu/{slug}/views/ (UC-GUEST-004): one menu open, { "table": N or null } -> 204."""

    # Public like the menu itself: a customer has no account, and a stray token header must not
    # cause a 401. No DRF throttle: Nginx limits this path with its own zone.
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request, slug):
        serializer = MenuViewSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        services.record_view(slug, serializer.validated_data['table'])
        return Response(status=status.HTTP_204_NO_CONTENT)


class AnalyticsSummaryView(APIView):
    """GET /api/v1/dashboard/analytics/summary/?days=7 (UC-OWNER-015): menu opens per day, every plan."""

    permission_classes = [IsCafeOwner, IsActiveCafe]  # Global Convention 5 (A3)

    def get(self, request):
        period = PeriodSerializer(data=request.query_params)
        period.is_valid(raise_exception=True)
        return Response(AnalyticsSummarySerializer(services.summary(request.user.cafe, **period.validated_data)).data)


class AnalyticsDetailView(APIView):
    """GET /api/v1/dashboard/analytics/detail/?days=7 (UC-OWNER-016): per hour and per table; the service checks the plan."""

    permission_classes = [IsCafeOwner, IsActiveCafe]  # the subscription check comes before the plan check (A4)

    def get(self, request):
        period = PeriodSerializer(data=request.query_params)
        period.is_valid(raise_exception=True)
        return Response(AnalyticsDetailSerializer(services.detail(request.user.cafe, **period.validated_data)).data)
