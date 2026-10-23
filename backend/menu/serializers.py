from rest_framework import serializers

from core.serializer_fields import BilingualNameField


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
