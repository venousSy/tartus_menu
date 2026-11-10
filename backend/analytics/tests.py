"""
API integration tests for analytics (use_cases.md UC-GUEST-004, UC-OWNER-015 and UC-OWNER-016).
Each test sends real HTTP requests through URL -> view -> service -> database.
The last class tests the prune_menu_views management command.
"""

from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from io import StringIO
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.db.models import QuerySet
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import AccessToken

from cafes.models import Cafe, CafeTable, SubscriptionPlan
from core.business_time import business_today

from .models import MenuViewCount

User = get_user_model()


class AnalyticsAPITestCase(APITestCase):
    """Shared data: an active cafe on Pro with tables 1 and 2 (2 inactive), and another cafe on Basic."""

    @classmethod
    def setUpTestData(cls):
        cls.basic = SubscriptionPlan.objects.create(name=SubscriptionPlan.Name.BASIC, max_categories=5, max_items=20)
        cls.pro = SubscriptionPlan.objects.create(
            name=SubscriptionPlan.Name.PRO, allows_images=True, allows_branding=True, allows_detailed_analytics=True,
        )
        cls.owner = User.objects.create_user(email='owner@cafe.com')  # no password: the tests use a token
        cls.cafe = Cafe.objects.create(
            owner=cls.owner, plan=cls.pro, slug='tartus-coffee', name={'ar': 'Tartus Coffee'}, is_active=True,
        )
        CafeTable.objects.create(cafe=cls.cafe, table_number=1)
        CafeTable.objects.create(cafe=cls.cafe, table_number=2, is_active=False)
        cls.other_owner = User.objects.create_user(email='other@cafe.com')
        cls.other_cafe = Cafe.objects.create(
            owner=cls.other_owner, plan=cls.basic, slug='sea-view', name={'ar': 'Sea View'}, is_active=True,
        )
        CafeTable.objects.create(cafe=cls.other_cafe, table_number=5)

    def log_in(self, user):
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {AccessToken.for_user(user)}')

    @staticmethod
    def at(day_offset, hour, cafe, table=0, count=1):
        """A stored counter: `hour` o'clock in Damascus (UTC+3), `day_offset` days from today there."""
        day = business_today() + timedelta(days=day_offset)
        moment = datetime(day.year, day.month, day.day, hour, tzinfo=dt_timezone.utc) - timedelta(hours=3)
        return MenuViewCount.objects.create(cafe=cafe, hour=moment, table_number=table, count=count)


class RecordMenuViewTests(AnalyticsAPITestCase):
    """UC-GUEST-004 - POST /api/v1/menu/{slug}/views/"""

    def send(self, body=None, slug='tartus-coffee', **extra):
        url = reverse('public_analytics:view', kwargs={'slug': slug})
        return self.client.post(url, body, format='json', **extra)

    def counters(self, cafe=None):
        rows = MenuViewCount.objects.filter(cafe=cafe or self.cafe).order_by('table_number')
        return list(rows.values_list('table_number', 'count'))

    def test_an_open_adds_one_to_the_counter_of_its_hour_and_table(self):  # Main flow
        hour = datetime(2026, 11, 10, 14, tzinfo=dt_timezone.utc)
        with mock.patch('django.utils.timezone.now', return_value=hour.replace(minute=59, second=30)):
            first = self.send({'table': 1})
            self.send({'table': 1})
            self.send({'table': None})
        with mock.patch('django.utils.timezone.now', return_value=hour + timedelta(hours=1)):
            self.send({'table': 1})

        self.assertEqual((first.status_code, first.content), (status.HTTP_204_NO_CONTENT, b''))
        rows = MenuViewCount.objects.order_by('hour', 'table_number').values_list('hour', 'table_number', 'count')
        self.assertEqual(list(rows), [(hour, 0, 1), (hour, 1, 2), (hour + timedelta(hours=1), 1, 1)])  # one row per counter

    def test_no_body_counts_as_no_table(self):  # A4, last sentence
        self.assertEqual(self.send().status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(self.send({}).status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(self.counters(), [(0, 2)])

    def test_a_number_that_is_not_an_active_table_of_this_cafe_counts_as_no_table(self):  # A3
        for table in (2, 5, 200):  # inactive here, a table of another cafe, no such table
            self.assertEqual(self.send({'table': table}).status_code, status.HTTP_204_NO_CONTENT)

        self.assertEqual(self.counters(), [(0, 3)])
        self.assertEqual(self.counters(self.other_cafe), [])  # nothing was written for the other cafe

    def test_an_invalid_table_returns_400_and_counts_nothing(self):  # A4
        cases = [
            (0, ['Ensure this value is greater than or equal to 1.']),
            (201, ['Ensure this value is less than or equal to 200.']),
            ('three', ['A valid integer is required.']),
            (1.5, ['A valid integer is required.']),
        ]
        for table, errors in cases:
            with self.subTest(table=table):
                response = self.send({'table': table})

                self.assertEqual((response.status_code, response.data), (status.HTTP_400_BAD_REQUEST, {'table': errors}))
        self.assertFalse(MenuViewCount.objects.exists())

    def test_an_unknown_slug_returns_404(self):  # A1
        response = self.send({'table': 1}, slug='no-such-cafe')

        self.assertEqual((response.status_code, response.data), (status.HTTP_404_NOT_FOUND, {'detail': 'Not found.'}))

    def test_an_inactive_cafe_answers_204_and_counts_nothing(self):  # A2
        Cafe.objects.filter(pk=self.cafe.pk).update(is_active=False)

        self.assertEqual(self.send({'table': 1}).status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(MenuViewCount.objects.exists())

    def test_it_is_public_and_a_stray_token_header_is_ignored(self):
        response = self.send({'table': 1}, HTTP_AUTHORIZATION='Bearer not-a-token')

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(self.client.get(reverse('public_analytics:view', kwargs={'slug': 'tartus-coffee'})).status_code,
                         status.HTTP_405_METHOD_NOT_ALLOWED)

    def test_two_first_opens_of_an_hour_at_the_same_moment_both_count(self):  # the insert race
        self.send({'table': 1})  # the other request: its row is already there
        real_update, calls = QuerySet.update, []

        def row_not_seen_yet(queryset, **fields):
            # This request looked for the row just before the other one inserted it: its first UPDATE
            # finds nothing, so it tries the INSERT, which the unique constraint refuses.
            calls.append(fields)
            return 0 if len(calls) == 1 else real_update(queryset, **fields)

        with mock.patch.object(QuerySet, 'update', row_not_seen_yet):
            response = self.send({'table': 1})

        self.assertEqual((response.status_code, len(calls)), (status.HTTP_204_NO_CONTENT, 2))
        self.assertEqual(self.counters(), [(1, 2)])  # no error, no second row, and both opens counted

    def test_nothing_about_the_visitor_is_stored(self):  # privacy: only cafe, hour, table and a number
        self.send({'table': 1}, HTTP_USER_AGENT='Mozilla/5.0', REMOTE_ADDR='203.0.113.7', HTTP_COOKIE='lang=ar')

        fields = {field.name for field in MenuViewCount._meta.get_fields()}
        self.assertEqual(fields, {'id', 'cafe', 'hour', 'table_number', 'count'})


class AnalyticsReadTests(AnalyticsAPITestCase):
    """GET analytics/summary/ (UC-OWNER-015) and analytics/detail/ (UC-OWNER-016)"""

    summary_url = reverse('analytics:summary')
    detail_url = reverse('analytics:detail')

    def setUp(self):
        self.log_in(self.owner)

    def day(self, offset):
        return (business_today() + timedelta(days=offset)).isoformat()

    def test_summary_has_one_number_per_day_with_zeros_for_empty_days(self):  # UC-OWNER-015 main flow, A2
        self.at(0, 9, self.cafe, table=1, count=4)
        self.at(0, 21, self.cafe, count=2)  # the same day, another hour and table
        self.at(-2, 12, self.cafe, count=5)
        self.at(-6, 0, self.cafe, count=1)  # the first hour of the period
        self.at(-7, 23, self.cafe, count=50)  # one hour before the period
        self.at(0, 9, self.other_cafe, count=99)  # another cafe

        response = self.client.get(self.summary_url)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data, {
            'days': 7, 'total': 12,
            'by_day': [
                {'date': self.day(-6), 'count': 1}, {'date': self.day(-5), 'count': 0}, {'date': self.day(-4), 'count': 0},
                {'date': self.day(-3), 'count': 0}, {'date': self.day(-2), 'count': 5}, {'date': self.day(-1), 'count': 0},
                {'date': self.day(0), 'count': 6},
            ],
        })

    def test_a_day_is_a_day_in_damascus(self):  # the hour 21:00-22:00 UTC belongs to the next day there
        today = business_today()
        late = datetime(today.year, today.month, today.day, tzinfo=dt_timezone.utc) - timedelta(hours=3)  # 00:00 Damascus
        MenuViewCount.objects.create(cafe=self.cafe, hour=late, count=3)
        MenuViewCount.objects.create(cafe=self.cafe, hour=late - timedelta(hours=1), count=7)  # 23:00 the day before

        response = self.client.get(self.summary_url)

        self.assertEqual([entry['count'] for entry in response.data['by_day'][-2:]], [7, 3])

    def test_the_period_is_7_30_or_90_days(self):  # UC-OWNER-015 step 1, A1
        self.at(-20, 10, self.cafe, count=2)
        self.at(-80, 10, self.cafe, count=3)

        totals = {}
        for days in (7, 30, 90):
            data = self.client.get(self.summary_url, {'days': days}).data
            totals[days] = (data['days'], data['total'], len(data['by_day']))
        self.assertEqual(totals, {7: (7, 0, 7), 30: (30, 2, 30), 90: (90, 5, 90)})
        for url in (self.summary_url, self.detail_url):
            for days in ('5', '365', 'week'):
                with self.subTest(url=url, days=days):
                    response = self.client.get(url, {'days': days})

                    self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                    self.assertEqual(response.data, {'days': [f'"{days}" is not a valid choice.']})

    def test_detail_groups_by_hour_of_the_day_and_by_table(self):  # UC-OWNER-016 main flow
        self.at(0, 9, self.cafe, table=1, count=4)
        self.at(-1, 9, self.cafe, table=1, count=6)  # the same hour of the day, another day
        self.at(-1, 9, self.cafe, count=3)
        self.at(-3, 23, self.cafe, count=8)
        self.at(-7, 9, self.cafe, table=1, count=50)  # before the period
        self.at(0, 9, self.other_cafe, table=5, count=99)  # another cafe

        response = self.client.get(self.detail_url)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual((response.data['days'], response.data['total']), (7, 21))
        by_hour = {entry['hour']: entry['count'] for entry in response.data['by_hour']}
        self.assertEqual(list(by_hour), list(range(24)))  # every hour, in order
        self.assertEqual({hour: count for hour, count in by_hour.items() if count}, {9: 13, 23: 8})
        self.assertEqual(response.data['by_table'], [{'table_number': 0, 'count': 11}, {'table_number': 1, 'count': 10}])

    def test_detail_without_opens(self):  # UC-OWNER-016 A3
        response = self.client.get(self.detail_url, {'days': 30})

        self.assertEqual((response.data['total'], response.data['by_table']), (0, []))
        self.assertEqual(sum(entry['count'] for entry in response.data['by_hour']), 0)

    def test_detail_needs_the_plan_flag_but_summary_does_not(self):  # UC-OWNER-016 A1, by the flag not the name
        self.log_in(self.other_owner)  # Basic

        summary = self.client.get(self.summary_url)
        detail = self.client.get(self.detail_url)
        SubscriptionPlan.objects.filter(pk=self.basic.pk).update(allows_detailed_analytics=True)
        allowed = self.client.get(self.detail_url)

        self.assertEqual(summary.status_code, status.HTTP_200_OK)
        self.assertEqual((detail.status_code, detail.data),
                         (status.HTTP_403_FORBIDDEN, {'detail': 'Detailed analytics require a Pro plan.'}))
        self.assertEqual(detail['X-Error-Code'], 'analytics_need_pro')
        self.assertEqual(allowed.status_code, status.HTTP_200_OK)  # the name is still "basic"

    def test_each_owner_sees_only_the_opens_of_their_own_cafe(self):  # tenant isolation
        self.at(0, 9, self.cafe, table=1, count=4)
        self.at(0, 9, self.other_cafe, table=5, count=9)
        SubscriptionPlan.objects.filter(pk=self.basic.pk).update(allows_detailed_analytics=True)
        seen = {}
        for owner in (self.owner, self.other_owner):
            self.log_in(owner)
            # A cafe id or slug in the query changes nothing: the cafe comes from the token.
            summary = self.client.get(self.summary_url, {'cafe': self.cafe.pk, 'slug': 'tartus-coffee'})
            detail = self.client.get(self.detail_url, {'cafe': self.cafe.pk})
            seen[owner.email] = (summary.data['total'], detail.data['by_table'])

        self.assertEqual(seen, {
            'owner@cafe.com': (4, [{'table_number': 1, 'count': 4}]),
            'other@cafe.com': (9, [{'table_number': 5, 'count': 9}]),
        })

    def test_only_the_owner_of_an_active_cafe_may_read(self):  # A3, A4; Global Conventions 1, 2 and 5
        admin = User.objects.create_user(email='admin@platform.com', role=User.Role.SYSTEM_ADMIN)
        no_role = {'detail': 'You do not have permission to perform this action.'}
        inactive = {'detail': 'Your subscription is inactive. Please contact support.'}
        Cafe.objects.filter(pk=self.other_cafe.pk).update(is_active=False)
        callers = [
            ('no token', None, 401, {'detail': 'Authentication credentials were not provided.'}),
            ('super admin', admin, 403, no_role),
            ('owner of an inactive cafe', self.other_owner, 403, inactive),  # before the plan check
        ]
        for label, user, status_code, body in callers:
            self.client.credentials() if user is None else self.log_in(user)
            for url in (self.summary_url, self.detail_url):
                with self.subTest(caller=label, url=url):
                    response = self.client.get(url)

                    self.assertEqual((response.status_code, response.data), (status_code, body))

    def test_the_reads_are_get_only(self):
        for url in (self.summary_url, self.detail_url):
            self.assertEqual(self.client.post(url, {}, format='json').status_code, status.HTTP_405_METHOD_NOT_ALLOWED)


class PruneMenuViewsCommandTests(AnalyticsAPITestCase):
    """python manage.py prune_menu_views (system_design.md §5)."""

    def test_counters_older_than_400_days_are_deleted(self):
        kept = [self.at(0, 9, self.cafe), self.at(-400, 0, self.cafe)]  # the first hour that is kept
        self.at(-401, 23, self.cafe)  # one hour older
        self.at(-800, 9, self.other_cafe)
        out = StringIO()

        call_command('prune_menu_views', stdout=out)
        call_command('prune_menu_views', stdout=out)  # a second run finds nothing

        self.assertEqual(out.getvalue(), 'Deleted 2 old menu view counters.\nDeleted 0 old menu view counters.\n')
        self.assertEqual(set(MenuViewCount.objects.values_list('pk', flat=True)), {row.pk for row in kept})

    def test_deleting_a_cafe_deletes_its_counters(self):  # CASCADE (system_design.md 2.3)
        self.at(0, 9, self.cafe)
        self.at(0, 9, self.other_cafe)

        self.cafe.delete()

        self.assertEqual(list(MenuViewCount.objects.values_list('cafe_id', flat=True)), [self.other_cafe.pk])
