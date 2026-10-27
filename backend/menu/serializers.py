from decimal import Decimal

from rest_framework import serializers

from core.serializer_fields import BilingualDescriptionField, BilingualNameField


class CategorySerializer(serializers.Serializer):
    """
    Categories for the owner dashboard (UC-OWNER-001 and UC-OWNER-012).

    Input (POST, PATCH): name and optional is_visible. Nothing else is accepted:
    id and sort_order are read-only, and the cafe always comes from request.user.cafe.
    Output: { id, name: {ar, en}, sort_order, is_visible }.

    A plain Serializer, not a ModelSerializer: writes go through menu/services.py,
    so this class has no create()/update() and serializer.save() cannot bypass the plan rules.
    """

    id = serializers.IntegerField(read_only=True)
    name = BilingualNameField()
    # Changed only by reorder (UC-OWNER-003); a new category gets it from the service.
    sort_order = serializers.IntegerField(read_only=True)
    # Optional: when it is not sent, create uses True and edit keeps the current value.
    is_visible = serializers.BooleanField(required=False)


class ReorderSerializer(serializers.Serializer):
    """
    Input of a reorder call: {"ordered_ids": [3, 1, 2]} (UC-OWNER-003; UC-OWNER-004 sends the same body).

    Shape only: a list of integers. Whether every id exists, belongs to the cafe and
    appears exactly once is a business rule, checked by the service under the cafe lock.
    """

    # An empty list passes here: for categories it is complete when the cafe has none
    # (the service rejects it as incomplete otherwise); for items the service rejects it.
    ordered_ids = serializers.ListField(child=serializers.IntegerField())


class MenuItemSerializer(serializers.Serializer):
    """
    Menu items for the owner dashboard (UC-OWNER-002 and UC-OWNER-013).

    Input (POST, PATCH): category_id, name, price, and the optional description, is_featured, is_new.
    Read-only, ignored if sent: image_url (UC-OWNER-006), is_available (UC-OWNER-005) and
    sort_order (UC-OWNER-004). The cafe always comes from request.user.cafe.
    Output: { id, category_id, name, description, price, image_url, is_available, is_featured,
    is_new, sort_order }. A plain Serializer for the same reason as CategorySerializer.
    """

    id = serializers.IntegerField(read_only=True)
    category_id = serializers.IntegerField()
    name = BilingualNameField()
    description = BilingualDescriptionField(required=False)
    # Global Convention 10: NUMERIC(10,2), 0 or greater, returned as a string such as "50.00".
    price = serializers.DecimalField(max_digits=10, decimal_places=2, min_value=Decimal('0'))
    image_url = serializers.CharField(read_only=True)
    is_available = serializers.BooleanField(read_only=True)
    # Optional: when not sent, create uses False and edit keeps the current value.
    is_featured = serializers.BooleanField(required=False)
    is_new = serializers.BooleanField(required=False)
    sort_order = serializers.IntegerField(read_only=True)


class ItemAvailabilitySerializer(serializers.Serializer):
    """Body and answer of the availability toggle (UC-OWNER-005): {"is_available": false} -> { id, is_available }."""

    id = serializers.IntegerField(read_only=True)
    is_available = serializers.BooleanField()


class ImageUploadSerializer(serializers.Serializer):
    """Body of the item image upload (UC-OWNER-006): multipart/form-data with the file in "image"."""

    # FileField, not ImageField: DRF's ImageField checks the file with Pillow and answers with its own
    # message. The service checks the content (core.images) with the use case's messages instead.
    image = serializers.FileField()


class PublicMenuItemSerializer(serializers.Serializer):
    """An item on the public menu. context['plan'] is the cafe's plan (Global Convention 7)."""

    id = serializers.IntegerField()
    name = BilingualNameField()
    description = BilingualDescriptionField()
    price = serializers.DecimalField(max_digits=10, decimal_places=2)  # "50.00" (Global Convention 10)
    image_url = serializers.SerializerMethodField()
    is_available = serializers.BooleanField()
    is_featured = serializers.BooleanField()
    is_new = serializers.BooleanField()
    sort_order = serializers.IntegerField()

    def get_image_url(self, item):
        # Kept in the database, but shown only while the plan allows images.
        return item.image_url if self.context['plan'].allows_images else ''


class PublicCategorySerializer(serializers.Serializer):
    """A visible category on the public menu with its available items (`public_items`, prefetched)."""

    id = serializers.IntegerField()
    name = BilingualNameField()
    sort_order = serializers.IntegerField()
    items = PublicMenuItemSerializer(source='public_items', many=True)


class PublicCafeSerializer(serializers.Serializer):
    """The cafe part of the public menu; logo and color only while the plan allows branding."""

    name = BilingualNameField()
    primary_color = serializers.SerializerMethodField()
    logo_url = serializers.SerializerMethodField()
    is_active = serializers.BooleanField()

    def get_primary_color(self, cafe):
        return cafe.primary_color if self.context['plan'].allows_branding else ''

    def get_logo_url(self, cafe):
        return cafe.logo_url if self.context['plan'].allows_branding else ''


class PublicMenuSerializer(serializers.Serializer):
    """
    Output of GET /api/v1/menu/{slug}/ (system_design.md 3.4): { cafe, categories }.
    The instance is {'cafe': ..., 'categories': [...]}; context needs {'plan': cafe.plan}.
    """

    cafe = PublicCafeSerializer()
    categories = PublicCategorySerializer(many=True)


class ItemListQuerySerializer(serializers.Serializer):
    """Query string of GET /items/: an optional ?category=<id> (UC-OWNER-013 A2: not an integer -> 400)."""

    category = serializers.IntegerField(required=False)
