"""
Auth endpoints (system_design.md section 3.1).
core/urls.py includes this file under /api/v1/auth/.
"""

from django.urls import path

from .views import ChangePasswordView, LoginView, LogoutView, RefreshTokenView

# Namespace for reverse(): reverse('users:login') -> /api/v1/auth/login/
app_name = 'users'

urlpatterns = [
    path('login/', LoginView.as_view(), name='login'),                              # UC-AUTH-001
    path('refresh/', RefreshTokenView.as_view(), name='refresh'),                   # UC-AUTH-002
    path('logout/', LogoutView.as_view(), name='logout'),                           # UC-AUTH-003
    path('change-password/', ChangePasswordView.as_view(), name='change-password'), # UC-AUTH-004
]
