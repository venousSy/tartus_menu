from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied
from rest_framework.validators import UniqueValidator

from core.serializer_fields import BilingualNameField

from .models import Cafe, SubscriptionPlan

User = get_user_model()


def primary_color_field():
    """A color: "#RRGGBB" (6 hexadecimal digits) or "" for the default theme (UC-OWNER-009 A3, UC-ADMIN-006 A5)."""
    return serializers.RegexField(
        r'^#[0-9A-Fa-f]{6}$', allow_blank=True, error_messages={'invalid': 'Enter a color in #RRGGBB format.'}
    )


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
    primary_color = primary_color_field()  # A3
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


class AdminCafeSummarySerializer(serializers.Serializer):
    """One row of the Super Admin's cafe list (UC-ADMIN-002)."""

    id = serializers.IntegerField()
    name = BilingualNameField()
    slug = serializers.CharField()
    plan = serializers.CharField(source='plan.name')  # the plan code, "basic" or "pro", as in the create request
    is_active = serializers.BooleanField()
    owner_email = serializers.EmailField(source='owner.email')


class AdminCafeSerializer(AdminCafeSummarySerializer):
    """The full cafe object (UC-ADMIN-003), also the answer of create, activate, deactivate and edit."""

    subscription_start_at = serializers.DateTimeField()  # null until the first activation
    subscription_end_at = serializers.DateTimeField()
    # Stored values, also when the plan hides them from customers (Global Convention 7).
    logo_url = serializers.CharField()
    primary_color = serializers.CharField()


class OwnerAccountSerializer(serializers.Serializer):
    """The "owner" object of the create request (UC-ADMIN-001). Its errors stay nested under "owner"."""

    email = serializers.EmailField(
        max_length=255,
        # iexact: emails are stored lowercased (users.models), so "Owner@x.com" is the same account (A2).
        validators=[UniqueValidator(
            queryset=User.objects.all(), lookup='iexact', message='A user with this email already exists.'
        )],
    )
    password = serializers.CharField(write_only=True, trim_whitespace=False)

    def validate(self, attrs):
        # The platform's password rules (AUTH_PASSWORD_VALIDATORS), the same as UC-AUTH-004.
        # An unsaved user lets the similarity rule compare the password with the email.
        try:
            validate_password(attrs['password'], User(email=attrs['email']))
        except DjangoValidationError as exc:
            raise serializers.ValidationError({'password': list(exc.messages)})
        return attrs


class AdminCafeCreateSerializer(serializers.Serializer):
    """Body of POST /api/v1/admin/cafes/ (UC-ADMIN-001): { slug, name, plan, owner: { email, password } }."""

    slug = serializers.SlugField(
        max_length=100,
        validators=[UniqueValidator(queryset=Cafe.objects.all(), message='A cafe with this slug already exists.')],
    )  # A1
    name = BilingualNameField()  # A5
    plan = serializers.SlugRelatedField(slug_field='name', queryset=SubscriptionPlan.objects.all())  # A3
    owner = OwnerAccountSerializer()


class AdminCafeUpdateSerializer(serializers.Serializer):
    """
    Body of PATCH /api/v1/admin/cafes/{id}/ (UC-ADMIN-006): any of name, slug, primary_color and plan.
    The service checks that a new slug is free (A1), because only it knows the cafe's current slug.
    """

    name = BilingualNameField()  # A6
    slug = serializers.SlugField(max_length=100)
    primary_color = primary_color_field()  # A5; stored even when the plan hides it
    plan = serializers.SlugRelatedField(slug_field='name', queryset=SubscriptionPlan.objects.all())

    # Cafe fields that only other flows may change, with the use case's messages (A3, A4).
    protected_fields = {
        'is_active': 'Use the activate or deactivate endpoint.',
        'logo_url': 'This field cannot be changed here. The cafe owner uploads the logo.',
    }

    def to_internal_value(self, data):
        # Rejected, not silently ignored: the admin must see that the change did not happen.
        if isinstance(data, dict):
            errors = {key: [message] for key, message in self.protected_fields.items() if key in data}
            if errors:
                raise serializers.ValidationError(errors)
        return super().to_internal_value(data)


class BillingEventSerializer(serializers.Serializer):
    """One entry of a cafe's billing history (UC-ADMIN-008)."""

    action = serializers.CharField()  # "activated", "deactivated" or "plan_changed"
    notes = serializers.CharField()
    # null when that admin account was deleted later (performed_by is SET_NULL)
    performed_by_email = serializers.EmailField(source='performed_by.email', allow_null=True)
    created_at = serializers.DateTimeField()


class PlatformStatsSerializer(serializers.Serializer):
    """The admin home page numbers (UC-ADMIN-009)."""

    total_cafes = serializers.IntegerField()
    active_cafes = serializers.IntegerField()
    inactive_cafes = serializers.IntegerField()
    basic_plan_count = serializers.IntegerField()
    pro_plan_count = serializers.IntegerField()
