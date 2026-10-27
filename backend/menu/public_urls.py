"""
Public customer menu (system_design.md section 3.4), no authentication.
core/urls.py includes this file under /api/v1/menu/; the owner dashboard routes are in urls.py.
"""

from django.urls import path

from .views import PublicMenuView

# Namespace for reverse(): reverse('public_menu:detail', kwargs={'slug': ...}) -> /api/v1/menu/<slug>/
app_name = 'public_menu'

urlpatterns = [
    path('<slug:slug>/', PublicMenuView.as_view(), name='detail'),  # UC-GUEST-001, UC-GUEST-002
]
