"""
Business rules for the menu app (use_cases.md UC-OWNER-001 to UC-OWNER-006, UC-OWNER-012, UC-OWNER-013,
and the public menu UC-GUEST-001 and UC-GUEST-002).

Views pass the cafe from request.user.cafe, never from the request body or URL.
Callers check role and subscription first (IsCafeOwner, IsActiveCafe).
"""

from django.db import transaction
from django.db.models import Max, Prefetch
from django.utils import timezone
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError

from cafes.models import Cafe
from core.images import ITEM_IMAGE_MAX_SIDE, ITEM_THUMBNAIL_MAX_SIDE, process_image_sizes
from core.media_storage import delete_image_on_commit, store_image
from core.revalidation import schedule_menu_revalidation

from .models import Category, MenuItem, MenuItemVariant

# Gapped integers (100, 200, 300, ...): moving a category between two others later
# only needs a number in the gap, so one row changes instead of the whole list.
SORT_ORDER_GAP = 100

# UC-OWNER-002 A8: the price of an item with variants is never sent, it is their lowest price.
PRICE_WITH_VARIANTS_MESSAGE = 'An item with variants takes its price from them. Do not send price.'


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
                f'Your {plan.get_name_display()} plan allows a maximum of {plan.max_categories} '
                f'{"category" if plan.max_categories == 1 else "categories"}. Upgrade to Pro for unlimited.',
                code='plan_limit_categories',
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
    with transaction.atomic():
        # Locked like in delete_category: a parallel delete finishes first (then 404) or waits.
        category = _get_category(cafe, category_id, lock=True)

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
    # ActiveManager: no soft-deleted items. One more query brings the variants of all items (no N+1).
    items = MenuItem.objects.filter(cafe=cafe).prefetch_related('variants')
    if category_id is None:
        # category_id keeps each category's items together if two categories share a sort_order.
        return items.order_by('category__sort_order', 'category_id', 'sort_order', 'id')
    category = _get_category(cafe, category_id)
    return items.filter(category=category).order_by('sort_order', 'id')


def create_item(cafe, *, category_id, name, price=None, description=None, is_featured=False, is_new=False,
                tags=(), variants=()):
    """
    UC-OWNER-002 (create). The inputs were already validated by the serializer.
    tags are stored once each, in the fixed order of the tag list (Global Convention 11).
    Exactly one of price and a non-empty variants list is given; with variants, the item's
    price is the lowest variant price (Global Convention 10).

    Raises ValidationError (400) when price and variants do not fit together (A8), then
    NotFound (404) when the category is missing, deleted or foreign (A2), then
    PermissionDenied (403) when the plan's max_items is reached (A1), in the main flow's order.
    """
    if variants:
        if price is not None:
            raise ValidationError({'price': [PRICE_WITH_VARIANTS_MESSAGE]})
        price = _lowest_price(variants)
    elif price is None:
        raise ValidationError({'price': ['This field is required.']})

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
                f'Your {plan.get_name_display()} plan allows a maximum of {plan.max_items} '
                f'{"item" if plan.max_items == 1 else "items"}. Upgrade to Pro for unlimited.',
                code='plan_limit_items',
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
            tags=_ordered_tags(tags),
            sort_order=highest + SORT_ORDER_GAP,
        )
        # Variants do not count toward max_items: only the item does (Global Convention 10).
        _replace_variants(item, variants)

        # Global Convention 9: rebuild the public menu, but only after the commit.
        schedule_menu_revalidation(locked_cafe.slug)

    return item


def update_item(cafe, item_id, *, category_id=None, name=None, description=None, price=None,
                is_featured=None, is_new=None, tags=None, variants=None):
    """
    UC-OWNER-002 (edit). PATCH semantics: an argument left as None is not changed.
    is_available is not changed here: it has its own endpoint (UC-OWNER-005).
    tags replaces the whole list: [] removes every tag, None keeps the list (Global Convention 11).
    variants replaces the whole list in the same way; a non-empty list also sets the item's price
    to its lowest price, and [] leaves the price as it is unless price is given (Global Convention 10).

    A new category_id moves the item to the end of that category (its last item + 100).
    Raises NotFound (404) for a missing, deleted or foreign item or new category (A2), and
    ValidationError (400) when price is given for an item that has variants after this call (A8).
    """
    with transaction.atomic():
        if category_id is not None or variants is not None:
            # Global Convention 8: a new position is assigned, and a variant list is replaced, under
            # the cafe row lock. Taken before the item lock, in the same order as reorder_items
            # (cafe, then items).
            locked_cafe = Cafe.objects.select_for_update().get(pk=cafe.pk)
        # Locked, so a parallel delete either finishes first (then 404 here) or waits for this save.
        item = _get_item(cafe, item_id, lock=True)
        changed = []

        if price is not None:
            # A8: asked only when a price was sent. The item row is locked, so the answer cannot change.
            has_variants = bool(variants) if variants is not None else item.variants.exists()
            if has_variants:
                raise ValidationError({'price': [PRICE_WITH_VARIANTS_MESSAGE]})
        elif variants:
            price = _lowest_price(variants)

        if category_id is not None and category_id != item.category_id:
            # The new category row is locked as in create_item, so it cannot be deleted under the item.
            category = _get_category(locked_cafe, category_id, lock=True)
            siblings = MenuItem.objects.filter(category=category)
            highest = siblings.aggregate(highest=Max('sort_order'))['highest'] or 0
            item.category = category
            item.sort_order = highest + SORT_ORDER_GAP
            changed += ['category', 'sort_order']

        for field, value in [('name', name), ('description', description), ('price', price),
                             ('is_featured', is_featured), ('is_new', is_new),
                             ('tags', None if tags is None else _ordered_tags(tags))]:
            # "is not None", not truthiness: False and [] are real values to save.
            if value is not None:
                setattr(item, field, value)
                changed.append(field)

        if variants is not None:
            _replace_variants(item, variants)

        if changed or variants is not None:
            # With update_fields, auto_now (updated_at) is saved only when it is listed.
            # A new variant list also counts as a change of the item, so updated_at moves with it.
            item.save(update_fields=[*changed, 'updated_at'])
            schedule_menu_revalidation(cafe.slug)

    return item


def delete_item(cafe, item_id):
    """UC-OWNER-002 (delete): soft delete. Raises NotFound (404) for a missing, deleted or foreign item."""
    with transaction.atomic():
        item = _get_item(cafe, item_id, lock=True)  # waits for a parallel edit of the same item
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
        # The answer shows each item with its variants: one more query for all of them.
        chosen = MenuItem.objects.filter(cafe=locked_cafe, pk__in=ordered_ids).prefetch_related('variants')
        by_id = {item.pk: item for item in chosen}

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
    with transaction.atomic():
        item = _get_item(cafe, item_id, lock=True)  # a parallel delete finishes first, then 404
        if item.is_available != is_available:
            item.is_available = is_available
            item.save(update_fields=['is_available', 'updated_at'])
            schedule_menu_revalidation(cafe.slug)
    return item


def upload_item_image(cafe, item_id, *, image_file):
    """
    UC-OWNER-006. Checks in the use case's order: the plan (403, A1), the item (404, A7), the
    file (400, A2, A3, A5). Then stores the WebP (502 on a storage failure, A4) and saves its URL.

    The file goes to R2 before the transaction, so no row lock is held during the network upload.
    The item row is locked for the URL swap: of two parallel uploads, the second sees the first
    one's URL as its old image and deletes it, so no stored file is left without an item.
    """
    if not cafe.plan.allows_images:  # the plan flag, never the plan name
        raise PermissionDenied('Item images require a Pro plan.', code='images_need_pro')
    _get_item(cafe, item_id)  # 404 before the expensive work
    # The full image and a small copy for the menu lists, from one decode of the upload.
    data, thumbnail = process_image_sizes(image_file, max_sides=(ITEM_IMAGE_MAX_SIDE, ITEM_THUMBNAIL_MAX_SIDE))
    new_url = store_image(data, f'cafes/{cafe.pk}/items')
    new_thumbnail_url = store_image(thumbnail, f'cafes/{cafe.pk}/items')

    with transaction.atomic():
        # Deleted in the meantime: 404, and the new files stay as cheap orphans.
        item = _get_item(cafe, item_id, lock=True)
        old_urls = (item.image_url, item.thumbnail_url)
        item.image_url, item.thumbnail_url = new_url, new_thumbnail_url
        item.save(update_fields=['image_url', 'thumbnail_url', 'updated_at'])
        # Only after the commit: on a rollback the item still shows the old image.
        for old_url in old_urls:
            delete_image_on_commit(old_url)
        schedule_menu_revalidation(cafe.slug)
    return item


def get_public_menu(slug):
    """
    UC-GUEST-001 and UC-GUEST-002: the cafe and its menu as customers see it. No caller check:
    the endpoint is public. Raises NotFound (404) for an unknown slug (A1).

    Returns (cafe, categories). Only visible, non-deleted categories, sorted by sort_order; each has
    `public_items`: its available, non-deleted items, sorted by sort_order. An inactive cafe gets
    no categories (UC-GUEST-002); that is a 200 answer, not an error.
    Four queries in total (cafe with plan, categories, items, variants), whatever the menu size.
    """
    try:
        cafe = Cafe.objects.select_related('plan').get(slug=slug)
    except Cafe.DoesNotExist:
        raise NotFound() from None
    if not cafe.is_active:
        return cafe, []

    # One query for all items of all categories instead of one per category (no N+1 problem),
    # and one for the variants of all those items.
    available_items = (
        MenuItem.objects.filter(is_available=True)
        .prefetch_related('variants')
        .order_by('sort_order', 'id')
    )
    categories = (
        Category.objects.filter(cafe=cafe, is_visible=True)
        .prefetch_related(Prefetch('items', queryset=available_items, to_attr='public_items'))
        .order_by('sort_order', 'id')
    )
    return cafe, list(categories)


def _lowest_price(variants):
    """Global Convention 10: the price of an item with variants is its lowest variant price."""
    return min(variant['price'] for variant in variants)


def _replace_variants(item, variants):
    """
    Global Convention 10: make `variants` (a list of {'name', 'price'}) the item's whole variant list,
    in that order (sort_order 100, 200, 300, ...). Replace-all: the old rows are deleted and new ones
    inserted, which is simpler and safer than matching up to 10 rows by id. Call it inside the
    caller's transaction, so a failure leaves the old list in place.
    """
    item.variants.all().delete()
    # One INSERT for all rows. bulk_create() skips MenuItemVariant.save() and its cafe check,
    # so the cafe is taken from the item right here and can never differ from it.
    MenuItemVariant.objects.bulk_create(
        MenuItemVariant(
            item=item,
            cafe_id=item.cafe_id,
            name=variant['name'],
            price=variant['price'],
            sort_order=position * SORT_ORDER_GAP,
        )
        for position, variant in enumerate(variants, start=1)
    )


def _ordered_tags(tags):
    """
    Global Convention 11: each tag once, in the order of the fixed list (MenuItem.Tag), whatever
    order was sent. Walking the fixed list and keeping what was sent does both in one pass; the
    result can never be longer than the list. The serializer has already refused unknown codes.
    """
    sent = set(tags)
    return [tag for tag in MenuItem.Tag.values if tag in sent]


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


def _get_item(cafe, item_id, lock=False):
    """The cafe's non-deleted item, or NotFound -> 404 {"detail": "Not found."} (ownership masking)."""
    queryset = MenuItem.objects.select_for_update() if lock else MenuItem.objects
    try:
        return queryset.get(pk=item_id, cafe=cafe)
    except MenuItem.DoesNotExist:
        raise NotFound() from None
