"""
API integration tests for the menu dashboard endpoints: categories (use_cases.md UC-OWNER-001,
UC-OWNER-003, UC-OWNER-012) and menu items (UC-OWNER-002, UC-OWNER-004 to UC-OWNER-006, UC-OWNER-013).
Each test sends real HTTP requests through URL -> view -> service -> database.
"""

import json
import urllib.error
from datetime import timedelta
from decimal import Decimal
from io import BytesIO
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.files.storage import default_storage
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.test import override_settings
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone
from PIL import Image
from rest_framework import status
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import AccessToken

from cafes.models import Cafe, SubscriptionPlan
from core.test_runner import data_queries

from .models import Category, MenuItem, MenuItemVariant

User = get_user_model()

# Uploads are kept in memory during tests: nothing reaches R2 or backend/media/.
IN_MEMORY_STORAGES = {
    # A fixed base_url, so the URLs in the tests do not depend on DJANGO_MEDIA_URL.
    'default': {'BACKEND': 'django.core.files.storage.InMemoryStorage', 'OPTIONS': {'base_url': '/media/'}},
    'staticfiles': {'BACKEND': 'django.contrib.staticfiles.storage.StaticFilesStorage'},
}


def image_file(fmt='JPEG', size=(2400, 1200), mode='RGB', name='photo.jpg', **save_params):
    """An uploaded image built in memory with Pillow, as a browser would send it."""
    buffer = BytesIO()
    Image.new(mode, size).save(buffer, format=fmt, **save_params)
    return SimpleUploadedFile(name, buffer.getvalue())


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

    @staticmethod
    def item_image_url(pk):
        return reverse('menu:item-image', kwargs={'pk': pk})


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

    def test_a_limit_of_one_uses_the_singular(self):  # A1, and UC-OWNER-002 A1 for items
        SubscriptionPlan.objects.filter(pk=self.cafe.plan_id).update(max_categories=1, max_items=1)
        category = Category.objects.create(cafe=self.cafe, name={'ar': 'Only', 'en': ''})
        MenuItem.objects.create(cafe=self.cafe, category=category, name={'ar': 'Tea'}, price=Decimal('1.00'))

        refused_category = self.client.post(self.list_url, {'name': {'ar': 'Second'}}, format='json')
        refused_item = self.client.post(
            self.item_list_url, {'category_id': category.pk, 'name': {'ar': 'Cake'}, 'price': '2.00'}, format='json'
        )

        self.assertEqual(refused_category.data['detail'],
                         'Your Basic plan allows a maximum of 1 category. Upgrade to Pro for unlimited.')
        self.assertEqual(refused_item.data['detail'],
                         'Your Basic plan allows a maximum of 1 item. Upgrade to Pro for unlimited.')

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
            'description': {'ar': '', 'en': ''}, 'price': '5.00', 'image_url': '', 'thumbnail_url': '',
            'is_available': True, 'is_featured': False, 'is_new': False, 'tags': [], 'variants': [],
            'sort_order': 100,
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
            ('', status.HTTP_400_BAD_REQUEST, {'category': ['A valid integer is required.']}),  # A2, not every item
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


class ErrorCodeHeaderTests(ItemAPITestCase):
    """core/exceptions.py: a whole-request error names its code in X-Error-Code; the body stays {"detail"}."""

    def test_detail_errors_carry_their_code(self):
        Category.objects.bulk_create([Category(cafe=self.cafe, name={'ar': f'C{n}', 'en': ''}) for n in range(3)])
        cases = [
            ('not found', lambda: self.client.patch(self.item_url(self.foreign_item.pk), {}, format='json'), 'not_found'),
            ('plan limit', lambda: self.client.post(self.list_url, {'name': {'ar': 'Sixth'}}, format='json'),
             'plan_limit_categories'),
            ('bad image', lambda: self.client.post(
                self.item_image_url(self.tea.pk), {'image': SimpleUploadedFile('a.jpg', b'text')}, format='multipart'),
             'images_need_pro'),  # Basic plan: the plan is checked before the file
        ]
        for label, call, code in cases:
            with self.subTest(label):
                response = call()
                self.assertEqual(response['X-Error-Code'], code)
                self.assertEqual(set(response.data), {'detail'})

        Cafe.objects.filter(pk=self.cafe.pk).update(is_active=False)
        self.assertEqual(self.client.get(self.item_list_url)['X-Error-Code'], 'subscription_inactive')

    def test_field_errors_have_no_code_header(self):
        response = self.client.post(self.item_list_url, {}, format='json')

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertNotIn('X-Error-Code', response)


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
            'description': {'ar': '', 'en': ''}, 'price': '12.50', 'image_url': '', 'thumbnail_url': '',
            'is_available': True, 'is_featured': False, 'is_new': True, 'tags': [], 'variants': [],
            'sort_order': 200,
        })

    def test_tags_are_stored_once_each_in_the_fixed_order(self):  # Global Convention 11, on the Basic plan
        body = {'category_id': self.food.pk, 'name': {'ar': 'Salad'}, 'price': '9.00',
                'tags': ['contains_nuts', 'vegan', 'contains_nuts', 'gluten_free', 'vegan']}

        response = self.client.post(self.item_list_url, body, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)  # tags need no plan flag
        self.assertEqual(response.data['tags'], ['vegan', 'gluten_free', 'contains_nuts'])
        self.assertEqual(MenuItem.objects.get(pk=response.data['id']).tags, ['vegan', 'gluten_free', 'contains_nuts'])

    def test_all_six_tags_are_accepted(self):  # Global Convention 11: the whole fixed list
        every_tag = ['vegan', 'vegetarian', 'gluten_free', 'spicy', 'contains_nuts', 'contains_dairy']
        body = {'category_id': self.food.pk, 'name': {'ar': 'Salad'}, 'price': '9.00', 'tags': every_tag[::-1]}

        response = self.client.post(self.item_list_url, body, format='json')

        self.assertEqual((response.status_code, response.data['tags']), (status.HTTP_201_CREATED, every_tag))

    def test_invalid_tags_return_400(self):  # A6
        valid = {'category_id': self.food.pk, 'name': {'ar': 'Salad'}, 'price': '9.00'}
        cases = [
            ('not a list', 'vegan', ['Expected a list of items but got type "str".']),
            ('unknown code', ['halal'], {0: ['"halal" is not a valid choice.']}),
            # The key is the position in the list: the first code is fine, the second is not.
            ('one unknown code', ['vegan', 'Vegan'], {1: ['"Vegan" is not a valid choice.']}),
            ('a number', [5], {0: ['"5" is not a valid choice.']}),
            ('null', None, ['This field may not be null.']),
        ]
        for label, tags, errors in cases:
            with self.subTest(label):
                response = self.client.post(self.item_list_url, {**valid, 'tags': tags}, format='json')

                self.assertEqual((response.status_code, response.data), (status.HTTP_400_BAD_REQUEST, {'tags': errors}))
        self.assertEqual(MenuItem.objects.filter(cafe=self.cafe).count(), 1)  # only Tea

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
            (  # Global Convention 6: at most 100 characters per name, 500 per description
                {**valid, 'name': {'ar': 'Soup', 'en': 'x' * 101}, 'description': {'ar': 'x' * 501}},
                {'name': {'en': ['Ensure this field has no more than 100 characters.']},
                 'description': {'ar': ['Ensure this field has no more than 500 characters.']}},
            ),
            ({'name': {'ar': 'Soup'}, 'price': '7.00'}, {'category_id': ['This field is required.']}),
            # A8: no price and no variants. The service's rule, so it is checked after the fields above.
            ({'category_id': self.food.pk, 'name': {'ar': 'Soup'}}, {'price': ['This field is required.']}),
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

    def test_tags_replace_the_whole_list_and_stay_when_not_sent(self):  # Global Convention 11
        url = self.item_url(self.tea.pk)

        replaced = self.client.patch(url, {'tags': ['spicy', 'vegetarian']}, format='json')
        kept = self.client.patch(url, {'price': '6.00'}, format='json')  # no "tags": the list stays
        swapped = self.client.patch(url, {'tags': ['vegan']}, format='json')  # not added to the old list
        cleared = self.client.patch(url, {'tags': []}, format='json')

        self.assertEqual([r.status_code for r in (replaced, kept, swapped, cleared)], [status.HTTP_200_OK] * 4)
        self.assertEqual([r.data['tags'] for r in (replaced, kept, swapped, cleared)],
                         [['vegetarian', 'spicy'], ['vegetarian', 'spicy'], ['vegan'], []])
        self.tea.refresh_from_db()
        self.assertEqual((self.tea.tags, self.tea.price), ([], Decimal('6.00')))

    def test_invalid_tags_in_a_patch_change_nothing(self):  # A6
        MenuItem.objects.filter(pk=self.tea.pk).update(tags=['vegan'])

        response = self.client.patch(self.item_url(self.tea.pk), {'tags': ['vegan', 'halal'], 'price': '9.00'},
                                     format='json')

        self.assertEqual((response.status_code, response.data),
                         (status.HTTP_400_BAD_REQUEST, {'tags': {1: ['"halal" is not a valid choice.']}}))
        self.tea.refresh_from_db()
        self.assertEqual((self.tea.tags, self.tea.price), (['vegan'], Decimal('5.00')))

    def test_tags_of_another_cafes_item_cannot_be_changed(self):  # tenant isolation, A2
        response = self.client.patch(self.item_url(self.foreign_item.pk), {'tags': ['vegan']}, format='json')

        self.assertEqual((response.status_code, response.data), (status.HTTP_404_NOT_FOUND, {'detail': 'Not found.'}))
        self.foreign_item.refresh_from_db()
        self.assertEqual(self.foreign_item.tags, [])

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


class ItemVariantTests(ItemAPITestCase):
    """Global Convention 10 (variants) through UC-OWNER-002 and UC-OWNER-013."""

    SIZES = [
        {'name': {'ar': 'Large', 'en': 'L'}, 'price': '8'},
        {'name': {'ar': 'Small'}, 'price': '4.50'},
        {'name': {'ar': 'Medium'}, 'price': '6.00'},
    ]

    def set_sizes(self, item, sizes=None):
        """PATCH the item's variants and return the response."""
        return self.client.patch(self.item_url(item.pk), {'variants': self.SIZES if sizes is None else sizes},
                                 format='json')

    @staticmethod
    def names_and_prices(variants):
        return [(variant['name']['ar'], variant['price']) for variant in variants]

    def test_create_with_variants_stores_them_in_the_sent_order(self):  # Main flow (create), on the Basic plan
        body = {'category_id': self.drinks.pk, 'name': {'ar': 'Juice'}, 'variants': self.SIZES}

        response = self.client.post(self.item_list_url, body, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)  # variants need no plan flag
        stored = list(MenuItemVariant.objects.filter(item_id=response.data['id']))
        self.assertEqual(response.data['variants'], [
            {'id': stored[0].pk, 'name': {'ar': 'Large', 'en': 'L'}, 'price': '8.00'},
            {'id': stored[1].pk, 'name': {'ar': 'Small', 'en': ''}, 'price': '4.50'},
            {'id': stored[2].pk, 'name': {'ar': 'Medium', 'en': ''}, 'price': '6.00'},
        ])
        self.assertEqual(response.data['price'], '4.50')  # the lowest variant price, not the first one
        self.assertEqual([(v.sort_order, v.cafe_id) for v in stored], [(100, self.cafe.pk), (200, self.cafe.pk),
                                                                       (300, self.cafe.pk)])

    def test_variants_do_not_count_toward_the_item_limit(self):  # Global Conventions 3 and 10
        SubscriptionPlan.objects.filter(pk=self.cafe.plan_id).update(max_items=2)  # Tea is the first item
        body = {'category_id': self.drinks.pk, 'name': {'ar': 'Juice'}, 'variants': self.SIZES}

        second = self.client.post(self.item_list_url, body, format='json')  # 1 item + 3 variants: allowed
        third = self.client.post(self.item_list_url, body, format='json')

        self.assertEqual((second.status_code, third.status_code), (status.HTTP_201_CREATED, status.HTTP_403_FORBIDDEN))
        self.assertEqual(MenuItemVariant.objects.filter(cafe=self.cafe).count(), 3)  # the refused item left none

    def test_patch_replaces_the_whole_list_and_keeps_it_when_not_sent(self):  # Main flow (edit)
        first = self.set_sizes(self.tea)
        kept = self.client.patch(self.item_url(self.tea.pk), {'is_new': True}, format='json')  # no "variants"
        swapped = self.set_sizes(self.tea, [{'name': {'ar': 'Pot'}, 'price': '9.00'}])  # not added to the old list
        cleared = self.set_sizes(self.tea, [])

        self.assertEqual([r.status_code for r in (first, kept, swapped, cleared)], [status.HTTP_200_OK] * 4)
        self.assertEqual(
            [self.names_and_prices(r.data['variants']) for r in (first, kept, swapped, cleared)],
            [[('Large', '8.00'), ('Small', '4.50'), ('Medium', '6.00')]] * 2 + [[('Pot', '9.00')], []],
        )
        # The item's price follows the lowest variant; without variants it keeps its last price.
        self.assertEqual([r.data['price'] for r in (first, kept, swapped, cleared)], ['4.50', '4.50', '9.00', '9.00'])
        self.assertEqual(MenuItemVariant.objects.filter(item=self.tea).count(), 0)

    def test_price_and_variants_do_not_fit_together(self):  # A8
        message = {'price': ['An item with variants takes its price from them. Do not send price.']}
        new = {'category_id': self.drinks.pk, 'name': {'ar': 'Juice'}}
        self.set_sizes(self.tea)

        both_on_create = self.client.post(self.item_list_url, {**new, 'price': '3.00', 'variants': self.SIZES},
                                          format='json')
        neither_on_create = self.client.post(self.item_list_url, {**new, 'variants': []}, format='json')
        both_on_patch = self.client.patch(self.item_url(self.tea.pk), {'price': '3.00', 'variants': self.SIZES},
                                          format='json')
        price_for_stored_variants = self.client.patch(self.item_url(self.tea.pk), {'price': '3.00'}, format='json')

        self.assertEqual(
            [(r.status_code, r.data) for r in (both_on_create, neither_on_create, both_on_patch,
                                               price_for_stored_variants)],
            [(status.HTTP_400_BAD_REQUEST, message), (status.HTTP_400_BAD_REQUEST, {'price': ['This field is required.']}),
             (status.HTTP_400_BAD_REQUEST, message), (status.HTTP_400_BAD_REQUEST, message)],
        )
        self.tea.refresh_from_db()
        self.assertEqual((self.tea.price, MenuItem.objects.filter(cafe=self.cafe).count()), (Decimal('4.50'), 1))

    def test_price_with_an_empty_list_goes_back_to_one_price(self):  # Global Convention 10
        self.set_sizes(self.tea)

        response = self.client.patch(self.item_url(self.tea.pk), {'price': '5.50', 'variants': []}, format='json')

        self.assertEqual((response.status_code, response.data['price'], response.data['variants']),
                         (status.HTTP_200_OK, '5.50', []))

    def test_invalid_variants_return_400_and_change_nothing(self):  # A7
        self.set_sizes(self.tea, [{'name': {'ar': 'Cup'}, 'price': '5.00'}])
        good = {'name': {'ar': 'Small'}, 'price': '4.00'}
        cases = [
            ('not a list', 'small', {'non_field_errors': ['Expected a list of items but got type "str".']}),
            ('too many', [good] * 11, {'non_field_errors': ['Ensure this field has no more than 10 elements.']}),
            # The key is the position in the list, as for tags: the first variant is fine, the second is not.
            ('negative price', [good, {**good, 'price': '-1'}],
             {1: {'price': ['Ensure this value is greater than or equal to 0.']}}),
            # Nothing may be left out, also in a PATCH.
            ('name and price missing', [{}],
             {0: {'name': ['This field is required.'], 'price': ['This field is required.']}}),
            ('name without ar', [{**good, 'name': {'en': 'Small'}}], {0: {'name': {'ar': ['This field is required.']}}}),
            ('name too long', [{**good, 'name': {'ar': 'x' * 51}}],
             {0: {'name': {'ar': ['Ensure this field has no more than 50 characters.']}}}),
            ('null', None, ['This field may not be null.']),
        ]
        for label, variants, errors in cases:
            with self.subTest(label):
                response = self.client.patch(self.item_url(self.tea.pk), {'variants': variants, 'is_new': True},
                                             format='json')

                self.assertEqual((response.status_code, response.data),
                                 (status.HTTP_400_BAD_REQUEST, {'variants': errors}))
        self.tea.refresh_from_db()
        self.assertEqual((self.tea.is_new, self.names_and_prices(self.client.get(self.item_list_url).data[0]['variants'])),
                         (False, [('Cup', '5.00')]))

    def test_ten_variants_are_accepted(self):  # Global Convention 10: the limit itself
        sizes = [{'name': {'ar': f'Size {n}'}, 'price': str(n)} for n in range(10, 0, -1)]

        response = self.set_sizes(self.tea, sizes)

        self.assertEqual((response.status_code, len(response.data['variants']), response.data['price']),
                         (status.HTTP_200_OK, 10, '1.00'))

    def test_variants_of_another_cafes_item_cannot_be_changed_or_seen(self):  # tenant isolation, A2
        MenuItemVariant.objects.create(item=self.foreign_item, cafe=self.other_cafe, name={'ar': 'Theirs', 'en': ''},
                                       price=Decimal('1.00'))

        response = self.set_sizes(self.foreign_item)
        listed = self.client.get(self.item_list_url)

        self.assertEqual((response.status_code, response.data), (status.HTTP_404_NOT_FOUND, {'detail': 'Not found.'}))
        self.assertEqual(self.names_and_prices(MenuItemVariant.objects.filter(cafe=self.other_cafe).values('name', 'price')),
                         [('Theirs', Decimal('1.00'))])
        self.assertEqual([item['variants'] for item in listed.data], [[]])  # only Tea, without variants

    def test_a_variant_must_belong_to_its_items_cafe(self):  # the model's own check
        with self.assertRaises(ValueError):
            MenuItemVariant.objects.create(item=self.tea, cafe=self.other_cafe, name={'ar': 'Wrong', 'en': ''},
                                           price=Decimal('1.00'))

    def test_the_list_costs_one_more_query_whatever_the_number_of_items(self):  # UC-OWNER-013, no N+1
        self.set_sizes(self.tea)
        self.set_sizes(self.add_item(self.drinks, 'Coffee', sort_order=200), self.SIZES[:2])
        # The request no longer loads the user and the cafe from the database: only the service's queries are left.
        self.client.force_authenticate(self.owner)

        with CaptureQueriesContext(connection) as queries:
            response = self.client.get(self.item_list_url)

        # The items, then the variants of all the items.
        self.assertEqual(len(data_queries(queries)), 2)
        self.assertEqual([len(item['variants']) for item in response.data], [3, 2])

    def test_reorder_and_delete_keep_the_variants(self):  # UC-OWNER-004 shows them; a soft delete keeps the rows
        self.set_sizes(self.tea)

        reordered = self.client.post(self.item_reorder_url, {'ordered_ids': [self.tea.pk]}, format='json')
        deleted = self.client.delete(self.item_url(self.tea.pk))

        self.assertEqual((reordered.status_code, self.names_and_prices(reordered.data[0]['variants'])),
                         (status.HTTP_200_OK, [('Large', '8.00'), ('Small', '4.50'), ('Medium', '6.00')]))
        self.assertEqual((deleted.status_code, MenuItemVariant.objects.filter(item_id=self.tea.pk).count()),
                         (status.HTTP_204_NO_CONTENT, 3))


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


@override_settings(STORAGES=IN_MEMORY_STORAGES, FRONTEND_REVALIDATE_URL='')
class ItemImageTests(ItemAPITestCase):
    """UC-OWNER-006 - POST /api/v1/dashboard/items/{id}/image/ (multipart/form-data). A6: CategoryAccessTests."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.cafe.plan = SubscriptionPlan.objects.create(name=SubscriptionPlan.Name.PRO, allows_images=True)
        cls.cafe.save()

    def upload(self, pk, file):
        return self.client.post(self.item_image_url(pk), {'image': file}, format='multipart')

    @staticmethod
    def stored_key(url):
        return url.removeprefix(default_storage.url(''))  # "/media/" in tests, the R2 domain in production

    def test_upload_returns_200_with_the_processed_image(self):  # Main flow
        exif = Image.Exif()
        exif[0x8825] = {2: (34.0, 53.0, 0.0)}  # GPSInfo: where the photo was taken

        response = self.upload(self.tea.pk, image_file(exif=exif.tobytes()))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        url, thumbnail_url = response.data['image_url'], response.data['thumbnail_url']
        for stored_url in (url, thumbnail_url):
            self.assertRegex(stored_url, rf'^/media/cafes/{self.cafe.pk}/items/[0-9a-f-]{{36}}\.webp$')  # random key
        self.assertNotEqual(url, thumbnail_url)
        self.assertEqual(response.data, self.tea_data(image_url=url, thumbnail_url=thumbnail_url))
        self.tea.refresh_from_db()
        self.assertEqual((self.tea.image_url, self.tea.thumbnail_url), (url, thumbnail_url))
        # The full image (longest side 1200 px) and the small copy for the menu lists (192 px).
        for stored_url, size in ((url, (1200, 600)), (thumbnail_url, (192, 96))):
            with default_storage.open(self.stored_key(stored_url)) as stored, Image.open(stored) as image:
                self.assertEqual((image.format, image.size), ('WEBP', size))
                self.assertNotIn('exif', image.info)  # metadata, with the GPS location, removed

    def test_new_upload_deletes_the_old_image_after_the_commit(self):  # Postconditions, step 7
        with self.captureOnCommitCallbacks(execute=True):
            old = self.upload(self.tea.pk, image_file()).data

        with self.captureOnCommitCallbacks() as callbacks:
            new = self.upload(self.tea.pk, image_file()).data

        old_keys = [self.stored_key(old[name]) for name in ('image_url', 'thumbnail_url')]
        new_keys = [self.stored_key(new[name]) for name in ('image_url', 'thumbnail_url')]
        self.assertTrue(all(default_storage.exists(key) for key in old_keys))  # kept until the commit
        for callback in callbacks:  # what Django runs once the request's transaction commits
            callback()
        self.assertFalse(any(default_storage.exists(key) for key in old_keys))  # the image and its thumbnail
        self.assertTrue(all(default_storage.exists(key) for key in new_keys))

    def test_basic_plan_returns_403(self):  # A1
        Cafe.objects.filter(pk=self.cafe.pk).update(plan=self.other_cafe.plan)  # Basic: allows_images false

        response = self.upload(self.tea.pk, image_file())
        # The plan is checked first (Main Flow step 2): even a request without a file gets the 403.
        without_file = self.client.post(self.item_image_url(self.tea.pk), {}, format='multipart')

        for answer in (response, without_file):
            self.assertEqual(answer.status_code, status.HTTP_403_FORBIDDEN)
            self.assertEqual(answer.data, {'detail': 'Item images require a Pro plan.'})
            self.assertEqual(answer['X-Error-Code'], 'images_need_pro')  # what the frontend translates by

    def test_invalid_files_return_400(self):  # A2, A3, A5
        not_allowed = {'detail': 'Only JPEG, PNG, and WebP images are allowed.'}
        cases = [
            ('a GIF', image_file('GIF', size=(10, 10), name='a.gif'), not_allowed),  # A2
            ('text named .jpg', SimpleUploadedFile('a.jpg', b'not an image'), not_allowed),  # A2: content decides
            ('over 2 MB', SimpleUploadedFile('big.jpg', b'\xff' * (2 * 1024 * 1024 + 1)),
             {'detail': 'Image must be under 2MB.'}),  # A3
            ('over 25 megapixels', image_file('PNG', size=(6000, 5000), mode='1', name='big.png'),
             {'detail': 'Image dimensions are too large.'}),  # A5
            ('no file', None, {'image': ['No file was submitted.']}),
        ]
        for label, file, expected in cases:
            with self.subTest(label):
                body = {} if file is None else {'image': file}
                response = self.client.post(self.item_image_url(self.tea.pk), body, format='multipart')

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertEqual(response.data, expected)
        self.tea.refresh_from_db()
        self.assertEqual(self.tea.image_url, '')

    def test_storage_failure_returns_502(self):  # A4
        with (
            mock.patch.object(default_storage, 'save', side_effect=OSError('R2 is down')),
            self.assertLogs('core.media_storage', level='ERROR'),  # logged server-side
            self.assertLogs('django.request', level='ERROR') as request_log,  # Django logs every 5xx
        ):
            response = self.upload(self.tea.pk, image_file())

        self.assertIn(f'Bad Gateway: /api/v1/dashboard/items/{self.tea.pk}/image/', request_log.output[0])

        self.assertEqual(response.status_code, status.HTTP_502_BAD_GATEWAY)
        self.assertEqual(response.data, {'detail': 'Image upload failed. Please try again.'})
        self.tea.refresh_from_db()
        self.assertEqual(self.tea.image_url, '')

    def test_foreign_deleted_or_missing_item_returns_404(self):  # A7
        deleted = self.add_item(self.drinks, 'Old', deleted_at=timezone.now())
        for pk in (self.foreign_item.pk, deleted.pk, 999999):
            with self.subTest(pk=pk):
                response = self.upload(pk, image_file())

                self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
                self.assertEqual(response.data, {'detail': 'Not found.'})
        self.foreign_item.refresh_from_db()
        self.assertEqual(self.foreign_item.image_url, '')


@override_settings(STORAGES=IN_MEMORY_STORAGES)
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
            'ITEM IMAGE': self.client.post(self.item_image_url(item.pk), {'image': image_file()}, format='multipart'),
        }
        for method, response in responses.items():
            with self.subTest(method=method):
                self.assertEqual(response.status_code, status_code)
                self.assertEqual(response.data, data)
        names = list(Category.objects.filter(cafe=self.cafe).values_list('name', flat=True))
        self.assertEqual(names, [{'ar': 'Drinks', 'en': ''}])  # nothing was created, renamed or deleted
        items = list(MenuItem.objects.filter(cafe=self.cafe).values_list('price', 'is_available', 'image_url'))
        self.assertEqual(items, [(Decimal('5.00'), True, '')])

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
        # UC-OWNER-012 A2, UC-OWNER-001 A3, UC-OWNER-003 A3, UC-OWNER-002 A5, UC-OWNER-013 A4, UC-OWNER-006 A6
        Cafe.objects.filter(pk=self.cafe.pk).update(is_active=False)
        self.assert_every_endpoint_answers(
            status.HTTP_403_FORBIDDEN, {'detail': 'Your subscription is inactive. Please contact support.'}
        )


@override_settings(FRONTEND_REVALIDATE_URL='http://frontend.test/internal/revalidate', STORAGES=IN_MEMORY_STORAGES)
class MenuRevalidationTests(CategoryAPITestCase):
    """Global Convention 9: each successful write asks Next.js to rebuild /menu/<slug>, after the commit."""

    def test_each_successful_write_sends_one_revalidation_after_the_commit(self):
        SubscriptionPlan.objects.filter(pk=self.cafe.plan_id).update(allows_images=True)  # for ITEM IMAGE
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
            'ITEM IMAGE': lambda: self.client.post(
                self.item_image_url(pie.pk), {'image': image_file()}, format='multipart'
            ),
            'ITEM PATCH': lambda: self.client.patch(self.item_url(pie.pk), {'price': '3.50'}, format='json'),
            # A new variant list alone also changes the public menu (Global Convention 10).
            'ITEM VARIANTS': lambda: self.client.patch(
                self.item_url(pie.pk), {'variants': [{'name': {'ar': 'Slice'}, 'price': '2.00'}]}, format='json'
            ),
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

    def create_category(self):
        """One successful write (UC-OWNER-001), with its on_commit callbacks run as after a commit."""
        with self.captureOnCommitCallbacks(execute=True):
            return self.client.post(self.list_url, {'name': {'ar': 'Food'}}, format='json')

    @override_settings(FRONTEND_REVALIDATE_SECRET='test-revalidate-secret')
    def test_the_call_carries_the_secret_and_a_short_timeout(self):  # system_design.md 3.5
        with mock.patch('urllib.request.urlopen') as urlopen:
            self.create_category()

        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_method(), 'POST')
        self.assertEqual(request.full_url, 'http://frontend.test/internal/revalidate')
        # urllib stores header names with only the first letter upper case.
        self.assertEqual(request.get_header('X-revalidate-secret'), 'test-revalidate-secret')
        self.assertEqual(request.get_header('Content-type'), 'application/json')
        self.assertEqual(urlopen.call_args.kwargs, {'timeout': 2})  # a slow frontend never holds the owner

    def test_a_failed_call_is_only_logged(self):  # system_design.md 3.5: it never fails the write
        refused = urllib.error.URLError('connection refused')
        with (
            mock.patch('urllib.request.urlopen', side_effect=refused),
            self.assertLogs('core.revalidation', level='ERROR') as log,
        ):
            response = self.create_category()  # would raise here if the error escaped

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertIn("Menu revalidation failed for slugs ['tartus-coffee']", log.output[0])

    @override_settings(FRONTEND_REVALIDATE_URL='')
    def test_an_empty_url_sends_nothing(self):  # not configured, e.g. local development
        with mock.patch('urllib.request.urlopen') as urlopen:
            response = self.create_category()

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        urlopen.assert_not_called()


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
        cls.soup = cls.item(cls.food, 'Soup', '7.00', tags=['vegan', 'gluten_free'])
        cls.tea = cls.item(
            cls.drinks, 'Tea', '5.00', image_url='https://media.example.test/tea.webp', is_featured=True
        )
        cls.item(cls.drinks, 'Coffee', '6.00', sort_order=200, is_available=False)  # sold out
        cls.item(cls.drinks, 'Juice', '4.00', sort_order=300, deleted_at=timezone.now())
        cls.item(hidden, 'Secret', '1.00')
        # Soup comes in two sizes, stored here in the opposite order of their ids.
        cls.bowl = cls.variant(cls.soup, 'Bowl', '9.00', sort_order=200)
        cls.cup = cls.variant(cls.soup, 'Cup', '7.00', sort_order=100)
        Cafe.objects.create(  # a second cafe; none of its data may appear
            owner=User.objects.create_user(email='other@cafe.com'), plan=cls.pro, slug='other-cafe',
            name={'ar': 'Other Cafe'}, is_active=True,
        )

    @classmethod
    def item(cls, category, name, price, **fields):
        return MenuItem.objects.create(
            cafe=category.cafe, category=category, name={'ar': name, 'en': ''}, price=Decimal(price), **fields
        )

    @classmethod
    def variant(cls, item, name, price, **fields):
        return MenuItemVariant.objects.create(
            item=item, cafe=item.cafe, name={'ar': name, 'en': ''}, price=Decimal(price), **fields
        )

    def item_data(self, item, **changes):
        data = {
            'id': item.pk, 'name': {'ar': item.name['ar'], 'en': ''}, 'description': {'ar': '', 'en': ''},
            # Tea has no thumbnail (uploaded before thumbnails existed): the full image stands in.
            'price': str(item.price), 'image_url': item.image_url, 'thumbnail_url': item.thumbnail_url or item.image_url,
            'is_available': True, 'is_featured': item.is_featured, 'is_new': False, 'tags': item.tags,
            'variants': [], 'sort_order': item.sort_order,
        }
        return {**data, **changes}

    def test_menu_shows_visible_categories_and_available_items(self):  # Main flow
        # Four queries for the whole menu (cafe with plan, categories, items, variants): no N+1 problem.
        with CaptureQueriesContext(connection) as queries:
            response = self.client.get(self.url)

        self.assertEqual(len(data_queries(queries)), 4)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        # Hidden or deleted categories, sold-out or deleted items and the other cafe are left out.
        self.assertEqual(response.data, {
            'cafe': {
                'name': {'ar': 'Tartus Coffee', 'en': ''}, 'primary_color': '#C0392B',
                'logo_url': 'https://media.example.test/logo.webp', 'is_active': True,
            },
            'categories': [
                {'id': self.food.pk, 'name': {'ar': 'Food', 'en': ''}, 'sort_order': 100,
                 'items': [self.item_data(self.soup, variants=[  # by sort_order, not by id
                     {'id': self.cup.pk, 'name': {'ar': 'Cup', 'en': ''}, 'price': '7.00'},
                     {'id': self.bowl.pk, 'name': {'ar': 'Bowl', 'en': ''}, 'price': '9.00'},
                 ])]},
                {'id': self.drinks.pk, 'name': {'ar': 'Drinks', 'en': ''}, 'sort_order': 200,
                 'items': [self.item_data(self.tea)]},
            ],
        })

    def test_plan_without_images_and_branding_hides_them(self):  # Global Convention 7
        Cafe.objects.filter(pk=self.cafe.pk).update(plan=self.basic)

        response = self.client.get(self.url)

        self.assertEqual((response.data['cafe']['primary_color'], response.data['cafe']['logo_url']), ('', ''))
        self.assertEqual(response.data['categories'][1]['items'],
                         [self.item_data(self.tea, image_url='', thumbnail_url='')])
        # Tags are not a plan feature: they stay visible on every plan (Global Convention 11).
        self.assertEqual(response.data['categories'][0]['items'][0]['tags'], ['vegan', 'gluten_free'])
        # Neither are variants (Global Convention 10).
        self.assertEqual(len(response.data['categories'][0]['items'][0]['variants']), 2)

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
