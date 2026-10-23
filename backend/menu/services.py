"""
Business rules for the menu app (use_cases.md UC-OWNER-001 and UC-OWNER-012).

Views pass the cafe from request.user.cafe, never from the request body or URL.
Callers check role and subscription first (IsCafeOwner, IsActiveCafe).
"""

from django.db import transaction
from django.db.models import Max
from django.utils import timezone
from rest_framework.exceptions import NotFound, PermissionDenied

from cafes.models import Cafe
from core.revalidation import schedule_menu_revalidation

from .models import Category, MenuItem

# Gapped integers (100, 200, 300, ...): moving a category between two others later
# only needs a number in the gap, so one row changes instead of the whole list.
SORT_ORDER_GAP = 100


def list_categories(cafe):
    """UC-OWNER-012: all non-deleted categories of the cafe, hidden ones included."""
    # Category.objects already hides soft-deleted rows (ActiveManager).
    return Category.objects.filter(cafe=cafe).order_by('sort_order', 'id')


def create_category(cafe, *, name, is_visible=True):
    """
    UC-OWNER-001 (create). `name` was already validated by the serializer.

    Keyword-only arguments: the caller cannot slip in other fields such as cafe or sort_order.
    Raises PermissionDenied (403) when the plan's max_categories is reached (A1).
    """
    with transaction.atomic():
        # Global Convention 8: lock this cafe's row before checking the limit.
        # A second request for the same cafe waits here until this one commits,
        # so two parallel requests cannot both pass the check or get the same sort_order.
        # of=('self',) locks only the cafe row, not the plan row that all cafes on the plan share.
        locked_cafe = (
            Cafe.objects.select_related('plan')
            .select_for_update(of=('self',))
            .get(pk=cafe.pk)
        )
        plan = locked_cafe.plan
        categories = Category.objects.filter(cafe=locked_cafe)  # non-deleted only; hidden ones count

        # Decide by the plan's limit, never by its name. NULL means unlimited.
        if plan.max_categories is not None and categories.count() >= plan.max_categories:
            raise PermissionDenied(
                f'Your {plan.get_name_display()} plan allows a maximum of '
                f'{plan.max_categories} categories. Upgrade to Pro for unlimited.'
            )

        highest = categories.aggregate(highest=Max('sort_order'))['highest'] or 0
        category = Category.objects.create(
            cafe=locked_cafe,
            name=name,
            is_visible=is_visible,
            sort_order=highest + SORT_ORDER_GAP,
        )

        # Global Convention 9: rebuild the public menu page, but only after the commit.
        schedule_menu_revalidation(locked_cafe.slug)

    return category


def update_category(cafe, category_id, *, name=None, is_visible=None):
    """
    UC-OWNER-001 (edit). PATCH semantics: a field left as None is not changed.
    Raises NotFound (404) for a missing, deleted or foreign category (A2).
    """
    category = _get_category(cafe, category_id)

    changed = []
    if name is not None:
        category.name = name
        changed.append('name')
    if is_visible is not None:
        category.is_visible = is_visible
        changed.append('is_visible')

    if changed:
        # With update_fields, auto_now (updated_at) is saved only when it is listed.
        category.save(update_fields=[*changed, 'updated_at'])
        schedule_menu_revalidation(cafe.slug)
    return category


def delete_category(cafe, category_id):
    """
    UC-OWNER-001 (delete): soft-delete the category and its non-deleted items
    in one transaction, with the same timestamp. Raises NotFound (404) as above.
    """
    with transaction.atomic():
        # Lock the category row until the commit. A future item create that locks the
        # same row then waits, and cannot add an item to a category being deleted.
        category = _get_category(cafe, category_id, lock=True)
        now = timezone.now()

        # One UPDATE for all items. update() skips save() and auto_now, so set updated_at too.
        # Safe here: cafe and category do not change. Items deleted earlier keep their own timestamp.
        MenuItem.objects.filter(category=category).update(deleted_at=now, updated_at=now)
        category.deleted_at = now
        category.save(update_fields=['deleted_at', 'updated_at'])

        schedule_menu_revalidation(cafe.slug)


def _get_category(cafe, category_id, lock=False):
    """
    The cafe's non-deleted category, or NotFound -> 404 {"detail": "Not found."}.
    A foreign id gets the same answer as a missing one (ownership masking).
    """
    queryset = Category.objects.select_for_update() if lock else Category.objects
    try:
        return queryset.get(pk=category_id, cafe=cafe)
    except Category.DoesNotExist:
        raise NotFound() from None
