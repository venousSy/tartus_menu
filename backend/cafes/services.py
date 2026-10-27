"""
Business rules for the cafe settings of the owner dashboard (use_cases.md UC-OWNER-009 and UC-OWNER-014).

Views pass the cafe from request.user.cafe, never from the request body or URL.
"""

from rest_framework.exceptions import PermissionDenied

from core.revalidation import schedule_menu_revalidation

from .models import Cafe


def get_settings(cafe):
    """UC-OWNER-014: the cafe with its plan. Callers allow this also for an inactive cafe (A1)."""
    return Cafe.objects.select_related('plan').get(pk=cafe.pk)


def update_settings(cafe, *, name=None, primary_color=None):
    """
    UC-OWNER-009. PATCH semantics: an argument left as None is not changed.

    Raises PermissionDenied (403) when primary_color is sent and the plan does not allow branding (A2).
    This also applies to "" (back to the default theme): the use case checks the plan whenever the
    key is present. Decided by the plan flag, never by the plan name.
    """
    cafe = get_settings(cafe)
    if primary_color is not None and not cafe.plan.allows_branding:
        raise PermissionDenied('Custom colors require a Pro plan.')

    changed = []
    if name is not None:
        cafe.name = name
        changed.append('name')
    if primary_color is not None:
        cafe.primary_color = primary_color
        changed.append('primary_color')

    if changed:
        # With update_fields, auto_now (updated_at) is saved only when it is listed.
        cafe.save(update_fields=[*changed, 'updated_at'])
        # Global Convention 9: the name and the color are shown on the public menu.
        schedule_menu_revalidation(cafe.slug)
    return cafe
