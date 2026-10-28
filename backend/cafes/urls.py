"""
Owner dashboard endpoints for the cafe settings and the QR codes (system_design.md section 3.3).
core/urls.py includes this file under /api/v1/dashboard/, next to menu/urls.py.
"""

from django.urls import path

from .views import CafeLogoView, CafeSettingsView, QRDownloadPDFView, QRGenerateView, QRPreviewView

# Namespace for reverse(): reverse('cafes:settings') -> /api/v1/dashboard/settings/
app_name = 'cafes'

urlpatterns = [
    path('settings/', CafeSettingsView.as_view(), name='settings'),  # UC-OWNER-014 (GET), UC-OWNER-009 (PATCH)
    path('settings/logo/', CafeLogoView.as_view(), name='settings-logo'),  # UC-OWNER-010 (POST)
    path('qr/generate/', QRGenerateView.as_view(), name='qr-generate'),  # UC-OWNER-007 (POST)
    path('qr/preview/', QRPreviewView.as_view(), name='qr-preview'),  # UC-OWNER-011 (GET)
    path('qr/download-pdf/', QRDownloadPDFView.as_view(), name='qr-download-pdf'),  # UC-OWNER-008 (GET)
]
