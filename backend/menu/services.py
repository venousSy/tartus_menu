"""
Business rules for the menu app (use_cases.md UC-OWNER-001 to UC-OWNER-005, UC-OWNER-012, UC-OWNER-013,
and the public menu UC-GUEST-001 and UC-GUEST-002).

Views pass the cafe from request.user.cafe, never from the request body or URL.
Callers check role and subscription first (IsCafeOwner, IsActiveCafe).
"""

from django.db import transaction
from django.db.models import Max, Prefetch
from django.utils import timezone
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError

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


def reorder_categories(cafe, *, ordered_ids):
    """
    UC-OWNER-003: put the cafe's categories in the order of `ordered_ids`
    (sort_order 100, 200, 300, ...) and return them in that order.

    Raises NotFound (404) when an id is missing, deleted or foreign (A1), and
    ValidationError (400) when the list leaves out or repeats a category (A2).
    Both errors reject the whole list, so nothing is saved.
    """
    with transaction.atomic():
        # Global Convention 8: the same cafe row lock as create_category, so a category
        # created in parallel cannot appear between the check and the update.
        locked_cafe = Cafe.objects.select_for_update().get(pk=cafe.pk)
        by_id = {category.pk: category for category in Category.objects.filter(cafe=locked_cafe)}

        # A1: one unknown id rejects the list. A foreign id gets the same 404 as a missing one.
        if any(category_id not in by_id for category_id in ordered_ids):
            raise NotFound()
        # A2: every category exactly once. After A1, the sorted lists differ only
        # when an id is left out or repeated.
        if sorted(ordered_ids) != sorted(by_id):
            raise ValidationError({'ordered_ids': ['The list must include every category exactly once.']})

        ordered = [by_id[category_id] for category_id in ordered_ids]
        # An unchanged order does not rebuild the public menu.
        if _apply_positions(Category, ordered):
            schedule_menu_revalidation(locked_cafe.slug)

    return ordered


def list_items(cafe, *, category_id=None):
    """
    UC-OWNER-013: the cafe's non-deleted items, unavailable ones included.

    Without category_id: sorted by the category's sort_order, then the item's.
    With category_id: only that category's items, sorted by sort_order. Raises NotFound (404)
    when that category is missing, deleted or foreign (A3).
    """
    items = MenuItem.objects.filter(cafe=cafe)  # ActiveManager: no soft-deleted items
    if category_id is None:
        # category_id keeps each category's items together if two categories share a sort_order.
        return items.order_by('category__sort_order', 'category_id', 'sort_order', 'id')
    category = _get_category(cafe, category_id)
    return items.filter(category=category).order_by('sort_order', 'id')


def create_item(cafe, *, category_id, name, price, description=None, is_featured=False, is_new=False):
    """
    UC-OWNER-002 (create). The inputs were already validated by the serializer.

    Raises NotFound (404) when the category is missing, deleted or foreign (A2), then
    PermissionDenied (403) when the plan's max_items is reached (A1), in the main flow's order.
    """
    with transaction.atomic():
        # Global Convention 8: the same cafe row lock as create_category, for the limit and the sort_order.
        locked_cafe = (
            Cafe.objects.select_related('plan')
            .select_for_update(of=('self',))
            .get(pk=cafe.pk)
        )
        # Lock the category row too. A delete_category for it either commits first (then this
        # lookup finds no live category: 404) or waits for this commit and then deletes the new item too.
        category = _get_category(locked_cafe, category_id, lock=True)

        plan = locked_cafe.plan
        items = MenuItem.objects.filter(cafe=locked_cafe)  # non-deleted only; unavailable ones count
        # Decide by the plan's limit, never by its name. NULL means unlimited.
        if plan.max_items is not None and items.count() >= plan.max_items:
            raise PermissionDenied(
                f'Your {plan.get_name_display()} plan allows a maximum of '
                f'{plan.max_items} items. Upgrade to Pro for unlimited.'
            )

        # Items are ordered inside their category, so the gap continues after that category's last item.
        highest = items.filter(category=category).aggregate(highest=Max('sort_order'))['highest'] or 0
        item = MenuItem.objects.create(
            cafe=locked_cafe,
            category=category,
            name=name,
            # Optional (Global Convention 6); stored with both keys, like a name.
            description=description if description is not None else {'ar': '', 'en': ''},
            price=price,
            is_featured=is_featured,
            is_new=is_new,
            sort_order=highest + SORT_ORDER_GAP,
        )

        # Global Convention 9: rebuild the public menu, but only after the commit.
        schedule_menu_revalidation(locked_cafe.slug)

    return item


def update_item(cafe, item_id, *, category_id=None, name=None, description=None, price=None,
                is_featured=None, is_new=None):
    """
    UC-OWNER-002 (edit). PATCH semantics: an argument left as None is not changed.
    is_available is not changed here: it has its own endpoint (UC-OWNER-005).

    A new category_id moves the item to the end of that category (its last item + 100).
    Raises NotFound (404) for a missing, deleted or foreign item or new category (A2).
    """
    with transaction.atomic():
        item = _get_item(cafe, item_id)
        changed = []

        if category_id is not None and category_id != item.category_id:
            # Global Convention 8: the new position is assigned under the cafe row lock, and the
            # new category row is locked as in create_item, so it cannot be deleted under the item.
            locked_cafe = Cafe.objects.select_for_update().get(pk=cafe.pk)
            category = _get_category(locked_cafe, category_id, lock=True)
            siblings = MenuItem.objects.filter(category=category)
            highest = siblings.aggregate(highest=Max('sort_order'))['highest'] or 0
            item.category = category
            item.sort_order = highest + SORT_ORDER_GAP
            changed += ['category', 'sort_order']

        for field, value in [('name', name), ('description', description), ('price', price),
                             ('is_featured', is_featured), ('is_new', is_new)]:
            if value is not None:
                setattr(item, field, value)
                changed.append(field)

        if changed:
            # With update_fields, auto_now (updated_at) is saved only when it is listed.
            item.save(update_fields=[*changed, 'updated_at'])
            schedule_menu_revalidation(cafe.slug)

    return item


def delete_item(cafe, item_id):
    """UC-OWNER-002 (delete): soft delete. Raises NotFound (404) for a missing, deleted or foreign item."""
    item = _get_item(cafe, item_id)
    item.deleted_at = timezone.now()
    item.save(update_fields=['deleted_at', 'updated_at'])
    schedule_menu_revalidation(cafe.slug)


def reorder_items(cafe, *, ordered_ids):
    """
    UC-OWNER-004: put the items of one category in the order of `ordered_ids`
    (sort_order 100, 200, 300, ...) and return them in that order.

    Like reorder_categories, the list must name every item of that category exactly once.
    Raises NotFound (404) when an id is missing, deleted or foreign (A2), and ValidationError (400)
    when the list is empty, spans several categories (A1), or leaves out or repeats an item.
    Every error rejects the whole list, so nothing is saved.
    """
    if not ordered_ids:
        # Without any id there is no category to reorder.
        raise ValidationError({'ordered_ids': ['This list may not be empty.']})

    with transaction.atomic():
        # Global Convention 8: the same cafe row lock as create_item and update_item, so no item
        # can be created in or moved into the category between the check and the update.
        locked_cafe = Cafe.objects.select_for_update().get(pk=cafe.pk)
        by_id = {item.pk: item for item in MenuItem.objects.filter(cafe=locked_cafe, pk__in=ordered_ids)}

        # A2: one unknown id rejects the list. A foreign id gets the same 404 as a missing one.
        if any(item_id not in by_id for item_id in ordered_ids):
            raise NotFound()
        category_ids = {item.category_id for item in by_id.values()}
        if len(category_ids) > 1:  # A1
            raise ValidationError({'ordered_ids': ['Reorder must be within one category.']})
        siblings = MenuItem.objects.filter(cafe=locked_cafe, category_id=category_ids.pop())
        if sorted(ordered_ids) != sorted(siblings.values_list('pk', flat=True)):
            raise ValidationError({'ordered_ids': ['The list must include every item of the category exactly once.']})

        ordered = [by_id[item_id] for item_id in ordered_ids]
        if _apply_positions(MenuItem, ordered):
            schedule_menu_revalidation(locked_cafe.slug)

    return ordered


def set_item_availability(cafe, item_id, *, is_available):
    """
    UC-OWNER-005: change only is_available. Raises NotFound (404) for a missing, deleted
    or foreign item (A1). Sending the current value writes nothing and rebuilds nothing.
    """
    item = _get_item(cafe, item_id)
    if item.is_available != is_available:
        item.is_available = is_available
        item.save(update_fields=['is_available', 'updated_at'])
        schedule_menu_revalidation(cafe.slug)
    return item


def get_public_menu(slug):
    """
    UC-GUEST-001 and UC-GUEST-002: the cafe and its menu as customers see it. No caller check:
    the endpoint is public. Raises NotFound (404) for an unknown slug (A1).

    Returns (cafe, categories). Only visible, non-deleted categories, sorted by sort_order; each has
    `public_items`: its available, non-deleted items, sorted by sort_order. An inactive cafe gets
    no categories (UC-GUEST-002); that is a 200 answer, not an error.
    Three queries in total (cafe with plan, categories, items), whatever the menu size.
    """
    try:
        cafe = Cafe.objects.select_related('plan').get(slug=slug)
    except Cafe.DoesNotExist:
        raise NotFound() from None
    if not cafe.is_active:
        return cafe, []

    # One query for all items of all categories instead of one per category (no N+1 problem).
    available_items = MenuItem.objects.filter(is_available=True).order_by('sort_order', 'id')
    categories = (
        Category.objects.filter(cafe=cafe, is_visible=True)
        .prefetch_related(Prefetch('items', queryset=available_items, to_attr='public_items'))
        .order_by('sort_order', 'id')
    )
    return cafe, list(categories)


def _apply_positions(model, ordered):
    """
    Give the rows in `ordered` the sort_order 100, 200, 300, ... in that order (Gapped Integer).

    Only rows that move are written ("minimizes DB writes", implementation_plan.md), all of them
    in one UPDATE. bulk_update() skips save() and auto_now, so updated_at is set here. That is safe
    because cafe and category never change here. Returns True when at least one row moved.
    """
    now = timezone.now()
    changed = []
    for position, row in enumerate(ordered, start=1):
        if row.sort_order != position * SORT_ORDER_GAP:
            row.sort_order = position * SORT_ORDER_GAP
            row.updated_at = now
            changed.append(row)
    if changed:
        model.objects.bulk_update(changed, ['sort_order', 'updated_at'])
    return bool(changed)


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


def _get_item(cafe, item_id):
    """The cafe's non-deleted item, or NotFound -> 404 {"detail": "Not found."} (ownership masking)."""
    try:
        return MenuItem.objects.get(pk=item_id, cafe=cafe)
    except MenuItem.DoesNotExist:
        raise NotFound() from None
