from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer


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
