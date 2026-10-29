"""
Owner dashboard: cafe settings (use_cases.md UC-OWNER-009, UC-OWNER-010 and UC-OWNER-014)
and QR codes (UC-OWNER-007, UC-OWNER-008 and UC-OWNER-011).
Super Admin: cafe management (UC-ADMIN-001 to UC-ADMIN-009).

Views stay thin: validate with the serializer, call one service function, return a response.
In owner views the cafe always comes from request.user.cafe; IsCafeOwner guarantees that it exists.
Admin views take the cafe id from the URL; IsSystemAdmin checks role == SYSTEM_ADMIN, never is_staff.
"""

from io import BytesIO

from django.http import FileResponse
from rest_framework import status
from rest_framework.pagination import PageNumberPagination
from rest_framework.parsers import MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from users.permissions import IsActiveCafe, IsCafeOwner, IsSystemAdmin

from . import services
from .serializers import (
    AdminCafeCreateSerializer,
    AdminCafeSerializer,
    AdminCafeSummarySerializer,
    AdminCafeUpdateSerializer,
    BillingEventSerializer,
    CafeSettingsSerializer,
    LogoUploadSerializer,
    PlatformStatsSerializer,
    QRCodesSerializer,
    QRGenerateSerializer,
)


class CafeSettingsView(APIView):
    """GET and PATCH /api/v1/dashboard/settings/"""

    def get_permissions(self):
        # Global Convention 5: GET is the only dashboard endpoint without the active-cafe check,
        # so the frontend can show the "subscription inactive" state (UC-OWNER-014 A1).
        if self.request.method == 'GET':
            return [IsCafeOwner()]
        return [IsCafeOwner(), IsActiveCafe()]

    def get(self, request):
        return Response(CafeSettingsSerializer(services.get_settings(request.user.cafe)).data)

    def patch(self, request):
        serializer = CafeSettingsSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        cafe = services.update_settings(request.user.cafe, **serializer.validated_data)
        return Response(CafeSettingsSerializer(cafe).data)


class CafeLogoView(APIView):
    """POST /api/v1/dashboard/settings/logo/ (UC-OWNER-010): multipart/form-data, answers the updated settings."""

    permission_classes = [IsCafeOwner, IsActiveCafe]  # Global Convention 5 (A5)
    parser_classes = [MultiPartParser]  # the contract is a file upload; a JSON body gets 415

    def post(self, request):
        serializer = LogoUploadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        cafe = services.upload_logo(request.user.cafe, image_file=serializer.validated_data['image'])
        return Response(CafeSettingsSerializer(cafe).data)


class QRGenerateView(APIView):
    """POST /api/v1/dashboard/qr/generate/ (UC-OWNER-007): { table_count } -> the active tables with QR codes."""

    permission_classes = [IsCafeOwner, IsActiveCafe]  # Global Convention 5 (A5)

    def post(self, request):
        serializer = QRGenerateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        codes = services.generate_qr_codes(request.user.cafe, serializer.validated_data['table_count'])
        return Response(QRCodesSerializer(codes).data)  # 200, not 201: it syncs, it may create nothing (A3)


class QRPreviewView(APIView):
    """GET /api/v1/dashboard/qr/preview/ (UC-OWNER-011): read-only, same answer as qr/generate/."""

    permission_classes = [IsCafeOwner, IsActiveCafe]  # Global Convention 5 (A2): only GET settings skips it

    def get(self, request):
        return Response(QRCodesSerializer(services.preview_qr_codes(request.user.cafe)).data)


class QRDownloadPDFView(APIView):
    """GET /api/v1/dashboard/qr/download-pdf/ (UC-OWNER-008): the print-ready PDF as a download."""

    permission_classes = [IsCafeOwner, IsActiveCafe]  # Global Convention 5 (A2)

    def get(self, request):
        pdf = services.qr_pdf(request.user.cafe)
        # FileResponse streams the bytes and sets Content-Disposition: attachment; filename="qrcodes.pdf".
        return FileResponse(BytesIO(pdf), as_attachment=True, filename='qrcodes.pdf', content_type='application/pdf')


class AdminCafePagination(PageNumberPagination):
    """UC-ADMIN-002: ?page=N with 20 cafes per page; answers { count, next, previous, results }."""

    page_size = 20


class AdminCafeListView(APIView):
    """GET (UC-ADMIN-002) and POST (UC-ADMIN-001) /api/v1/admin/cafes/"""

    permission_classes = [IsSystemAdmin]

    def get(self, request):
        cafes = services.list_cafes(search=request.query_params.get('search', '').strip())
        paginator = AdminCafePagination()
        page = paginator.paginate_queryset(cafes, request, view=self)
        return paginator.get_paginated_response(AdminCafeSummarySerializer(page, many=True).data)

    def post(self, request):
        serializer = AdminCafeCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        cafe = services.create_cafe(**serializer.validated_data)
        return Response(AdminCafeSerializer(cafe).data, status=status.HTTP_201_CREATED)


class AdminCafeDetailView(APIView):
    """GET (UC-ADMIN-003), PATCH (UC-ADMIN-006) and DELETE (UC-ADMIN-007) /api/v1/admin/cafes/{id}/"""

    permission_classes = [IsSystemAdmin]

    def get(self, request, pk):
        return Response(AdminCafeSerializer(services.get_cafe(pk)).data)

    def patch(self, request, pk):
        serializer = AdminCafeUpdateSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        cafe = services.update_cafe(pk, performed_by=request.user, **serializer.validated_data)
        return Response(AdminCafeSerializer(cafe).data)

    def delete(self, request, pk):
        services.delete_cafe(pk)
        return Response(status=status.HTTP_204_NO_CONTENT)


class AdminCafeActivateView(APIView):
    """POST /api/v1/admin/cafes/{id}/activate/ (UC-ADMIN-004): answers the updated cafe."""

    permission_classes = [IsSystemAdmin]

    def post(self, request, pk):
        return Response(AdminCafeSerializer(services.activate_cafe(pk, performed_by=request.user)).data)


class AdminCafeDeactivateView(APIView):
    """POST /api/v1/admin/cafes/{id}/deactivate/ (UC-ADMIN-005): answers the updated cafe."""

    permission_classes = [IsSystemAdmin]

    def post(self, request, pk):
        return Response(AdminCafeSerializer(services.deactivate_cafe(pk, performed_by=request.user)).data)


class AdminCafeBillingView(APIView):
    """GET /api/v1/admin/cafes/{id}/billing/ (UC-ADMIN-008): a plain list, newest first, not paginated."""

    permission_classes = [IsSystemAdmin]

    def get(self, request, pk):
        return Response(BillingEventSerializer(services.billing_history(pk), many=True).data)


class AdminStatsView(APIView):
    """GET /api/v1/admin/stats/ (UC-ADMIN-009)"""

    permission_classes = [IsSystemAdmin]

    def get(self, request):
        return Response(PlatformStatsSerializer(services.platform_stats()).data)
