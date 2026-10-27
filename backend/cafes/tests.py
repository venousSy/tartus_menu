"""
API integration tests for the cafe settings endpoints (use_cases.md UC-OWNER-009, UC-OWNER-010
and UC-OWNER-014). Each test sends real HTTP requests through URL -> view -> service -> database.
"""

import json
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

from .models import Cafe, SubscriptionPlan

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
