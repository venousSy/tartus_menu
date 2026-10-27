"""
Owner dashboard: categories (use_cases.md UC-OWNER-001, UC-OWNER-003 and UC-OWNER-012).

Views stay thin: validate with the serializer, call one service function, return a response.
The cafe always comes from request.user.cafe; IsCafeOwner guarantees that it exists.
"""

from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from users.permissions import IsActiveCafe, IsCafeOwner

from . import services
from .serializers import CategorySerializer, ReorderSerializer
              
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
