from django.contrib.auth import get_user_model
from rest_framework.permissions import BasePermission

User = get_user_model()


class IsSystemAdmin(BasePermission):
    """
    Allows access only to authenticated users with role == SYSTEM_ADMIN.
    Adheres to project invariant: authorization uses role, not is_staff.
    """
    message = "You do not have permission to perform this action."

    def has_permission(self, request, view):
        return bool(
            request.user
            and request.user.is_authenticated
            and request.user.role == User.Role.SYSTEM_ADMIN
        )


class IsCafeOwner(BasePermission):
    """
    Allows access to authenticated users with role == CAFE_OWNER who own a cafe.
    Used for general dashboard read endpoints (e.g., viewing cafe settings).
    Requiring the cafe here means views can always rely on request.user.cafe.
    """
    message = "You do not have permission to perform this action."

    def has_permission(self, request, view):
        user = request.user
        return bool(
            user
            and user.is_authenticated
            and user.role == User.Role.CAFE_OWNER
            and getattr(user, 'cafe', None) is not None
        )


class IsActiveCafe(BasePermission):
    """
    Ensures the requesting user's cafe subscription is active (is_active = True).
    Used for dashboard mutation/write endpoints per UC-OWNER-001.
    Returns 403 with specific message if the subscription is inactive.

    Always list it AFTER IsCafeOwner: permission_classes = [IsCafeOwner, IsActiveCafe].
    DRF stops at the first failing class, so a non-owner gets IsCafeOwner's message,
    not a misleading "subscription inactive" message.
    """
    message = "Your subscription is inactive. Please contact support."

    def has_permission(self, request, view):
        # getattr default covers anonymous users and users without a cafe
        cafe = getattr(request.user, 'cafe', None)
        return bool(cafe is not None and cafe.is_active)
