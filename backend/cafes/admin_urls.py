"""
Super Admin endpoints for cafe management (system_design.md section 3.2).
core/urls.py includes this file under /api/v1/admin/.
"""

from django.urls import path

from .views import (
    AdminCafeActivateView,
    AdminCafeBillingView,
    AdminCafeDeactivateView,
    AdminCafeDetailView,
    AdminCafeListView,
    AdminStatsView,
)

# Namespace for reverse(): reverse('admin_api:cafes') -> /api/v1/admin/cafes/
# Not "admin": Django's admin site already uses that namespace.
app_name = 'admin_api'

urlpatterns = [
    path('cafes/', AdminCafeListView.as_view(), name='cafes'),  # UC-ADMIN-002 (GET), UC-ADMIN-001 (POST)
    path('cafes/<int:pk>/', AdminCafeDetailView.as_view(), name='cafe'),  # UC-ADMIN-003, 006 (PATCH), 007 (DELETE)
    path('cafes/<int:pk>/activate/', AdminCafeActivateView.as_view(), name='cafe-activate'),  # UC-ADMIN-004
    path('cafes/<int:pk>/deactivate/', AdminCafeDeactivateView.as_view(), name='cafe-deactivate'),  # UC-ADMIN-005
    path('cafes/<int:pk>/billing/', AdminCafeBillingView.as_view(), name='cafe-billing'),  # UC-ADMIN-008
    path('stats/', AdminStatsView.as_view(), name='stats'),  # UC-ADMIN-009
]
