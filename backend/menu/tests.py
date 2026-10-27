"""
API integration tests for the category endpoints (use_cases.md UC-OWNER-001 and UC-OWNER-012).
Each test sends real HTTP requests through URL -> view -> service -> database.
"""

import json
from datetime import timedelta
from unittest import mock

from django.contrib.auth import get_user_model
from django.test import override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import AccessToken

from cafes.models import Cafe, SubscriptionPlan

from .models import Category, MenuItem

User = get_user_model()


class CategoryAPITestCase(APITestCase):
    """
    Shared data for the category tests: an owner with an active Basic cafe (limit: 5 categories),
    and a second cafe with one category that the owner must never see or change.
    """

    list_url = reverse('menu:category-list')
    reorder_url = reverse('menu:category-reorder')

    @classmethod
    def setUpTestData(cls):
        plan = SubscriptionPlan.objects.create(name=SubscriptionPlan.Name.BASIC, max_categories=5)
        cls.owner = User.objects.create_user(email='owner@cafe.com')  # no password: the tests use a token
        cls.cafe = Cafe.objects.create(
            owner=cls.owner, plan=plan, slug='tartus-coffee', name={'ar': 'Tartus Coffee'}, is_active=True
        )
        other_owner = User.objects.create_user(email='other@cafe.com')
        cls.other_cafe = Cafe.objects.create(
            owner=other_owner, plan=plan, slug='other-cafe', name={'ar': 'Other Cafe'}, is_active=True
        )
        cls.foreign = Category.objects.create(cafe=cls.other_cafe, name={'ar': 'Foreign', 'en': ''})

    def setUp(self):
        # A real JWT, as after a login: each request loads the user and the cafe from the database.
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {AccessToken.for_user(self.owner)}')

    @staticmethod
    def detail_url(pk):
        return reverse('menu:category-detail', kwargs={'pk': pk})


class ListCategoriesTests(CategoryAPITestCase):
    """UC-OWNER-012 - GET /api/v1/dashboard/categories/"""

    def test_lists_own_non_deleted_categories_by_sort_order(self):  # Main flow
        drinks = Category.objects.create(cafe=self.cafe, name={'ar': 'Drinks', 'en': 'Drinks'}, sort_order=200)
        hidden = Category.objects.create(
            cafe=self.cafe, name={'ar': 'Hidden', 'en': ''}, sort_order=100, is_visible=False
        )
        Category.objects.create(cafe=self.cafe, name={'ar': 'Deleted', 'en': ''}, deleted_at=timezone.now())

        response = self.client.get(self.list_url)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        # Sorted by sort_order. Hidden ones are listed; deleted ones and other cafes' categories are not.
        self.assertEqual(response.data, [
            {'id': hidden.pk, 'name': {'ar': 'Hidden', 'en': ''}, 'sort_order': 100, 'is_visible': False},
            {'id': drinks.pk, 'name': {'ar': 'Drinks', 'en': 'Drinks'}, 'sort_order': 200, 'is_visible': True},
        ])

    def test_no_categories_returns_empty_list(self):  # A1
        response = self.client.get(self.list_url)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data, [])  # the other cafe's category is not listed


class CreateCategoryTests(CategoryAPITestCase):
    """UC-OWNER-001 (create) - POST /api/v1/dashboard/categories/"""

    def test_create_returns_201_with_gapped_sort_order(self):  # Main flow
        first = self.client.post(self.list_url, {'name': {'ar': 'Drinks'}}, format='json')
        second = self.client.post(
            self.list_url, {'name': {'ar': 'Food', 'en': 'Food'}, 'is_visible': False}, format='json'
        )

        self.assertEqual(first.status_code, status.HTTP_201_CREATED)
        drinks = Category.objects.get(pk=first.data['id'], cafe=self.cafe)  # saved, in the owner's cafe
        # A missing "en" is stored as "". The gap is per cafe: the other cafe's category does not count.
        self.assertEqual(
            first.data, {'id': drinks.pk, 'name': {'ar': 'Drinks', 'en': ''}, 'sort_order': 100, 'is_visible': True}
        )
        self.assertEqual(second.status_code, status.HTTP_201_CREATED)
        self.assertEqual((second.data['sort_order'], second.data['is_visible']), (200, False))

    def test_cafe_and_sort_order_in_the_body_are_ignored(self):  # tenant isolation
        body = {'name': {'ar': 'Drinks'}, 'cafe': self.other_cafe.pk, 'sort_order': 5}

        response = self.client.post(self.list_url, body, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        created = Category.objects.get(pk=response.data['id'])
        # The cafe comes from request.user.cafe, and sort_order from the service.
        self.assertEqual((created.cafe_id, created.sort_order), (self.cafe.pk, 100))

    def test_create_over_the_plan_limit_returns_403(self):  # A1
        Category.objects.bulk_create([Category(cafe=self.cafe, name={'ar': f'C{n}', 'en': ''}) for n in range(5)])

        response = self.client.post(self.list_url, {'name': {'ar': 'Sixth'}}, format='json')

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(
            response.data, {'detail': 'Your Basic plan allows a maximum of 5 categories. Upgrade to Pro for unlimited.'}
        )
        self.assertEqual(Category.objects.filter(cafe=self.cafe).count(), 5)  # no 6th category was saved

    def test_deleted_and_foreign_categories_do_not_count_toward_the_limit(self):  # Global Convention 3
        # 4 live + 1 deleted here, plus self.foreign in the other cafe. Correct count: 4.
        # A count that missed the deleted or the cafe filter would reach the limit of 5 and answer 403.
        Category.objects.bulk_create([Category(cafe=self.cafe, name={'ar': f'C{n}', 'en': ''}) for n in range(4)])
        Category.objects.create(cafe=self.cafe, name={'ar': 'Deleted', 'en': ''}, deleted_at=timezone.now())

        response = self.client.post(self.list_url, {'name': {'ar': 'Fifth'}}, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

    def test_invalid_name_returns_400_with_field_errors(self):  # A4, Global Convention 6
        cases = [
            ({'en': 'Drinks'}, {'name': {'ar': ['This field is required.']}}),
            ({'ar': ''}, {'name': {'ar': ['This field may not be blank.']}}),
            ({'ar': 123}, {'name': {'ar': ['Not a valid string.']}}),
            ({'ar': 'Drinks', 'fr': 'Boissons'}, {'name': ['Only the keys "ar" and "en" are allowed.']}),
        ]
        for name, errors in cases:
            with self.subTest(name=name):
                response = self.client.post(self.list_url, {'name': name}, format='json')

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertEqual(response.data, errors)
        self.assertFalse(Category.objects.filter(cafe=self.cafe).exists())


class EditCategoryTests(CategoryAPITestCase):
    """UC-OWNER-001 (edit) - PATCH /api/v1/dashboard/categories/{id}/"""

    def test_patch_changes_only_the_sent_fields(self):  # Main flow
        category = Category.objects.create(cafe=self.cafe, name={'ar': 'Drinks', 'en': 'Drinks'}, sort_order=300)

        hide = self.client.patch(self.detail_url(category.pk), {'is_visible': False}, format='json')
        rename = self.client.patch(self.detail_url(category.pk), {'name': {'ar': 'Hot drinks'}}, format='json')

        self.assertEqual(hide.status_code, status.HTTP_200_OK)
        self.assertEqual(hide.data['name'], {'ar': 'Drinks', 'en': 'Drinks'})  # not sent, so not changed
        self.assertEqual(rename.status_code, status.HTTP_200_OK)
        # A sent name replaces the old one as a whole, so the missing "en" becomes "".
        self.assertEqual(rename.data, {
            'id': category.pk, 'name': {'ar': 'Hot drinks', 'en': ''}, 'sort_order': 300, 'is_visible': False,
        })

    def test_patch_name_without_ar_returns_400(self):  # A4: "ar" stays required in a PATCH
        category = Category.objects.create(cafe=self.cafe, name={'ar': 'Drinks', 'en': ''})

        response = self.client.patch(self.detail_url(category.pk), {'name': {'en': 'Hot drinks'}}, format='json')

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(response.data, {'name': {'ar': ['This field is required.']}})


class DeleteCategoryTests(CategoryAPITestCase):
    """UC-OWNER-001 (delete) - DELETE /api/v1/dashboard/categories/{id}/"""

    def test_delete_soft_deletes_the_category_and_its_items(self):  # Main flow
        category = Category.objects.create(cafe=self.cafe, name={'ar': 'Drinks', 'en': ''})
        tea = MenuItem.objects.create(cafe=self.cafe, category=category, name={'ar': 'Tea', 'en': ''}, price='5.00')
        yesterday = timezone.now() - timedelta(days=1)
        old = MenuItem.objects.create(
            cafe=self.cafe, category=category, name={'ar': 'Old', 'en': ''}, price='1.00', deleted_at=yesterday
        )

        response = self.client.delete(self.detail_url(category.pk))

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        category = Category.all_objects.get(pk=category.pk)  # the row is kept: a soft delete
        self.assertIsNotNone(category.deleted_at)
        # The live item gets the same timestamp; the item deleted earlier keeps its own.
        self.assertEqual(MenuItem.all_objects.get(pk=tea.pk).deleted_at, category.deleted_at)
        self.assertEqual(MenuItem.all_objects.get(pk=old.pk).deleted_at, yesterday)
        self.assertEqual(self.client.get(self.list_url).data, [])  # gone from the dashboard list


class CategoryNotFoundTests(CategoryAPITestCase):
    """UC-OWNER-001 A2: PATCH and DELETE answer 404 for a foreign, deleted or missing category."""

    def test_foreign_deleted_or_missing_category_returns_404(self):
        deleted = Category.objects.create(cafe=self.cafe, name={'ar': 'Old', 'en': ''}, deleted_at=timezone.now())
        missing_pk = Category.all_objects.latest('pk').pk + 1  # no row has this id

        for label, pk in [('foreign', self.foreign.pk), ('deleted', deleted.pk), ('missing', missing_pk)]:
            responses = {
                'PATCH': self.client.patch(self.detail_url(pk), {'name': {'ar': 'Changed'}}, format='json'),
                'DELETE': self.client.delete(self.detail_url(pk)),
            }
            for method, response in responses.items():
                with self.subTest(category=label, method=method):
                    # Ownership masking: a foreign id gets exactly the same answer as a missing one.
                    self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
                    self.assertEqual(response.data, {'detail': 'Not found.'})
        self.foreign.refresh_from_db()  # the other cafe's category was neither renamed nor deleted
        self.assertEqual((self.foreign.name, self.foreign.deleted_at), ({'ar': 'Foreign', 'en': ''}, None))


class ReorderCategoriesTests(CategoryAPITestCase):
    """UC-OWNER-003 - POST /api/v1/dashboard/categories/reorder/"""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.a, cls.b, cls.c = [
            Category.objects.create(cafe=cls.cafe, name={'ar': name, 'en': ''}, sort_order=sort_order)
            for name, sort_order in [('A', 100), ('B', 200), ('C', 300)]
        ]

    def assert_order_unchanged(self):
        sort_orders = dict(Category.objects.filter(cafe=self.cafe).values_list('pk', 'sort_order'))
        self.assertEqual(sort_orders, {self.a.pk: 100, self.b.pk: 200, self.c.pk: 300})

    def test_reorder_returns_200_with_the_new_order(self):  # Main flow
        body = {'ordered_ids': [self.c.pk, self.a.pk, self.b.pk]}

        response = self.client.post(self.reorder_url, body, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        # Every category in the new order, renumbered 100, 200, 300, in the same shape as the list.
        self.assertEqual(response.data, [
            {'id': self.c.pk, 'name': {'ar': 'C', 'en': ''}, 'sort_order': 100, 'is_visible': True},
            {'id': self.a.pk, 'name': {'ar': 'A', 'en': ''}, 'sort_order': 200, 'is_visible': True},
            {'id': self.b.pk, 'name': {'ar': 'B', 'en': ''}, 'sort_order': 300, 'is_visible': True},
        ])
        self.assertEqual(self.client.get(self.list_url).data, response.data)  # saved
        self.foreign.refresh_from_db()
        self.assertEqual(self.foreign.sort_order, 100)  # the other cafe's category did not move

    def test_unknown_id_returns_404_and_changes_nothing(self):  # A1
        deleted = Category.objects.create(cafe=self.cafe, name={'ar': 'Old', 'en': ''}, deleted_at=timezone.now())
        missing_pk = Category.all_objects.latest('pk').pk + 1  # no row has this id
        cases = [
            ('foreign', [self.c.pk, self.a.pk, self.b.pk, self.foreign.pk]),
            ('deleted', [self.c.pk, self.a.pk, self.b.pk, deleted.pk]),
            ('missing', [self.c.pk, self.a.pk, self.b.pk, missing_pk]),
            ('foreign in an incomplete list', [self.c.pk, self.foreign.pk]),  # A1 is checked before A2
        ]
        for label, ordered_ids in cases:
            with self.subTest(case=label):
                response = self.client.post(self.reorder_url, {'ordered_ids': ordered_ids}, format='json')

                self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
                self.assertEqual(response.data, {'detail': 'Not found.'})
                self.assert_order_unchanged()  # all or nothing: the valid ids did not move either

    def test_incomplete_repeated_or_missing_list_returns_400(self):  # A2
        incomplete = {'ordered_ids': ['The list must include every category exactly once.']}
        cases = [
            ({'ordered_ids': [self.c.pk, self.a.pk]}, incomplete),  # B left out
            ({'ordered_ids': [self.c.pk, self.a.pk, self.b.pk, self.a.pk]}, incomplete),  # A twice
            ({}, {'ordered_ids': ['This field is required.']}),
        ]
        for body, errors in cases:
            with self.subTest(body=body):
                response = self.client.post(self.reorder_url, body, format='json')

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertEqual(response.data, errors)
                self.assert_order_unchanged()


class CategoryAccessTests(CategoryAPITestCase):
    """Global Conventions 2 and 5 on all five endpoints: the token first, then the role, then the subscription."""

    def assert_every_endpoint_answers(self, status_code, data):
        """Call every category endpoint: each must give the same error and change nothing."""
        category = Category.objects.create(cafe=self.cafe, name={'ar': 'Drinks', 'en': ''})
        responses = {
            'GET': self.client.get(self.list_url),
            'POST': self.client.post(self.list_url, {'name': {'ar': 'New'}}, format='json'),
            'PATCH': self.client.patch(self.detail_url(category.pk), {'name': {'ar': 'New'}}, format='json'),
            'DELETE': self.client.delete(self.detail_url(category.pk)),
            'REORDER': self.client.post(self.reorder_url, {'ordered_ids': [category.pk]}, format='json'),
        }
        for method, response in responses.items():
            with self.subTest(method=method):
                self.assertEqual(response.status_code, status_code)
                self.assertEqual(response.data, data)
        names = list(Category.objects.filter(cafe=self.cafe).values_list('name', flat=True))
        self.assertEqual(names, [{'ar': 'Drinks', 'en': ''}])  # nothing was created, renamed or deleted

    def test_without_a_token_returns_401(self):
        self.client.credentials()  # remove the Authorization header
        self.assert_every_endpoint_answers(
            status.HTTP_401_UNAUTHORIZED, {'detail': 'Authentication credentials were not provided.'}
        )

    def test_system_admin_gets_the_role_error(self):  # the role check runs before the subscription check
        admin = User.objects.create_user(email='admin@platform.com', role=User.Role.SYSTEM_ADMIN)
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {AccessToken.for_user(admin)}')
        self.assert_every_endpoint_answers(
            status.HTTP_403_FORBIDDEN, {'detail': 'You do not have permission to perform this action.'}
        )

    def test_owner_of_inactive_cafe_gets_the_subscription_error(self):
        # UC-OWNER-012 A2, UC-OWNER-001 A3, UC-OWNER-003 A3
        Cafe.objects.filter(pk=self.cafe.pk).update(is_active=False)
        self.assert_every_endpoint_answers(
            status.HTTP_403_FORBIDDEN, {'detail': 'Your subscription is inactive. Please contact support.'}
        )


@override_settings(FRONTEND_REVALIDATE_URL='http://frontend.test/internal/revalidate')
class MenuRevalidationTests(CategoryAPITestCase):
    """Global Convention 9: each successful write asks Next.js to rebuild /menu/<slug>, after the commit."""

    def test_each_successful_write_sends_one_revalidation_after_the_commit(self):
        category = Category.objects.create(cafe=self.cafe, name={'ar': 'Drinks', 'en': ''})
        tea = Category.objects.create(cafe=self.cafe, name={'ar': 'Tea', 'en': ''}, sort_order=200)
        # Each lambda sends its request only when the loop calls it, inside the capture block.
        # REORDER runs first, while Drinks and Tea are the only categories it has to list.
        writes = {
            'REORDER': lambda: self.client.post(
                self.reorder_url, {'ordered_ids': [tea.pk, category.pk]}, format='json'
            ),
            'POST': lambda: self.client.post(self.list_url, {'name': {'ar': 'Food'}}, format='json'),
            'PATCH': lambda: self.client.patch(self.detail_url(category.pk), {'is_visible': False}, format='json'),
            'DELETE': lambda: self.client.delete(self.detail_url(category.pk)),
        }
        for method, write in writes.items():
            # The mock replaces urlopen: no real HTTP call, but every call is recorded.
            with self.subTest(method=method), mock.patch('urllib.request.urlopen') as urlopen:
                # A TestCase never commits. When this block ends, Django runs the on_commit
                # callbacks, as if the request's transaction had just committed.
                with self.captureOnCommitCallbacks(execute=True):
                    response = write()
                    urlopen.assert_not_called()  # nothing is sent before the commit

                self.assertTrue(status.is_success(response.status_code))
                urlopen.assert_called_once()
                request = urlopen.call_args.args[0]  # the urllib Request that would have been sent
                self.assertEqual(json.loads(request.data), {'slugs': ['tartus-coffee']})

    def test_failed_write_schedules_nothing(self):  # UC-OWNER-001 A2 as the example
        with self.captureOnCommitCallbacks() as callbacks:
            response = self.client.delete(self.detail_url(self.foreign.pk))

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(callbacks, [])  # no revalidation was even scheduled
