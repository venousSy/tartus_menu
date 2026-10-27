"""
Owner dashboard: categories (use_cases.md UC-OWNER-001, UC-OWNER-003 and UC-OWNER-012)
and menu items (UC-OWNER-002, UC-OWNER-004, UC-OWNER-005 and UC-OWNER-013).

Views stay thin: validate with the serializer, call one service function, return a response.
The cafe always comes from request.user.cafe; IsCafeOwner guarantees that it exists.
"""

from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from users.permissions import IsActiveCafe, IsCafeOwner

from . import services
from .serializers import (
    CategorySerializer,
    ItemAvailabilitySerializer,
    ItemListQuerySerializer,
    MenuItemSerializer,
    ReorderSerializer,
)
              
# Global Convention 5: role check first, then the active-subscription check.
OWNER_OF_ACTIVE_CAFE = [IsCafeOwner, IsActiveCafe]


class CategoryListCreateView(APIView):
    """GET and POST /api/v1/dashboard/categories/"""

    permission_classes = OWNER_OF_ACTIVE_CAFE

    def get(self, request):
        categories = services.list_categories(request.user.cafe)
        return Response(CategorySerializer(categories, many=True).data)

    def post(self, request):
        serializer = CategorySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        category = services.create_category(request.user.cafe, **serializer.validated_data)
        return Response(CategorySerializer(category).data, status=status.HTTP_201_CREATED)


class CategoryDetailView(APIView):
    """PATCH and DELETE /api/v1/dashboard/categories/{id}/ (GET and PUT are not in the contract: 405)."""

    permission_classes = OWNER_OF_ACTIVE_CAFE

    def patch(self, request, pk):
        serializer = CategorySerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        category = services.update_category(request.user.cafe, pk, **serializer.validated_data)
        return Response(CategorySerializer(category).data)

    def delete(self, request, pk):
        services.delete_category(request.user.cafe, pk)
        return Response(status=status.HTTP_204_NO_CONTENT)


class CategoryReorderView(APIView):
    """POST /api/v1/dashboard/categories/reorder/ (UC-OWNER-003)"""

    permission_classes = OWNER_OF_ACTIVE_CAFE

    def post(self, request):
        serializer = ReorderSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        categories = services.reorder_categories(request.user.cafe, **serializer.validated_data)
        # 200, not 201: nothing is created. Same item shape as the list endpoint (UC-OWNER-012).
        return Response(CategorySerializer(categories, many=True).data)


class ItemListCreateView(APIView):
    """GET (optional ?category=<id>) and POST /api/v1/dashboard/items/"""

    permission_classes = OWNER_OF_ACTIVE_CAFE

    def get(self, request):
        query = ItemListQuerySerializer(data=request.query_params)
        query.is_valid(raise_exception=True)
        items = services.list_items(request.user.cafe, category_id=query.validated_data.get('category'))
        return Response(MenuItemSerializer(items, many=True).data)

    def post(self, request):
        serializer = MenuItemSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        item = services.create_item(request.user.cafe, **serializer.validated_data)
        return Response(MenuItemSerializer(item).data, status=status.HTTP_201_CREATED)


class ItemDetailView(APIView):
    """PATCH and DELETE /api/v1/dashboard/items/{id}/ (GET and PUT are not in the contract: 405)."""

    permission_classes = OWNER_OF_ACTIVE_CAFE

    def patch(self, request, pk):
        serializer = MenuItemSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        item = services.update_item(request.user.cafe, pk, **serializer.validated_data)
        return Response(MenuItemSerializer(item).data)

    def delete(self, request, pk):
        services.delete_item(request.user.cafe, pk)
        return Response(status=status.HTTP_204_NO_CONTENT)


class ItemReorderView(APIView):
    """POST /api/v1/dashboard/items/reorder/ (UC-OWNER-004)"""

    permission_classes = OWNER_OF_ACTIVE_CAFE

    def post(self, request):
        serializer = ReorderSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        items = services.reorder_items(request.user.cafe, **serializer.validated_data)
        return Response(MenuItemSerializer(items, many=True).data)


class ItemAvailabilityView(APIView):
    """PATCH /api/v1/dashboard/items/{id}/availability/ (UC-OWNER-005)"""

    permission_classes = OWNER_OF_ACTIVE_CAFE

    def patch(self, request, pk):
        serializer = ItemAvailabilitySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        item = services.set_item_availability(request.user.cafe, pk, **serializer.validated_data)
        return Response(ItemAvailabilitySerializer(item).data)
