"""
API integration tests for the cafe settings endpoints (use_cases.md UC-OWNER-009, UC-OWNER-010
and UC-OWNER-014), the QR code endpoints (UC-OWNER-007, UC-OWNER-008 and UC-OWNER-011)
and the Super Admin endpoints (UC-ADMIN-001 to UC-ADMIN-009).
Each test sends real HTTP requests through URL -> view -> service -> database.
"""

import base64
import json
import re
import zlib
from io import BytesIO
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.files.storage import default_storage
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.urls import reverse
from PIL import Image
from rest_framework import status
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import AccessToken

from .models import BillingEvent, Cafe, CafeTable, SubscriptionPlan

User = get_user_model()

INACTIVE = {'detail': 'Your subscription is inactive. Please contact support.'}

# Uploads are kept in memory during tests: nothing reaches R2 or backend/media/.
IN_MEMORY_STORAGES = {
    'default': {'BACKEND': 'django.core.files.storage.InMemoryStorage'},
    'staticfiles': {'BACKEND': 'django.contrib.staticfiles.storage.StaticFilesStorage'},
}


def image_file(fmt='PNG', size=(1024, 512), mode='RGBA', name='logo.png'):
    """An uploaded image built in memory with Pillow. The default is fully transparent."""
    buffer = BytesIO()
    Image.new(mode, size).save(buffer, format=fmt)
    return SimpleUploadedFile(name, buffer.getvalue())


class CafeAPITestCase(APITestCase):
    """Shared data: an owner with an active cafe on Basic, which stored a color while on Pro."""

    @classmethod
    def setUpTestData(cls):
        cls.basic = SubscriptionPlan.objects.create(name=SubscriptionPlan.Name.BASIC, max_categories=5, max_items=50)
        cls.pro = SubscriptionPlan.objects.create(
            name=SubscriptionPlan.Name.PRO, allows_images=True, allows_branding=True
        )
        cls.owner = User.objects.create_user(email='owner@cafe.com')  # no password: the tests use a token
        # The color was stored on Pro; the cafe is on Basic now, which hides it from customers.
        cls.cafe = Cafe.objects.create(
            owner=cls.owner, plan=cls.basic, slug='tartus-coffee', name={'ar': 'Tartus Coffee', 'en': ''},
            primary_color='#C0392B', is_active=True,
        )

    def setUp(self):
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {AccessToken.for_user(self.owner)}')

    def settings_data(self, **changes):
        """The settings as the API returns them for the Basic cafe, with `changes` applied."""
        data = {
            'name': {'ar': 'Tartus Coffee', 'en': ''}, 'slug': 'tartus-coffee', 'primary_color': '#C0392B',
            'logo_url': '', 'is_active': True,
            'plan': {'name': 'basic', 'max_categories': 5, 'max_items': 50, 'allows_images': False,
                     'allows_branding': False},
        }
        return {**data, **changes}

    def use_pro_plan(self):
        Cafe.objects.filter(pk=self.cafe.pk).update(plan=self.pro)


class CafeSettingsTests(CafeAPITestCase):
    """GET (UC-OWNER-014) and PATCH (UC-OWNER-009) /api/v1/dashboard/settings/"""

    url = reverse('cafes:settings')

    def test_get_returns_the_profile_and_the_plan(self):  # UC-OWNER-014 main flow
        response = self.client.get(self.url)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        # The stored color is returned although Basic hides it (Global Convention 7); the flags say why.
        self.assertEqual(response.data, self.settings_data())

    def test_get_answers_200_for_an_inactive_cafe(self):  # UC-OWNER-014 A1
        Cafe.objects.filter(pk=self.cafe.pk).update(is_active=False)

        response = self.client.get(self.url)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['is_active'], False)

    def test_patch_name_returns_the_updated_settings(self):  # UC-OWNER-009 main flow
        response = self.client.patch(self.url, {'name': {'ar': 'Sea View', 'en': 'Sea View'}}, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data, self.settings_data(name={'ar': 'Sea View', 'en': 'Sea View'}))

    def test_pro_plan_can_change_and_clear_the_color(self):
        self.use_pro_plan()
        for color in ['#00ff00', '']:  # "" goes back to the default theme
            with self.subTest(color=color):
                response = self.client.patch(self.url, {'primary_color': color}, format='json')

                self.assertEqual(response.status_code, status.HTTP_200_OK)
                self.assertEqual(response.data['primary_color'], color)

    def test_basic_plan_cannot_change_the_color(self):  # A2
        body = {'name': {'ar': 'Sea View'}, 'primary_color': '#00FF00'}

        response = self.client.patch(self.url, body, format='json')

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response.data, {'detail': 'Custom colors require a Pro plan.'})
        self.cafe.refresh_from_db()
        self.assertEqual((self.cafe.name['ar'], self.cafe.primary_color), ('Tartus Coffee', '#C0392B'))

    def test_slug_in_the_body_returns_403_and_changes_nothing(self):  # A1
        body = {'name': {'ar': 'Sea View'}, 'slug': 'sea-view'}

        response = self.client.patch(self.url, body, format='json')

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response.data, {'detail': 'Only a Super Admin can change the cafe slug.'})
        self.cafe.refresh_from_db()
        self.assertEqual((self.cafe.slug, self.cafe.name['ar']), ('tartus-coffee', 'Tartus Coffee'))

    def test_invalid_fields_return_400(self):  # A3, A4
        self.use_pro_plan()
        cases = [
            ({'primary_color': 'red'}, {'primary_color': ['Enter a color in #RRGGBB format.']}),  # A3
            ({'primary_color': '#12345'}, {'primary_color': ['Enter a color in #RRGGBB format.']}),
            ({'name': {'en': 'Sea View'}}, {'name': {'ar': ['This field is required.']}}),  # A4
        ]
        for body, errors in cases:
            with self.subTest(body=body):
                response = self.client.patch(self.url, body, format='json')

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertEqual(response.data, errors)

    def test_access_rules(self):  # Global Conventions 2 and 5, UC-OWNER-009 A5
        admin = User.objects.create_user(email='admin@platform.com', role=User.Role.SYSTEM_ADMIN)
        no_role = {'detail': 'You do not have permission to perform this action.'}
        no_token = {'detail': 'Authentication credentials were not provided.'}
        cases = [
            ('no token', None, 'GET', 401, no_token),
            ('no token', None, 'PATCH', 401, no_token),
            ('system admin', admin, 'GET', 403, no_role),
            ('system admin', admin, 'PATCH', 403, no_role),
        ]
        for label, user, method, status_code, body in cases:
            with self.subTest(caller=label, method=method):
                if user is None:
                    self.client.credentials()
                else:
                    self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {AccessToken.for_user(user)}')
                send = self.client.get if method == 'GET' else self.client.patch
                response = send(self.url, {}, format='json')

                self.assertEqual(response.status_code, status_code)
                self.assertEqual(response.data, body)

        # The owner of an inactive cafe may read the settings (tested above) but not change them (A5).
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {AccessToken.for_user(self.owner)}')
        Cafe.objects.filter(pk=self.cafe.pk).update(is_active=False)
        response = self.client.patch(self.url, {'name': {'ar': 'Sea View'}}, format='json')
        self.assertEqual((response.status_code, response.data), (status.HTTP_403_FORBIDDEN, INACTIVE))

    @override_settings(FRONTEND_REVALIDATE_URL='http://frontend.test/internal/revalidate')
    def test_patch_revalidates_the_public_menu_after_the_commit(self):  # Global Convention 9
        with mock.patch('urllib.request.urlopen') as urlopen:
            with self.captureOnCommitCallbacks(execute=True):
                self.client.patch(self.url, {'name': {'ar': 'Sea View'}}, format='json')
                urlopen.assert_not_called()  # nothing is sent before the commit

        urlopen.assert_called_once()
        self.assertEqual(json.loads(urlopen.call_args.args[0].data), {'slugs': ['tartus-coffee']})


@override_settings(STORAGES=IN_MEMORY_STORAGES, FRONTEND_REVALIDATE_URL='')
class CafeLogoTests(CafeAPITestCase):
    """UC-OWNER-010 - POST /api/v1/dashboard/settings/logo/ (multipart/form-data)"""

    upload_url = reverse('cafes:settings-logo')

    def upload(self, file):
        return self.client.post(self.upload_url, {'image': file}, format='multipart')

    @staticmethod
    def stored_key(url):
        return url.removeprefix(default_storage.url(''))  # "/media/" in tests, the R2 domain in production

    def test_upload_returns_200_with_the_processed_logo(self):  # Main flow
        self.use_pro_plan()

        response = self.upload(image_file())

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        url = response.data['logo_url']
        self.assertRegex(url, rf'^/media/cafes/{self.cafe.pk}/logo/[0-9a-f-]{{36}}\.webp$')  # random key
        self.assertEqual(response.data['plan']['name'], 'pro')  # the full settings answer (UC-OWNER-014 shape)
        self.cafe.refresh_from_db()
        self.assertEqual(self.cafe.logo_url, url)
        with default_storage.open(self.stored_key(url)) as stored, Image.open(stored) as image:
            self.assertEqual((image.format, image.size), ('WEBP', (512, 256)))  # longest side 512 px
            self.assertEqual(image.mode, 'RGBA')
            self.assertEqual(image.getpixel((10, 10))[3], 0)  # transparency kept

    def test_new_upload_deletes_the_old_logo_after_the_commit(self):  # Postconditions, step 6
        self.use_pro_plan()
        with self.captureOnCommitCallbacks(execute=True):
            old_url = self.upload(image_file()).data['logo_url']

        with self.captureOnCommitCallbacks() as callbacks:
            new_url = self.upload(image_file()).data['logo_url']

        self.assertTrue(default_storage.exists(self.stored_key(old_url)))  # kept until the commit
        for callback in callbacks:  # what Django runs once the request's transaction commits
            callback()
        self.assertFalse(default_storage.exists(self.stored_key(old_url)))
        self.assertTrue(default_storage.exists(self.stored_key(new_url)))

    def test_basic_plan_returns_403(self):  # A1
        response = self.upload(image_file())

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response.data, {'detail': 'Custom logos require a Pro plan.'})
        self.cafe.refresh_from_db()
        self.assertEqual(self.cafe.logo_url, '')

    def test_invalid_files_return_400(self):  # A2, A3
        self.use_pro_plan()
        not_allowed = {'detail': 'Only JPEG, PNG, and WebP images are allowed.'}
        cases = [
            ('a GIF', image_file('GIF', mode='RGB', name='a.gif'), not_allowed),  # A2
            ('text named .png', SimpleUploadedFile('a.png', b'not an image'), not_allowed),  # A2: content decides
            ('over 2 MB', SimpleUploadedFile('big.png', b'\xff' * (2 * 1024 * 1024 + 1)),
             {'detail': 'Image must be under 2MB.'}),  # A2
            ('over 25 megapixels', image_file(size=(6000, 5000), mode='1'),
             {'detail': 'Image dimensions are too large.'}),  # A3
            ('no file', None, {'image': ['No file was submitted.']}),
        ]
        for label, file, expected in cases:
            with self.subTest(label):
                body = {} if file is None else {'image': file}
                response = self.client.post(self.upload_url, body, format='multipart')

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertEqual(response.data, expected)
        self.cafe.refresh_from_db()
        self.assertEqual(self.cafe.logo_url, '')

    def test_storage_failure_returns_502(self):  # A4
        self.use_pro_plan()
        with (
            mock.patch.object(default_storage, 'save', side_effect=OSError('R2 is down')),
            self.assertLogs('core.media_storage', level='ERROR'),  # logged server-side
        ):
            response = self.upload(image_file())

        self.assertEqual(response.status_code, status.HTTP_502_BAD_GATEWAY)
        self.assertEqual(response.data, {'detail': 'Image upload failed. Please try again.'})
        self.cafe.refresh_from_db()
        self.assertEqual(self.cafe.logo_url, '')

    def test_access_rules(self):  # Global Conventions 2 and 5, A5
        self.use_pro_plan()
        admin = User.objects.create_user(email='admin@platform.com', role=User.Role.SYSTEM_ADMIN)
        cases = [
            ('no token', None, 401, {'detail': 'Authentication credentials were not provided.'}),
            ('system admin', admin, 403, {'detail': 'You do not have permission to perform this action.'}),
        ]
        for label, user, status_code, body in cases:
            with self.subTest(caller=label):
                if user is None:
                    self.client.credentials()
                else:
                    self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {AccessToken.for_user(user)}')

                response = self.upload(image_file())

                self.assertEqual((response.status_code, response.data), (status_code, body))

        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {AccessToken.for_user(self.owner)}')
        Cafe.objects.filter(pk=self.cafe.pk).update(is_active=False)
        response = self.upload(image_file())
        self.assertEqual((response.status_code, response.data), (status.HTTP_403_FORBIDDEN, INACTIVE))  # A5
        self.cafe.refresh_from_db()
        self.assertEqual(self.cafe.logo_url, '')

    @override_settings(FRONTEND_REVALIDATE_URL='http://frontend.test/internal/revalidate')
    def test_upload_revalidates_the_public_menu_after_the_commit(self):  # Global Convention 9
        self.use_pro_plan()
        with mock.patch('urllib.request.urlopen') as urlopen:
            with self.captureOnCommitCallbacks(execute=True):
                self.upload(image_file())
                urlopen.assert_not_called()  # nothing is sent before the commit

        urlopen.assert_called_once()
        self.assertEqual(json.loads(urlopen.call_args.args[0].data), {'slugs': ['tartus-coffee']})


def pdf_page_texts(content):
    """The strings drawn on each PDF page. reportlab stores each page's drawing commands zlib + ASCII85 encoded."""
    pages = re.findall(rb'\nstream\r?\n(.*?)~>endstream', content, re.DOTALL)
    commands = [zlib.decompress(base64.a85decode(page)) for page in pages]
    return [[text.decode() for text in re.findall(rb'\((.*?)\) Tj', page)] for page in commands]


@override_settings(PUBLIC_MENU_BASE_URL='https://menu.domain.com')
class QRCodeTests(CafeAPITestCase):
    """POST qr/generate/ (UC-OWNER-007), GET qr/preview/ (UC-OWNER-011), GET qr/download-pdf/ (UC-OWNER-008)"""

    generate_url = reverse('cafes:qr-generate')
    preview_url = reverse('cafes:qr-preview')
    pdf_url = reverse('cafes:qr-download-pdf')

    def generate(self, table_count):
        return self.client.post(self.generate_url, {'table_count': table_count}, format='json')

    def tokens(self, response):
        return {table['table_number']: table['qr_token'] for table in response.data['tables']}

    def test_generate_returns_the_active_tables_with_their_qr_codes(self):  # UC-OWNER-007 main flow
        response = self.generate(3)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['table_count'], 3)
        rows = CafeTable.objects.filter(cafe=self.cafe).order_by('table_number')
        expected = [(row.pk, row.table_number, f'https://menu.domain.com/menu/tartus-coffee?table={row.table_number}',
                     str(row.qr_token)) for row in rows]
        self.assertEqual([(t['id'], t['table_number'], t['url'], t['qr_token']) for t in response.data['tables']],
                         expected)
        for table in response.data['tables']:
            prefix, png = table['qr_image_url'].split(',')
            self.assertEqual(prefix, 'data:image/png;base64')
            self.assertEqual(Image.open(BytesIO(base64.b64decode(png))).format, 'PNG')

    def test_same_count_again_changes_nothing(self):  # A3
        first = self.generate(3)
        second = self.generate(3)

        self.assertEqual(second.data, first.data)
        self.assertEqual(CafeTable.objects.filter(cafe=self.cafe).count(), 3)

    def test_smaller_count_deactivates_and_keeps_the_tokens(self):  # A4, step 2 (b) and (c)
        tokens = self.tokens(self.generate(3))

        smaller = self.generate(1)
        self.assertEqual((smaller.data['table_count'], self.tokens(smaller)), (1, {1: tokens[1]}))
        self.assertEqual(CafeTable.objects.filter(cafe=self.cafe, is_active=False).count(), 2)  # not deleted
        self.assertEqual(pdf_page_texts(b''.join(self.client.get(self.pdf_url).streaming_content)),
                         [['1', 'https://menu.domain.com/menu/tartus-coffee?table=1']])  # gone from the PDF

        self.assertEqual(self.tokens(self.generate(3)), tokens)  # switched on again with the same tokens

    def test_invalid_table_count_returns_400(self):  # A1, A2
        too_small = ['Ensure this value is greater than or equal to 1.']
        not_integer = ['A valid integer is required.']
        cases = [
            ('missing', {}, ['This field is required.']),
            ('text', {'table_count': 'abc'}, not_integer),
            ('decimal', {'table_count': 12.5}, not_integer),
            ('zero', {'table_count': 0}, too_small),
            ('negative', {'table_count': -1}, too_small),
            ('over 200', {'table_count': 201}, ['Ensure this value is less than or equal to 200.']),  # A2
        ]
        for label, body, errors in cases:
            with self.subTest(label):
                response = self.client.post(self.generate_url, body, format='json')

                self.assertEqual((response.status_code, response.data),
                                 (status.HTTP_400_BAD_REQUEST, {'table_count': errors}))
        self.assertFalse(CafeTable.objects.exists())

    def test_preview_returns_the_generate_answer_and_changes_nothing(self):  # UC-OWNER-011 main flow
        generated = self.generate(2)
        before = list(CafeTable.objects.values_list('pk', 'is_active', 'updated_at'))

        response = self.client.get(self.preview_url)

        self.assertEqual((response.status_code, response.data), (status.HTTP_200_OK, generated.data))
        self.assertEqual(list(CafeTable.objects.values_list('pk', 'is_active', 'updated_at')), before)

    def test_urls_follow_the_current_slug(self):  # UC-OWNER-008 note: built on every request
        self.generate(1)
        Cafe.objects.filter(pk=self.cafe.pk).update(slug='sea-view')  # a Super Admin changed it (UC-ADMIN-006)

        preview = self.client.get(self.preview_url)
        pdf = b''.join(self.client.get(self.pdf_url).streaming_content)

        url = 'https://menu.domain.com/menu/sea-view?table=1'
        self.assertEqual(preview.data['tables'][0]['url'], url)
        self.assertEqual(pdf_page_texts(pdf), [['1', url]])

    def test_no_active_tables(self):  # UC-OWNER-011 A1, UC-OWNER-008 A1
        preview = self.client.get(self.preview_url)
        pdf = self.client.get(self.pdf_url)

        self.assertEqual((preview.status_code, preview.data), (status.HTTP_200_OK, {'table_count': 0, 'tables': []}))
        self.assertEqual((pdf.status_code, pdf.data),
                         (status.HTTP_400_BAD_REQUEST, {'detail': 'Please generate QR codes first.'}))

    def test_pdf_has_one_page_per_active_table_in_order(self):  # UC-OWNER-008 main flow
        self.generate(3)

        response = self.client.get(self.pdf_url)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response['Content-Type'], 'application/pdf')
        self.assertEqual(response['Content-Disposition'], 'attachment; filename="qrcodes.pdf"')
        content = b''.join(response.streaming_content)
        self.assertTrue(content.startswith(b'%PDF-'))
        self.assertEqual(pdf_page_texts(content), [  # the table number and the URL under each code
            [str(n), f'https://menu.domain.com/menu/tartus-coffee?table={n}'] for n in (1, 2, 3)
        ])

    def test_tables_of_another_cafe_are_never_touched_or_shown(self):  # tenant isolation
        other = Cafe.objects.create(
            owner=User.objects.create_user(email='other@cafe.com'), plan=self.basic, slug='other', is_active=True
        )
        other_tables = [CafeTable.objects.create(cafe=other, table_number=n) for n in (1, 2, 3, 4)]

        self.assertEqual(self.client.get(self.preview_url).data, {'table_count': 0, 'tables': []})
        self.assertEqual(self.client.get(self.pdf_url).status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(self.generate(2).data['table_count'], 2)
        self.assertEqual(list(CafeTable.objects.filter(cafe=other, is_active=True).order_by('table_number')),
                         other_tables)

    def test_access_rules(self):  # Global Conventions 2 and 5, UC-OWNER-007 A5, 008 A2, 011 A2
        admin = User.objects.create_user(email='admin@platform.com', role=User.Role.SYSTEM_ADMIN)
        requests = [('generate', lambda: self.generate(2)), ('preview', lambda: self.client.get(self.preview_url)),
                    ('pdf', lambda: self.client.get(self.pdf_url))]
        callers = [
            ('no token', None, 401, {'detail': 'Authentication credentials were not provided.'}),
            ('system admin', admin, 403, {'detail': 'You do not have permission to perform this action.'}),
            ('inactive cafe', self.owner, 403, INACTIVE),
        ]
        Cafe.objects.filter(pk=self.cafe.pk).update(is_active=False)
        for label, user, status_code, body in callers:
            if user is None:
                self.client.credentials()
            else:
                self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {AccessToken.for_user(user)}')
            for name, send in requests:
                with self.subTest(caller=label, endpoint=name):
                    response = send()

                    self.assertEqual((response.status_code, response.data), (status_code, body))
        self.assertFalse(CafeTable.objects.exists())


class AdminAPITestCase(CafeAPITestCase):
    """The shared cafe data plus a Super Admin, who sends every request unless a test changes the token."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.admin = User.objects.create_user(email='admin@platform.com', role=User.Role.SYSTEM_ADMIN)

    def setUp(self):
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {AccessToken.for_user(self.admin)}')

    def url(self, name, cafe=None):
        """reverse() for the admin URLs; the cafe-level ones get the id of `cafe` (default: the shared cafe)."""
        if name in ('cafes', 'stats'):
            return reverse(f'admin_api:{name}')
        return reverse(f'admin_api:{name}', args=[(cafe or self.cafe).pk])

    def add_cafe(self, slug, plan=None, **fields):
        owner = User.objects.create_user(email=f'owner@{slug}.com')
        return Cafe.objects.create(owner=owner, plan=plan or self.basic, slug=slug, **fields)


class AdminCafeReadAndCreateTests(AdminAPITestCase):
    """POST (UC-ADMIN-001) and GET (UC-ADMIN-002) cafes/, GET cafes/{id}/ (UC-ADMIN-003), GET stats/ (UC-ADMIN-009)"""

    create_body = {
        'slug': 'sea-view', 'name': {'ar': 'Sea View'}, 'plan': 'pro',
        'owner': {'email': 'New.Owner@Sea.com', 'password': 'initial_pass'},
    }

    def test_create_returns_201_with_the_inactive_cafe_and_its_owner(self):  # UC-ADMIN-001 main flow
        response = self.client.post(self.url('cafes'), self.create_body, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        cafe = Cafe.objects.get(slug='sea-view')
        self.assertEqual(response.data, {
            'id': cafe.pk, 'name': {'ar': 'Sea View', 'en': ''}, 'slug': 'sea-view', 'plan': 'pro',
            'is_active': False, 'owner_email': 'new.owner@sea.com',  # stored lowercased
            'subscription_start_at': None, 'subscription_end_at': None, 'logo_url': '', 'primary_color': '',
        })
        owner = cafe.owner
        self.assertEqual((owner.role, owner.is_staff), (User.Role.CAFE_OWNER, False))
        self.assertTrue(owner.check_password('initial_pass'))  # stored as a hash
        self.assertFalse(BillingEvent.objects.filter(cafe=cafe).exists())  # no activation yet

    def test_create_with_invalid_input_returns_400_and_creates_nothing(self):  # A1, A2, A3, A5
        required = ['This field is required.']
        cases = [
            ('slug taken', {'slug': 'tartus-coffee'}, {'slug': ['A cafe with this slug already exists.']}),  # A1
            ('email taken', {'owner': {'email': 'OWNER@cafe.com', 'password': 'initial_pass'}},  # A2, any case
             {'owner': {'email': ['A user with this email already exists.']}}),
            ('unknown plan', {'plan': 'gold'}, {'plan': ['Object with name=gold does not exist.']}),  # A3
            ('name without ar', {'name': {'en': 'Sea View'}}, {'name': {'ar': required}}),  # A5
            ('weak password', {'owner': {'email': 'new@sea.com', 'password': '12345678'}},
             {'owner': {'password': ['This password is too common.', 'This password is entirely numeric.']}}),
            ('no owner', {'owner': None}, {'owner': ['This field may not be null.']}),
        ]
        for label, change, errors in cases:
            with self.subTest(label):
                response = self.client.post(self.url('cafes'), {**self.create_body, **change}, format='json')

                self.assertEqual((response.status_code, response.data), (status.HTTP_400_BAD_REQUEST, errors))
        self.assertEqual((Cafe.objects.count(), User.objects.count()), (1, 2))  # the shared cafe, owner and admin

    def test_list_is_paginated_newest_first(self):  # UC-ADMIN-002 main flow
        for n in range(21):
            self.add_cafe(f'cafe-{n}')

        first = self.client.get(self.url('cafes'))
        second = self.client.get(self.url('cafes'), {'page': 2})

        self.assertEqual((first.status_code, first.data['count'], len(first.data['results'])), (200, 22, 20))
        self.assertEqual(first.data['results'][0]['slug'], 'cafe-20')
        self.assertEqual([cafe['slug'] for cafe in second.data['results']], ['cafe-0', 'tartus-coffee'])
        self.assertEqual(second.data['results'][-1], {
            'id': self.cafe.pk, 'name': {'ar': 'Tartus Coffee', 'en': ''}, 'slug': 'tartus-coffee', 'plan': 'basic',
            'is_active': True, 'owner_email': 'owner@cafe.com',
        })

    def test_search_matches_slug_name_and_owner_email(self):  # UC-ADMIN-002 step 1
        self.add_cafe('sea-view', name={'ar': 'Sea View', 'en': 'Blue Lounge'})
        for search, slugs in [('TARTUS', ['tartus-coffee']), ('lounge', ['sea-view']),
                              ('owner@sea-view', ['sea-view']), ('nothing', [])]:
            with self.subTest(search=search):
                response = self.client.get(self.url('cafes'), {'search': search})

                self.assertEqual([cafe['slug'] for cafe in response.data['results']], slugs)

    def test_list_without_cafes(self):  # UC-ADMIN-002 A1
        Cafe.objects.all().delete()

        response = self.client.get(self.url('cafes'))

        self.assertEqual(response.data, {'count': 0, 'next': None, 'previous': None, 'results': []})

    def test_detail_returns_the_full_cafe(self):  # UC-ADMIN-003 main flow, A1
        response = self.client.get(self.url('cafe'))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data, {
            'id': self.cafe.pk, 'name': {'ar': 'Tartus Coffee', 'en': ''}, 'slug': 'tartus-coffee', 'plan': 'basic',
            'is_active': True, 'owner_email': 'owner@cafe.com', 'subscription_start_at': None,
            'subscription_end_at': None, 'logo_url': '', 'primary_color': '#C0392B',  # stored, hidden on Basic
        })
        missing = self.client.get(reverse('admin_api:cafe', args=[self.cafe.pk + 100]))
        self.assertEqual((missing.status_code, missing.data), (status.HTTP_404_NOT_FOUND, {'detail': 'Not found.'}))

    def test_stats_count_the_cafes(self):  # UC-ADMIN-009
        self.add_cafe('sea-view', plan=self.pro)  # inactive by default

        response = self.client.get(self.url('stats'))

        self.assertEqual(response.data, {'total_cafes': 2, 'active_cafes': 1, 'inactive_cafes': 1,
                                         'basic_plan_count': 1, 'pro_plan_count': 1})

    def test_only_a_system_admin_may_call_the_admin_api(self):  # Global Conventions 1 and 2
        staff_owner = User.objects.create_user(email='staff@cafe.com', is_staff=True)  # is_staff never decides
        no_role = {'detail': 'You do not have permission to perform this action.'}
        callers = [
            ('no token', None, 401, {'detail': 'Authentication credentials were not provided.'}),
            ('cafe owner', self.owner, 403, no_role),
            ('owner with is_staff', staff_owner, 403, no_role),
        ]
        endpoints = [('get', 'cafes'), ('post', 'cafes'), ('get', 'cafe'), ('patch', 'cafe'), ('delete', 'cafe'),
                     ('post', 'cafe-activate'), ('post', 'cafe-deactivate'), ('get', 'cafe-billing'), ('get', 'stats')]
        for label, user, status_code, body in callers:
            if user is None:
                self.client.credentials()
            else:
                self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {AccessToken.for_user(user)}')
            for method, name in endpoints:
                with self.subTest(caller=label, endpoint=f'{method} {name}'):
                    response = getattr(self.client, method)(self.url(name), {}, format='json')

                    self.assertEqual((response.status_code, response.data), (status_code, body))
        self.cafe.refresh_from_db()
        self.assertTrue(self.cafe.is_active)
        self.assertFalse(BillingEvent.objects.exists())
