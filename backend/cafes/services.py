"""
Business rules for the cafe settings of the owner dashboard (use_cases.md UC-OWNER-009, UC-OWNER-010
and UC-OWNER-014).

Views pass the cafe from request.user.cafe, never from the request body or URL.
"""

from django.db import transaction
from rest_framework.exceptions import PermissionDenied

from core.images import LOGO_MAX_SIDE, process_image
from core.media_storage import delete_image_on_commit, store_image
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


def upload_logo(cafe, *, image_file):
    """
    UC-OWNER-010. Checks the plan (403, A1) and the file (400, A2, A3), stores the WebP
    (502 on a storage failure, A4) and saves its URL. Returns the cafe with its plan.

    Same order as menu.services.upload_item_image: the file goes to R2 before the transaction,
    then the cafe row is locked for the URL swap, so parallel uploads leave no file behind.
    """
    if not get_settings(cafe).plan.allows_branding:  # the plan flag, never the plan name
        raise PermissionDenied('Custom logos require a Pro plan.')
    # Logos keep transparency and are smaller than item images (longest side 512 px).
    data = process_image(image_file, max_side=LOGO_MAX_SIDE, keep_transparency=True)
    new_url = store_image(data, f'cafes/{cafe.pk}/logo')

    with transaction.atomic():
        # The logo lives on the cafe row, so that row is the one to lock (like the item row for item images).
        locked_cafe = Cafe.objects.select_related('plan').select_for_update(of=('self',)).get(pk=cafe.pk)
        old_url = locked_cafe.logo_url
        locked_cafe.logo_url = new_url
        locked_cafe.save(update_fields=['logo_url', 'updated_at'])
        # Only after the commit: on a rollback the cafe still shows the old logo.
        delete_image_on_commit(old_url)
        schedule_menu_revalidation(locked_cafe.slug)
    return locked_cafe
