from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.settings import api_settings
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from . import services
from .serializers import (
    ChangePasswordSerializer,
    CustomTokenObtainPairSerializer,
    LogoutSerializer,
    PasswordResetConfirmSerializer,
    RefreshTokenSerializer,
)


class LoginView(TokenObtainPairView):
    """
    UC-AUTH-001: Authenticates user credentials and issues JWT pair.
    Injects role into token claims and response payload via CustomTokenObtainPairSerializer.
    Rate limited per client IP: scope "login", rate from settings DEFAULT_THROTTLE_RATES.
    """
    permission_classes = [AllowAny]
    serializer_class = CustomTokenObtainPairSerializer
    # DRF checks the throttle before post() runs, so every attempt counts,
    # successful or not. Over the limit the client gets 429 (UC-AUTH-001 A4).
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'login'


class RefreshTokenView(TokenRefreshView):
    """
    UC-AUTH-002: Exchanges a valid refresh token for a new access/refresh pair.
    Configured in settings with ROTATE_REFRESH_TOKENS and BLACKLIST_AFTER_ROTATION.
    """
    permission_classes = [AllowAny]
    serializer_class = RefreshTokenSerializer  # 401, not 500, for a deleted account


class LogoutView(APIView):
    """
    UC-AUTH-003: Invalidate a specific refresh token by adding it to the blacklist.
    """
    permission_classes = [IsAuthenticated]

    def post(self, request, *args, **kwargs):
        serializer = LogoutSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        invalid_token_response = Response(
            {"detail": "Token is invalid or already blacklisted."},
            status=status.HTTP_400_BAD_REQUEST,
        )

        try:
            token = RefreshToken(serializer.validated_data['refresh'])
        except TokenError:
            return invalid_token_response

        # A user may only revoke their own token. Another user's token is treated
        # like an invalid one, so the response reveals nothing about it.
        # simplejwt stores the user id claim as a string.
        token_user_id = token.get(api_settings.USER_ID_CLAIM)
        if token_user_id != str(getattr(request.user, api_settings.USER_ID_FIELD)):
            return invalid_token_response

        try:
            token.blacklist()
        except TokenError:
            return invalid_token_response

        return Response(status=status.HTTP_205_RESET_CONTENT)


class ChangePasswordView(APIView):
    """
    UC-AUTH-004: Changes password for the authenticated user and invalidates
    all outstanding refresh tokens to force re-authentication across all devices.
    """
    permission_classes = [IsAuthenticated]

    def post(self, request, *args, **kwargs):
        serializer = ChangePasswordSerializer(
            data=request.data,
            context={'request': request}
        )
        serializer.is_valid(raise_exception=True)

        # One transaction in the service: a changed password can never leave old sessions alive.
        services.change_password(request.user, serializer.validated_data['new_password'])
        return Response(status=status.HTTP_204_NO_CONTENT)


class PasswordResetConfirmView(APIView):
    """
    UC-AUTH-005: sets a new password with the one-time link a Super Admin made (UC-ADMIN-010).
    The caller has no session; the link's uid and token are the proof. Rate limited like the login.
    """
    authentication_classes = []  # a stale token header must not turn the answer into a 401
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]  # every attempt counts (A3)
    throttle_scope = 'password_reset'

    def post(self, request, *args, **kwargs):
        serializer = PasswordResetConfirmSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        services.reset_password(**serializer.validated_data)
        return Response(status=status.HTTP_204_NO_CONTENT)
