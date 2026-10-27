"""
API integration tests for the menu dashboard endpoints: categories (use_cases.md UC-OWNER-001,
UC-OWNER-003, UC-OWNER-012) and menu items (UC-OWNER-002, UC-OWNER-013).
Each test sends real HTTP requests through URL -> view -> service -> database.
"""

import json
from datetime import timedelta
from decimal import Decimal
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
    item_list_url = reverse('menu:item-list')
    item_reorder_url = reverse('menu:item-reorder')

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

    @staticmethod
    def item_url(pk):
        return reverse('menu:item-detail', kwargs={'pk': pk})

    @staticmethod
    def availability_url(pk):
        return reverse('menu:item-availability', kwargs={'pk': pk})


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


class ItemAPITestCase(CategoryAPITestCase):
    """
    Adds item data: Food (sort_order 100) and Drinks (200), the item Tea in Drinks,
    and an item of the other cafe that the owner must never see or change.
    """

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.food = Category.objects.create(cafe=cls.cafe, name={'ar': 'Food', 'en': ''}, sort_order=100)
        cls.drinks = Category.objects.create(cafe=cls.cafe, name={'ar': 'Drinks', 'en': ''}, sort_order=200)
        cls.tea = MenuItem.objects.create(
            cafe=cls.cafe, category=cls.drinks, name={'ar': 'Tea', 'en': ''}, price=Decimal('5.00')
        )
        cls.foreign_item = MenuItem.objects.create(
            cafe=cls.other_cafe, category=cls.foreign, name={'ar': 'Foreign', 'en': ''}, price=Decimal('1.00')
        )

    def tea_data(self, **changes):
        """Tea as the API returns it (UC-OWNER-013 shape), with `changes` applied."""
        data = {
            'id': self.tea.pk, 'category_id': self.drinks.pk, 'name': {'ar': 'Tea', 'en': ''},
            'description': {'ar': '', 'en': ''}, 'price': '5.00', 'image_url': '', 'is_available': True,
            'is_featured': False, 'is_new': False, 'sort_order': 100,
        }
        return {**data, **changes}

    def add_item(self, category, name, **fields):
        return MenuItem.objects.create(
            cafe=self.cafe, category=category, name={'ar': name, 'en': ''}, price=Decimal('7.00'), **fields
        )


class ListItemsTests(ItemAPITestCase):
    """UC-OWNER-013 - GET /api/v1/dashboard/items/ (optional ?category=<id>)"""

    def test_lists_own_non_deleted_items_in_menu_order(self):  # Main flow, no filter
        soup = self.add_item(self.food, 'Soup')
        coffee = self.add_item(self.drinks, 'Coffee', sort_order=200, is_available=False)
        self.add_item(self.drinks, 'Old', deleted_at=timezone.now())

        response = self.client.get(self.item_list_url)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        # Food (100) before Drinks (200), then each item's sort_order. Unavailable items are
        # listed; deleted items and the other cafe's item are not.
        self.assertEqual([item['id'] for item in response.data], [soup.pk, self.tea.pk, coffee.pk])
        self.assertEqual(response.data[1], self.tea_data())  # the full shape of one item

    def test_category_filter(self):  # Main flow with ?category=<id>, A1, A2, A3
        coffee = self.add_item(self.drinks, 'Coffee', sort_order=200)
        cases = [
            (self.drinks.pk, status.HTTP_200_OK, [self.tea.pk, coffee.pk]),
            (self.food.pk, status.HTTP_200_OK, []),  # A1: a category without items
            ('abc', status.HTTP_400_BAD_REQUEST, {'category': ['A valid integer is required.']}),  # A2
            (self.foreign.pk, status.HTTP_404_NOT_FOUND, {'detail': 'Not found.'}),  # A3
        ]
        for category, status_code, expected in cases:
            with self.subTest(category=category):
                response = self.client.get(self.item_list_url, {'category': category})

                self.assertEqual(response.status_code, status_code)
                body = response.data
                if status_code == status.HTTP_200_OK:
                    body = [item['id'] for item in body]
                self.assertEqual(body, expected)


class CreateItemTests(ItemAPITestCase):
    """UC-OWNER-002 (create) - POST /api/v1/dashboard/items/"""

    def test_create_returns_201_at_the_end_of_its_category(self):  # Main flow
        body = {'category_id': self.drinks.pk, 'name': {'ar': 'Coffee'}, 'price': '12.5', 'is_new': True}

        response = self.client.post(self.item_list_url, body, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        coffee = MenuItem.objects.get(pk=response.data['id'], cafe=self.cafe)
        # After Tea (100) in Drinks; the price is a string with two decimals (Global Convention 10).
        self.assertEqual(response.data, {
            'id': coffee.pk, 'category_id': self.drinks.pk, 'name': {'ar': 'Coffee', 'en': ''},
            'description': {'ar': '', 'en': ''}, 'price': '12.50', 'image_url': '', 'is_available': True,
            'is_featured': False, 'is_new': True, 'sort_order': 200,
        })

    def test_read_only_fields_in_the_body_are_ignored(self):  # Architectural Note
        body = {
            'category_id': self.food.pk, 'name': {'ar': 'Soup'}, 'price': '7.00', 'cafe': self.other_cafe.pk,
            'sort_order': 5, 'image_url': 'https://example.test/soup.png', 'is_available': False,
        }

        response = self.client.post(self.item_list_url, body, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        soup = MenuItem.objects.get(pk=response.data['id'])
        self.assertEqual(
            (soup.cafe_id, soup.sort_order, soup.image_url, soup.is_available), (self.cafe.pk, 100, '', True)
        )

    def test_create_over_the_plan_limit_returns_403(self):  # A1
        SubscriptionPlan.objects.filter(pk=self.cafe.plan_id).update(max_items=2)
        self.add_item(self.food, 'Soup')  # with Tea: 2 of 2
        body = {'category_id': self.food.pk, 'name': {'ar': 'Bread'}, 'price': '2.00'}

        response = self.client.post(self.item_list_url, body, format='json')

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(
            response.data, {'detail': 'Your Basic plan allows a maximum of 2 items. Upgrade to Pro for unlimited.'}
        )
        self.assertEqual(MenuItem.objects.filter(cafe=self.cafe).count(), 2)

    def test_unknown_category_returns_404(self):  # A2
        deleted = Category.objects.create(cafe=self.cafe, name={'ar': 'Old', 'en': ''}, deleted_at=timezone.now())
        missing_pk = Category.all_objects.latest('pk').pk + 1
        for label, category_id in [('foreign', self.foreign.pk), ('deleted', deleted.pk), ('missing', missing_pk)]:
            with self.subTest(category=label):
                body = {'category_id': category_id, 'name': {'ar': 'Soup'}, 'price': '7.00'}

                response = self.client.post(self.item_list_url, body, format='json')

                self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
                self.assertEqual(response.data, {'detail': 'Not found.'})
        self.assertEqual(MenuItem.objects.filter(cafe=self.cafe).count(), 1)  # only Tea

    def test_invalid_fields_return_400(self):  # A3, A4
        valid = {'category_id': self.food.pk, 'name': {'ar': 'Soup'}, 'price': '7.00'}
        cases = [
            ({**valid, 'price': '-1.00'}, {'price': ['Ensure this value is greater than or equal to 0.']}),  # A3
            ({**valid, 'name': {'en': 'Soup'}}, {'name': {'ar': ['This field is required.']}}),  # A4
            (
                {**valid, 'description': {'ar': 'Hot', 'fr': 'Chaud'}},
                {'description': ['Only the keys "ar" and "en" are allowed.']},  # A4
            ),
            (
                {'name': {'ar': 'Soup'}},
                {'category_id': ['This field is required.'], 'price': ['This field is required.']},
            ),
        ]
        for body, errors in cases:
            with self.subTest(body=body):
                response = self.client.post(self.item_list_url, body, format='json')

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertEqual(response.data, errors)
        self.assertEqual(MenuItem.objects.filter(cafe=self.cafe).count(), 1)


class EditItemTests(ItemAPITestCase):
    """UC-OWNER-002 (edit) - PATCH /api/v1/dashboard/items/{id}/"""

    def test_patch_changes_only_the_sent_fields(self):  # Main flow
        body = {'price': '6', 'is_featured': True, 'description': {'en': 'Green tea'}, 'is_available': False}

        response = self.client.patch(self.item_url(self.tea.pk), body, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        # is_available is ignored: it changes only through its own endpoint (UC-OWNER-005).
        self.assertEqual(response.data, self.tea_data(
            price='6.00', is_featured=True, description={'ar': '', 'en': 'Green tea'},
        ))

    def test_new_category_moves_the_item_to_its_end(self):
        self.add_item(self.food, 'Soup')  # Food: Soup at 100

        response = self.client.patch(self.item_url(self.tea.pk), {'category_id': self.food.pk}, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual((response.data['category_id'], response.data['sort_order']), (self.food.pk, 200))

    def test_move_to_an_unknown_category_returns_404(self):  # A2
        deleted = Category.objects.create(cafe=self.cafe, name={'ar': 'Old', 'en': ''}, deleted_at=timezone.now())
        for label, category_id in [('foreign', self.foreign.pk), ('deleted', deleted.pk)]:
            with self.subTest(category=label):
                response = self.client.patch(self.item_url(self.tea.pk), {'category_id': category_id}, format='json')

                self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
                self.assertEqual(response.data, {'detail': 'Not found.'})
        self.tea.refresh_from_db()
        self.assertEqual((self.tea.category_id, self.tea.sort_order), (self.drinks.pk, 100))


class DeleteItemTests(ItemAPITestCase):
    """UC-OWNER-002 (delete) - DELETE /api/v1/dashboard/items/{id}/"""

    def test_delete_soft_deletes_the_item(self):  # Main flow
        response = self.client.delete(self.item_url(self.tea.pk))

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertIsNotNone(MenuItem.all_objects.get(pk=self.tea.pk).deleted_at)  # the row is kept
        self.assertEqual(self.client.get(self.item_list_url).data, [])


class ItemNotFoundTests(ItemAPITestCase):
    """PATCH and DELETE answer 404 for a foreign, deleted or missing item (ownership masking)."""

    def test_foreign_deleted_or_missing_item_returns_404(self):
        deleted = self.add_item(self.drinks, 'Old', deleted_at=timezone.now())
        missing_pk = MenuItem.all_objects.latest('pk').pk + 1
        for label, pk in [('foreign', self.foreign_item.pk), ('deleted', deleted.pk), ('missing', missing_pk)]:
            responses = {
                'PATCH': self.client.patch(self.item_url(pk), {'price': '9.99'}, format='json'),
                'DELETE': self.client.delete(self.item_url(pk)),
            }
            for method, response in responses.items():
                with self.subTest(item=label, method=method):
                    self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
                    self.assertEqual(response.data, {'detail': 'Not found.'})
        self.foreign_item.refresh_from_db()  # the other cafe's item was neither changed nor deleted
        self.assertEqual((self.foreign_item.price, self.foreign_item.deleted_at), (Decimal('1.00'), None))


class ReorderItemsTests(ItemAPITestCase):
    """UC-OWNER-004 - POST /api/v1/dashboard/items/reorder/"""

    def setUp(self):
        super().setUp()
        self.coffee = self.add_item(self.drinks, 'Coffee', sort_order=200)  # Drinks: Tea 100, Coffee 200

    def drinks_order(self):
        return dict(MenuItem.objects.filter(category=self.drinks).values_list('pk', 'sort_order'))

    def test_reorder_returns_200_with_the_new_order(self):  # Main flow
        response = self.client.post(
            self.item_reorder_url, {'ordered_ids': [self.coffee.pk, self.tea.pk]}, format='json'
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            [(item['id'], item['sort_order']) for item in response.data], [(self.coffee.pk, 100), (self.tea.pk, 200)]
        )
        self.assertEqual(self.drinks_order(), {self.coffee.pk: 100, self.tea.pk: 200})  # saved

    def test_errors_reject_the_whole_list(self):  # A1, A2, and a full list as for categories
        soup = self.add_item(self.food, 'Soup')
        deleted = self.add_item(self.drinks, 'Old', deleted_at=timezone.now())
        incomplete = {'ordered_ids': ['The list must include every item of the category exactly once.']}
        cases = [
            ([self.coffee.pk, self.tea.pk, self.foreign_item.pk], 404, {'detail': 'Not found.'}),  # A2
            ([self.coffee.pk, self.tea.pk, deleted.pk], 404, {'detail': 'Not found.'}),
            ([self.coffee.pk, self.tea.pk, soup.pk], 400, {'ordered_ids': ['Reorder must be within one category.']}),
            ([self.coffee.pk], 400, incomplete),  # Tea left out
            ([self.coffee.pk, self.tea.pk, self.tea.pk], 400, incomplete),  # Tea twice
            ([], 400, {'ordered_ids': ['This list may not be empty.']}),
        ]
        for ordered_ids, status_code, body in cases:
            with self.subTest(ordered_ids=ordered_ids):
                response = self.client.post(self.item_reorder_url, {'ordered_ids': ordered_ids}, format='json')

                self.assertEqual(response.status_code, status_code)
                self.assertEqual(response.data, body)
                self.assertEqual(self.drinks_order(), {self.tea.pk: 100, self.coffee.pk: 200})  # nothing moved


class ItemAvailabilityTests(ItemAPITestCase):
    """UC-OWNER-005 - PATCH /api/v1/dashboard/items/{id}/availability/"""

    def test_toggle_changes_only_is_available(self):  # Main flow
        body = {'is_available': False, 'price': '1.00'}  # the price is not a field here: ignored

        response = self.client.patch(self.availability_url(self.tea.pk), body, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data, {'id': self.tea.pk, 'is_available': False})
        self.tea.refresh_from_db()
        self.assertEqual((self.tea.is_available, self.tea.price), (False, Decimal('5.00')))

    def test_errors(self):  # A1 and an invalid body
        cases = [
            (self.foreign_item.pk, {'is_available': False}, 404, {'detail': 'Not found.'}),  # A1
            (self.tea.pk, {}, 400, {'is_available': ['This field is required.']}),
            (self.tea.pk, {'is_available': 'maybe'}, 400, {'is_available': ['Must be a valid boolean.']}),
        ]
        for pk, body, status_code, expected in cases:
            with self.subTest(body=body):
                response = self.client.patch(self.availability_url(pk), body, format='json')

                self.assertEqual(response.status_code, status_code)
                self.assertEqual(response.data, expected)
        self.foreign_item.refresh_from_db()
        self.assertTrue(self.foreign_item.is_available)


class CategoryAccessTests(CategoryAPITestCase):
    """Global Conventions 2 and 5 on every endpoint: the token first, then the role, then the subscription."""

    def assert_every_endpoint_answers(self, status_code, data):
        """Call every category and item endpoint: each must give the same error and change nothing."""
        category = Category.objects.create(cafe=self.cafe, name={'ar': 'Drinks', 'en': ''})
        item = MenuItem.objects.create(cafe=self.cafe, category=category, name={'ar': 'Tea'}, price=Decimal('5.00'))
        new_item = {'category_id': category.pk, 'name': {'ar': 'New'}, 'price': '1.00'}
        responses = {
            'GET': self.client.get(self.list_url),
            'POST': self.client.post(self.list_url, {'name': {'ar': 'New'}}, format='json'),
            'PATCH': self.client.patch(self.detail_url(category.pk), {'name': {'ar': 'New'}}, format='json'),
            'DELETE': self.client.delete(self.detail_url(category.pk)),
            'REORDER': self.client.post(self.reorder_url, {'ordered_ids': [category.pk]}, format='json'),
            'ITEMS GET': self.client.get(self.item_list_url),
            'ITEMS POST': self.client.post(self.item_list_url, new_item, format='json'),
            'ITEM PATCH': self.client.patch(self.item_url(item.pk), {'price': '9.99'}, format='json'),
            'ITEM DELETE': self.client.delete(self.item_url(item.pk)),
            'ITEMS REORDER': self.client.post(self.item_reorder_url, {'ordered_ids': [item.pk]}, format='json'),
            'AVAILABILITY': self.client.patch(self.availability_url(item.pk), {'is_available': False}, format='json'),
        }
        for method, response in responses.items():
            with self.subTest(method=method):
                self.assertEqual(response.status_code, status_code)
                self.assertEqual(response.data, data)
        names = list(Category.objects.filter(cafe=self.cafe).values_list('name', flat=True))
        self.assertEqual(names, [{'ar': 'Drinks', 'en': ''}])  # nothing was created, renamed or deleted
        items = list(MenuItem.objects.filter(cafe=self.cafe).values_list('price', 'is_available'))
        self.assertEqual(items, [(Decimal('5.00'), True)])

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
        # UC-OWNER-012 A2, UC-OWNER-001 A3, UC-OWNER-003 A3, UC-OWNER-002 A5, UC-OWNER-013 A4
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
        pie = MenuItem.objects.create(cafe=self.cafe, category=tea, name={'ar': 'Pie'}, price=Decimal('3.00'))
        # Each lambda sends its request only when the loop calls it, inside the capture block.
        # REORDER runs first, while Drinks and Tea are the only categories it has to list.
        writes = {
            'REORDER': lambda: self.client.post(
                self.reorder_url, {'ordered_ids': [tea.pk, category.pk]}, format='json'
            ),
            'POST': lambda: self.client.post(self.list_url, {'name': {'ar': 'Food'}}, format='json'),
            'PATCH': lambda: self.client.patch(self.detail_url(category.pk), {'is_visible': False}, format='json'),
            'ITEM POST': lambda: self.client.post(
                self.item_list_url, {'category_id': tea.pk, 'name': {'ar': 'Cake'}, 'price': '4.00'}, format='json'
            ),
            # Cake (created by ITEM POST at 200) moves before Pie (100), so both rows change.
            'ITEMS REORDER': lambda: self.client.post(
                self.item_reorder_url,
                {'ordered_ids': [MenuItem.objects.get(name__ar='Cake').pk, pie.pk]},
                format='json',
            ),
            'AVAILABILITY': lambda: self.client.patch(
                self.availability_url(pie.pk), {'is_available': False}, format='json'
            ),
            'ITEM PATCH': lambda: self.client.patch(self.item_url(pie.pk), {'price': '3.50'}, format='json'),
            'ITEM DELETE': lambda: self.client.delete(self.item_url(pie.pk)),
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


class PublicMenuTests(APITestCase):
    """UC-GUEST-001 and UC-GUEST-002 - GET /api/v1/menu/{slug}/ (no login)"""

    url = reverse('public_menu:detail', kwargs={'slug': 'tartus-coffee'})

    @classmethod
    def setUpTestData(cls):
        cls.pro = SubscriptionPlan.objects.create(
            name=SubscriptionPlan.Name.PRO, allows_images=True, allows_branding=True
        )
        cls.basic = SubscriptionPlan.objects.create(name=SubscriptionPlan.Name.BASIC, max_categories=5)
        cls.cafe = Cafe.objects.create(
            owner=User.objects.create_user(email='owner@cafe.com'), plan=cls.pro, slug='tartus-coffee',
            name={'ar': 'Tartus Coffee', 'en': ''}, primary_color='#C0392B',
            logo_url='https://media.example.test/logo.webp', is_active=True,
        )
        cls.food = Category.objects.create(cafe=cls.cafe, name={'ar': 'Food', 'en': ''}, sort_order=100)
        cls.drinks = Category.objects.create(cafe=cls.cafe, name={'ar': 'Drinks', 'en': ''}, sort_order=200)
        hidden = Category.objects.create(cafe=cls.cafe, name={'ar': 'Hidden', 'en': ''}, is_visible=False)
        Category.objects.create(cafe=cls.cafe, name={'ar': 'Old', 'en': ''}, deleted_at=timezone.now())
        cls.soup = cls.item(cls.food, 'Soup', '7.00')
        cls.tea = cls.item(
            cls.drinks, 'Tea', '5.00', image_url='https://media.example.test/tea.webp', is_featured=True
        )
        cls.item(cls.drinks, 'Coffee', '6.00', sort_order=200, is_available=False)  # sold out
        cls.item(cls.drinks, 'Juice', '4.00', sort_order=300, deleted_at=timezone.now())
        cls.item(hidden, 'Secret', '1.00')
        Cafe.objects.create(  # a second cafe; none of its data may appear
            owner=User.objects.create_user(email='other@cafe.com'), plan=cls.pro, slug='other-cafe',
            name={'ar': 'Other Cafe'}, is_active=True,
        )

    @classmethod
    def item(cls, category, name, price, **fields):
        return MenuItem.objects.create(
            cafe=category.cafe, category=category, name={'ar': name, 'en': ''}, price=Decimal(price), **fields
        )

    def item_data(self, item, **changes):
        data = {
            'id': item.pk, 'name': {'ar': item.name['ar'], 'en': ''}, 'description': {'ar': '', 'en': ''},
            'price': str(item.price), 'image_url': item.image_url, 'is_available': True,
            'is_featured': item.is_featured, 'is_new': False, 'sort_order': item.sort_order,
        }
        return {**data, **changes}

    def test_menu_shows_visible_categories_and_available_items(self):  # Main flow
        # Three queries for the whole menu (cafe with plan, categories, items): no N+1 problem.
        with self.assertNumQueries(3):
            response = self.client.get(self.url)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        # Hidden or deleted categories, sold-out or deleted items and the other cafe are left out.
        self.assertEqual(response.data, {
            'cafe': {
                'name': {'ar': 'Tartus Coffee', 'en': ''}, 'primary_color': '#C0392B',
                'logo_url': 'https://media.example.test/logo.webp', 'is_active': True,
            },
            'categories': [
                {'id': self.food.pk, 'name': {'ar': 'Food', 'en': ''}, 'sort_order': 100,
                 'items': [self.item_data(self.soup)]},
                {'id': self.drinks.pk, 'name': {'ar': 'Drinks', 'en': ''}, 'sort_order': 200,
                 'items': [self.item_data(self.tea)]},
            ],
        })

    def test_plan_without_images_and_branding_hides_them(self):  # Global Convention 7
        Cafe.objects.filter(pk=self.cafe.pk).update(plan=self.basic)

        response = self.client.get(self.url)

        self.assertEqual((response.data['cafe']['primary_color'], response.data['cafe']['logo_url']), ('', ''))
        self.assertEqual(response.data['categories'][1]['items'], [self.item_data(self.tea, image_url='')])

    def test_inactive_cafe_returns_200_without_categories(self):  # A2, UC-GUEST-002
        Cafe.objects.filter(pk=self.cafe.pk).update(is_active=False)

        response = self.client.get(self.url)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual((response.data['cafe']['is_active'], response.data['categories']), (False, []))

    def test_cafe_without_categories_returns_an_empty_list(self):  # A3
        response = self.client.get(reverse('public_menu:detail', kwargs={'slug': 'other-cafe'}))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['categories'], [])

    def test_unknown_slug_returns_404(self):  # A1
        response = self.client.get(reverse('public_menu:detail', kwargs={'slug': 'no-such-cafe'}))

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(response.data, {'detail': 'Not found.'})

    def test_no_login_needed_and_a_stray_token_is_ignored(self):
        self.client.credentials(HTTP_AUTHORIZATION='Bearer not-a-real-token')

        response = self.client.get(self.url)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
