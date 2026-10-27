"""
Owner dashboard endpoint for the cafe settings (system_design.md section 3.3).
core/urls.py includes this file under /api/v1/dashboard/, next to menu/urls.py.
"""

from django.urls import path

from .views import CafeSettingsView

# Namespace for reverse(): reverse('cafes:settings') -> /api/v1/dashboard/settings/
app_name = 'cafes'

urlpatterns = [
    path('settings/', CafeSettingsView.as_view(), name='settings'),  # UC-OWNER-014 (GET), UC-OWNER-009 (PATCH)
]
