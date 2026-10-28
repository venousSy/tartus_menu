from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied

from core.serializer_fields import BilingualNameField


class PlanSerializer(serializers.Serializer):
    """The plan part of the settings answer: its code and the limits and flags the UI needs."""

    name = serializers.CharField()  # the stored code: "basic" or "pro"
    max_categories = serializers.IntegerField(allow_null=True)  # null = unlimited
    max_items = serializers.IntegerField(allow_null=True)
    allows_images = serializers.BooleanField()
    allows_branding = serializers.BooleanField()


class CafeSettingsSerializer(serializers.Serializer):
    """
    Cafe settings for the owner dashboard (UC-OWNER-009 and UC-OWNER-014).

    Input (PATCH): name and primary_color. Output: { name, slug, primary_color, logo_url, is_active,
    plan: { name, max_categories, max_items, allows_images, allows_branding } }.
    slug (Super Admin only), logo_url (UC-OWNER-010), is_active and plan are read-only.
    Stored values are returned even when the plan hides them from customers (Global Convention 7).
    """

    name = BilingualNameField()
    slug = serializers.CharField(read_only=True)
    # "#RRGGBB" (6 hexadecimal digits) or "" for the default theme (A3).
    primary_color = serializers.RegexField(
        r'^#[0-9A-Fa-f]{6}$', allow_blank=True, error_messages={'invalid': 'Enter a color in #RRGGBB format.'}
    )
    logo_url = serializers.CharField(read_only=True)
    is_active = serializers.BooleanField(read_only=True)
    plan = PlanSerializer(read_only=True)

    def to_internal_value(self, data):
        # A1: a slug in the body rejects the whole request before any field is checked,
        # so nothing is updated even when the other fields are valid.
        if isinstance(data, dict) and 'slug' in data:
            raise PermissionDenied('Only a Super Admin can change the cafe slug.')
        return super().to_internal_value(data)


class LogoUploadSerializer(serializers.Serializer):
    """
    Body of the logo upload (UC-OWNER-010): multipart/form-data with the file in "image",
    the same field name as the item image upload (UC-OWNER-006).
    """

    # FileField, not ImageField: the service checks the content (core.images) with the use case's messages.
    image = serializers.FileField()


class QRGenerateSerializer(serializers.Serializer):
    """Body of POST qr/generate/ (UC-OWNER-007): { "table_count": 1-200 }."""

    # A1 (missing, not an integer, 0 or negative) and A2 (> 200) use DRF's own field-level messages,
    # e.g. {"table_count": ["Ensure this value is less than or equal to 200."]}.
    table_count = serializers.IntegerField(min_value=1, max_value=200)


class QRTableSerializer(serializers.Serializer):
    """One active table with its QR code, as built by cafes.services."""

    id = serializers.IntegerField()
    table_number = serializers.IntegerField()
    url = serializers.CharField()
    qr_token = serializers.UUIDField()
    qr_image_url = serializers.CharField()  # "data:image/png;base64,..."


class QRCodesSerializer(serializers.Serializer):
    """Answer of qr/generate/ (UC-OWNER-007) and qr/preview/ (UC-OWNER-011): same shape for both."""

    table_count = serializers.IntegerField()
    tables = QRTableSerializer(many=True)
