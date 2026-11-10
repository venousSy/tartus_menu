from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers
from rest_framework.exceptions import AuthenticationFailed
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer, TokenRefreshSerializer


class CustomTokenObtainPairSerializer(TokenObtainPairSerializer):
    """
    Custom JWT serializer for UC-AUTH-001.
    Injects the user's role into both the token payload and the response payload,
    allowing the frontend to determine authorization level immediately upon login.
    """
    @classmethod
    def get_token(cls, user):
        token = super().get_token(user)
        # Embed role claim in the access token itself
        token['role'] = user.role
        return token

    def validate(self, attrs):
        data = super().validate(attrs)
        # Inject role into response body: { "access": "...", "refresh": "...", "role": "..." }
        data['role'] = self.user.role
        return data


class RefreshTokenSerializer(TokenRefreshSerializer):
    """
    UC-AUTH-002. simplejwt looks up the token's user with .get() and does not catch DoesNotExist,
    so a refresh token of a deleted account (UC-ADMIN-007 deletes the owner) would answer 500.
    That token cannot be valid any more: answer 401, like an expired or blacklisted one (A1, A2).
    """

    def validate(self, attrs):
        try:
            return super().validate(attrs)
        except get_user_model().DoesNotExist:
            raise AuthenticationFailed(
                self.error_messages['no_active_account'], 'no_active_account',
            ) from None


class LogoutSerializer(serializers.Serializer):
    """
    Validates refresh token input for UC-AUTH-003 (Logout).
    """
    refresh = serializers.CharField(required=True)


class ChangePasswordSerializer(serializers.Serializer):
    """
    Validates password change inputs for UC-AUTH-004.
    Ensures old password is correct, new password is distinct from old password,
    and adheres to configured Django AUTH_PASSWORD_VALIDATORS.
    """
    old_password = serializers.CharField(required=True, write_only=True)
    new_password = serializers.CharField(required=True, write_only=True)

    def validate_old_password(self, value):
        user = self.context['request'].user
        if not user.check_password(value):
            raise serializers.ValidationError("Incorrect password.")
        return value

    def validate(self, attrs):
        user = self.context['request'].user
        old_password = attrs.get('old_password')
        new_password = attrs.get('new_password')

        if old_password and new_password and old_password == new_password:
            raise serializers.ValidationError({
                "new_password": ["The new password must be different from the old password."]
            })

        try:
            validate_password(new_password, user)
        except DjangoValidationError as exc:
            raise serializers.ValidationError({
                "new_password": list(exc.messages)
            })

        return attrs


class PasswordResetConfirmSerializer(serializers.Serializer):
    """
    Body of UC-AUTH-005: the two parts of the reset link (uid, token) and the new password.
    Only the shape is checked here. The service checks the link first and the password rules after,
    so a bad link never reveals whether a password would have been accepted.
    """
    uid = serializers.CharField(max_length=64)
    token = serializers.CharField(max_length=128)
    # Not trimmed: the login does not trim either, so the stored password is exactly what was typed.
    new_password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)
