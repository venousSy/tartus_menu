"""
Business rules for the cafe settings of the owner dashboard (use_cases.md UC-OWNER-009, UC-OWNER-010
and UC-OWNER-014), its tables for the QR codes (UC-OWNER-007, UC-OWNER-008 and UC-OWNER-011),
and the Super Admin's cafe management (UC-ADMIN-001 to UC-ADMIN-009).

Owner views pass the cafe from request.user.cafe, never from the request body or URL.
Super Admin views pass the cafe id from the URL: the admin manages every cafe.
"""

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError

from core.images import LOGO_MAX_SIDE, process_image
from core.media_storage import delete_image_on_commit, store_image
from core.revalidation import schedule_menu_revalidation

from .models import BillingEvent, Cafe, CafeTable, SubscriptionPlan
from .qr import qr_codes_pdf, qr_png_data_url, table_url

User = get_user_model()


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


def sync_tables(cafe, table_count):
    """
    UC-OWNER-007 step 2: tables 1..table_count become active, every higher number inactive.

    Rows are never deleted, so a table keeps its qr_token when it is switched off and on again
    (A4); sending the same count again writes nothing (A3). table_count was already validated
    (1-200). Returns the active tables in ascending table_number order.
    """
    with transaction.atomic():
        # Global Convention 8: with the cafe row locked, two parallel calls cannot both create table N.
        locked_cafe = Cafe.objects.select_for_update().get(pk=cafe.pk)
        tables = CafeTable.objects.filter(cafe=locked_cafe)

        existing = set(tables.values_list('table_number', flat=True))
        # (a) a new row, with a new qr_token, for each missing number. bulk_create fills the timestamps.
        CafeTable.objects.bulk_create(
            CafeTable(cafe=locked_cafe, table_number=number)
            for number in range(1, table_count + 1)
            if number not in existing
        )
        # (b) and (c): update() skips auto_now, so updated_at is set here.
        now = timezone.now()
        tables.filter(table_number__lte=table_count, is_active=False).update(is_active=True, updated_at=now)
        tables.filter(table_number__gt=table_count, is_active=True).update(is_active=False, updated_at=now)

    return active_tables(cafe)


def active_tables(cafe):
    """The cafe's active tables in ascending table_number order (UC-OWNER-007, 008 and 011)."""
    return list(CafeTable.objects.filter(cafe=cafe, is_active=True).order_by('table_number'))


def generate_qr_codes(cafe, table_count):
    """UC-OWNER-007: sync the tables (step 2), then build the QR code of each active table (step 3)."""
    return _qr_codes(cafe, sync_tables(cafe, table_count))


def preview_qr_codes(cafe):
    """UC-OWNER-011: read-only, same answer as generate; { "table_count": 0, "tables": [] } without tables (A1)."""
    return _qr_codes(cafe, active_tables(cafe))


def qr_pdf(cafe):
    """
    UC-OWNER-008: the PDF bytes, one page per active table in table_number order.

    Raises ValidationError (400) when the cafe has no active table (A1). Unlike the preview, which
    answers an empty list, an empty PDF would only print blank paper.
    """
    tables = active_tables(cafe)
    if not tables:
        raise ValidationError({'detail': 'Please generate QR codes first.'})
    return qr_codes_pdf(cafe, tables)


# --- Super Admin (UC-ADMIN-001 to UC-ADMIN-009): any cafe, looked up by the id in the URL ---


def list_cafes(search=''):
    """UC-ADMIN-002: every cafe, newest first. `search` matches part of the slug, a name or the owner email."""
    cafes = Cafe.objects.select_related('plan', 'owner').order_by('-created_at', '-pk')
    if search:
        cafes = cafes.filter(
            Q(slug__icontains=search) | Q(name__ar__icontains=search) | Q(name__en__icontains=search)
            | Q(owner__email__icontains=search)
        )
    return cafes


def get_cafe(cafe_id):
    """UC-ADMIN-003: one cafe with its plan and owner. Raises NotFound (404) for an unknown id."""
    try:
        return Cafe.objects.select_related('plan', 'owner').get(pk=cafe_id)
    except Cafe.DoesNotExist:
        raise NotFound() from None


def create_cafe(*, slug, name, plan, owner):
    """
    UC-ADMIN-001: the owner account and its inactive cafe, in one transaction.
    The serializer already checked the input, including the unique slug (A1) and email (A2).
    """
    with transaction.atomic():
        # The owner first, as the use case says; if the cafe insert fails, the rollback removes the account too.
        user = User.objects.create_user(
            email=owner['email'], password=owner['password'], role=User.Role.CAFE_OWNER
        )
        cafe = Cafe.objects.create(owner=user, plan=plan, slug=slug, name=name)  # is_active=False by default
    return get_cafe(cafe.pk)


def activate_cafe(cafe_id, *, performed_by):
    """UC-ADMIN-004: is_active = true, subscription_start_at = now and a BillingEvent 'activated'."""
    return _set_subscription(cafe_id, performed_by, active=True)


def deactivate_cafe(cafe_id, *, performed_by):
    """UC-ADMIN-005, the mirror of activate_cafe: is_active = false and subscription_end_at = now."""
    return _set_subscription(cafe_id, performed_by, active=False)


def _set_subscription(cafe_id, performed_by, *, active):
    with transaction.atomic():
        # Locked: a double click waits for the first commit and then gets A1, so only one BillingEvent is written.
        cafe = _lock_cafe(cafe_id)
        state = 'active' if active else 'inactive'
        if cafe.is_active == active:
            raise ValidationError({'detail': f'Cafe is already {state}.'})  # A1

        date_field = 'subscription_start_at' if active else 'subscription_end_at'
        cafe.is_active = active
        setattr(cafe, date_field, timezone.now())
        cafe.save(update_fields=['is_active', date_field, 'updated_at'])
        action = BillingEvent.Action.ACTIVATED if active else BillingEvent.Action.DEACTIVATED
        BillingEvent.objects.create(cafe=cafe, action=action, performed_by=performed_by)
        # Global Convention 9: the public page shows the menu again, or the inactive screen (UC-GUEST-002).
        schedule_menu_revalidation(cafe.slug)
    return get_cafe(cafe.pk)


def _lock_cafe(cafe_id):
    """The cafe row, locked until the transaction ends (Global Convention 8). NotFound (404) for an unknown id."""
    try:
        return Cafe.objects.select_for_update().get(pk=cafe_id)
    except Cafe.DoesNotExist:
        raise NotFound() from None


def billing_history(cafe_id):
    """UC-ADMIN-008: the cafe's billing events, newest first; an empty list when there are none (A1)."""
    if not Cafe.objects.filter(pk=cafe_id).exists():
        raise NotFound()  # A2
    return BillingEvent.objects.filter(cafe_id=cafe_id).select_related('performed_by').order_by('-created_at', '-pk')


def platform_stats():
    """UC-ADMIN-009: the cafe counts for the admin home page, in one query."""
    return Cafe.objects.aggregate(
        total_cafes=Count('pk'),
        active_cafes=Count('pk', filter=Q(is_active=True)),
        inactive_cafes=Count('pk', filter=Q(is_active=False)),
        # A report per plan, not a plan rule, so counting by the plan code is right here.
        basic_plan_count=Count('pk', filter=Q(plan__name=SubscriptionPlan.Name.BASIC)),
        pro_plan_count=Count('pk', filter=Q(plan__name=SubscriptionPlan.Name.PRO)),
    )


def _qr_codes(cafe, tables):
    """
    The answer of UC-OWNER-007 and UC-OWNER-011: { table_count, tables: [{ id, table_number, url,
    qr_token, qr_image_url }] }. `tables` are the active tables in table_number order, so
    table_count is simply their number (it is never stored).
    """
    codes = []
    for table in tables:
        # Built from the current slug on every call, so a renamed slug never leaves an old URL behind.
        url = table_url(cafe, table.table_number)
        codes.append({
            'id': table.pk,
            'table_number': table.table_number,
            'url': url,
            'qr_token': table.qr_token,
            'qr_image_url': qr_png_data_url(url),
        })
    return {'table_count': len(codes), 'tables': codes}
