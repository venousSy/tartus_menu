"""
Business rules for analytics (use_cases.md UC-GUEST-004, UC-OWNER-015 and UC-OWNER-016): counting
menu opens and reading them back per day, per hour of the day and per table.

Counters are stored per UTC hour. Days and hours shown to an owner are those of the business time
zone (settings.BUSINESS_TIME_ZONE), which is a whole number of hours away from UTC, so an hour
bucket never has to be split.
"""

from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import F, Sum
from django.db.models.functions import ExtractHour, TruncDate
from django.utils import timezone
from rest_framework.exceptions import NotFound, PermissionDenied

from cafes.models import Cafe, CafeTable
from core.business_time import business_today

from .models import MenuViewCount

# Counters older than this are deleted by the nightly job: a year of history plus a month to compare.
RETENTION_DAYS = 400


def record_view(slug, table=None):
    """
    UC-GUEST-004: adds 1 to the counter of (cafe, this hour, table).

    Raises NotFound (404) for an unknown slug (A1). An inactive cafe is not counted (A2). A table
    number that is not an active table of the cafe is counted as "no table" (A3), so nobody can
    create counters for tables that do not exist.
    """
    cafe = Cafe.objects.filter(slug=slug).only('pk', 'is_active').first()
    if cafe is None:
        raise NotFound()
    if not cafe.is_active:
        return

    known = table is not None and CafeTable.objects.filter(cafe=cafe, table_number=table, is_active=True).exists()
    key = {
        'cafe': cafe,
        'hour': timezone.now().replace(minute=0, second=0, microsecond=0),
        'table_number': table if known else MenuViewCount.NO_TABLE,
    }
    counter = MenuViewCount.objects.filter(**key)
    # F('count') + 1 runs inside the database (UPDATE ... SET count = count + 1), so two opens at
    # the same moment both count. Reading the number in Python and saving it back would lose one.
    if counter.update(count=F('count') + 1):
        return
    try:
        # The first open of this hour from this table. The savepoint keeps a caller's transaction
        # usable when the insert fails.
        with transaction.atomic():
            MenuViewCount.objects.create(**key, count=1)
    except IntegrityError:
        # A parallel first open inserted the row just before this one: count on that row.
        counter.update(count=F('count') + 1)


def summary(cafe, days):
    """
    UC-OWNER-015: {"days", "total", "by_day": [{"date", "count"}]} for today and the days - 1 days
    before it, oldest first. A day without opens is there with 0 (A2).
    """
    zone, first_day, rows = _period(cafe, days)
    per_day = dict(
        rows.annotate(day=TruncDate('hour', tzinfo=zone)).values('day')
        .annotate(opens=Sum('count')).values_list('day', 'opens')
    )
    by_day = [
        {'date': day, 'count': per_day.get(day, 0)}
        for day in (first_day + timedelta(days=offset) for offset in range(days))
    ]
    return {'days': days, 'total': sum(entry['count'] for entry in by_day), 'by_day': by_day}


def detail(cafe, days):
    """
    UC-OWNER-016: {"days", "total", "by_hour": 24 x {"hour", "count"}, "by_table": [{"table_number",
    "count"}]} for the same period as summary(). by_table has the most opened table first.

    Raises PermissionDenied (403) when the plan has no detailed analytics (A1). Decided by the plan
    flag, never by the plan name.
    """
    if not cafe.plan.allows_detailed_analytics:
        raise PermissionDenied('Detailed analytics require a Pro plan.', code='analytics_need_pro')

    zone, _, rows = _period(cafe, days)
    per_hour = dict(
        rows.annotate(hour_of_day=ExtractHour('hour', tzinfo=zone)).values('hour_of_day')
        .annotate(opens=Sum('count')).values_list('hour_of_day', 'opens')
    )
    by_table = [
        {'table_number': table_number, 'count': opens}
        for table_number, opens in rows.values('table_number').annotate(opens=Sum('count'))
        .order_by('-opens', 'table_number').values_list('table_number', 'opens')
    ]
    return {
        'days': days,
        'total': sum(per_hour.values()),
        'by_hour': [{'hour': hour, 'count': per_hour.get(hour, 0)} for hour in range(24)],
        'by_table': by_table,
    }


def prune_old_views(today=None):
    """Deletes the counters older than RETENTION_DAYS (system_design.md §5). Returns how many rows went."""
    cutoff = _start_of(today or business_today()) - timedelta(days=RETENTION_DAYS)
    deleted, _ = MenuViewCount.objects.filter(hour__lt=cutoff).delete()
    return deleted


def _period(cafe, days):
    """The business time zone, the first day of the period, and the cafe's counters from that day on."""
    first_day = business_today() - timedelta(days=days - 1)
    # Tenant isolation: every read starts from this cafe's rows.
    return _zone(), first_day, MenuViewCount.objects.filter(cafe=cafe, hour__gte=_start_of(first_day))


def _zone():
    return ZoneInfo(settings.BUSINESS_TIME_ZONE)


def _start_of(day):
    """Midnight at the start of `day` in the business time zone, as an aware datetime."""
    return datetime.combine(day, time.min, tzinfo=_zone())
