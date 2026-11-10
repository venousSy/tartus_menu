"""
Public QR link lookup (use_cases.md UC-GUEST-003), mounted at /api/v1/qr/ in core/urls.py.
The <uuid:token> converter turns a malformed token into Django's JSON 404 before any view runs.
"""

from django.urls import path

from .views import QRTargetView

app_name = 'public_qr'

urlpatterns = [
    path('<uuid:token>/', QRTargetView.as_view(), name='target'),
]
