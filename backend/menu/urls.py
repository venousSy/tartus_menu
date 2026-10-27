"""
Owner dashboard endpoints for categories and menu items (system_design.md section 3.3).
core/urls.py includes this file under /api/v1/dashboard/.
"""

from django.urls import path

from .views import (
    CategoryDetailView,
    CategoryListCreateView,
    CategoryReorderView,
    ItemDetailView,
    ItemListCreateView,
)

# Namespace for reverse(): reverse('menu:category-list') -> /api/v1/dashboard/categories/
app_name = 'menu'

# <int:pk> matches digits only and passes the id to the view as an int named "pk".
urlpatterns = [
    path('categories/', CategoryListCreateView.as_view(), name='category-list'),         # UC-OWNER-012 (GET), UC-OWNER-001 (POST)
    path('categories/reorder/', CategoryReorderView.as_view(), name='category-reorder'),  # UC-OWNER-003 (POST)
    path('categories/<int:pk>/', CategoryDetailView.as_view(), name='category-detail'),  # UC-OWNER-001 (PATCH, DELETE)
    path('items/', ItemListCreateView.as_view(), name='item-list'),                      # UC-OWNER-013 (GET), UC-OWNER-002 (POST)
    path('items/<int:pk>/', ItemDetailView.as_view(), name='item-detail'),               # UC-OWNER-002 (PATCH, DELETE)
]
