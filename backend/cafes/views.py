"""
Owner dashboard: cafe settings (use_cases.md UC-OWNER-009, UC-OWNER-010 and UC-OWNER-014)
and QR codes (UC-OWNER-007 and UC-OWNER-011).

Views stay thin: validate with the serializer, call one service function, return a response.
The cafe always comes from request.user.cafe; IsCafeOwner guarantees that it exists.
"""

from rest_framework.parsers import MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from users.permissions import IsActiveCafe, IsCafeOwner

from . import services
from .serializers import CafeSettingsSerializer, LogoUploadSerializer, QRCodesSerializer, QRGenerateSerializer


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
