"""
API integration tests for the auth endpoints (use_cases.md UC-AUTH-001 to UC-AUTH-005).
Each test sends real HTTP requests through URL -> view -> serializer -> database.
"""

from datetime import datetime, timedelta
from unittest import mock

from django.contrib.auth import get_user_model
from django.contrib.auth.tokens import default_token_generator
from django.core.cache import cache
from django.urls import reverse
from django.utils.http import urlsafe_base64_encode
from rest_framework import status
from rest_framework.test import APITestCase
from rest_framework.throttling import ScopedRateThrottle
from rest_framework_simplejwt.tokens import AccessToken, RefreshToken

from cafes.models import Cafe, SubscriptionPlan

User = get_user_model()

# Test-only credentials; they exist only in the temporary test database.
EMAIL = 'owner@cafe.com'
PASSWORD = 'Str0ng-test-pass!'


class LoginTests(APITestCase):
    """UC-AUTH-001 - POST /api/v1/auth/login/"""

    url = reverse('users:login')

    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_user(email=EMAIL, password=PASSWORD)

    def setUp(self):
        # The login throttle keeps its counters in the cache; start every test at zero.
        cache.clear()

    def test_valid_credentials_return_tokens_and_role(self):
        response = self.client.post(self.url, {'email': EMAIL, 'password': PASSWORD}, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(set(response.data), {'access', 'refresh', 'role'})
        self.assertEqual(response.data['role'], 'CAFE_OWNER')
        # The role is also a claim inside the access token.
        self.assertEqual(AccessToken(response.data['access'])['role'], 'CAFE_OWNER')

    def test_wrong_password_returns_401(self):  # A1
        response = self.client.post(self.url, {'email': EMAIL, 'password': 'wrong'}, format='json')

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(response.data['detail'], 'No active account found with the given credentials')

    def test_inactive_account_returns_401(self):  # A2
        self.user.is_active = False
        self.user.save(update_fields=['is_active'])

        response = self.client.post(self.url, {'email': EMAIL, 'password': PASSWORD}, format='json')

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_missing_fields_return_400_with_field_errors(self):  # A3
        response = self.client.post(self.url, {}, format='json')

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('email', response.data)
        self.assertIn('password', response.data)

    def test_attempt_over_the_limit_returns_429(self):  # A4
        # Read the limit from settings (default 5/min) so the test follows LOGIN_THROTTLE_RATE.
        limit, _ = ScopedRateThrottle().parse_rate(ScopedRateThrottle.THROTTLE_RATES['login'])
        # Successful attempts count too: use the correct password every time.
        for _ in range(limit):
            response = self.client.post(self.url, {'email': EMAIL, 'password': PASSWORD}, format='json')
            self.assertEqual(response.status_code, status.HTTP_200_OK)

        response = self.client.post(self.url, {'email': EMAIL, 'password': PASSWORD}, format='json')

        self.assertEqual(response.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
        self.assertTrue(response.data['detail'].startswith('Request was throttled. Expected available in'))

    def test_owner_of_inactive_cafe_can_log_in(self):  # Global Convention 5
        plan = SubscriptionPlan.objects.create(name=SubscriptionPlan.Name.BASIC)
        Cafe.objects.create(owner=self.user, plan=plan, slug='test-cafe', name={'ar': 'Test Cafe'}, is_active=False)

        response = self.client.post(self.url, {'email': EMAIL, 'password': PASSWORD}, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)


class RefreshTests(APITestCase):
    """UC-AUTH-002 - POST /api/v1/auth/refresh/"""

    url = reverse('users:refresh')

    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_user(email=EMAIL, password=PASSWORD)

    def setUp(self):
        cache.clear()

    def test_refresh_rotates_the_pair_and_blacklists_the_old_token(self):  # Main flow + A2
        login = self.client.post(reverse('users:login'), {'email': EMAIL, 'password': PASSWORD}, format='json')
        old_refresh = login.data['refresh']

        response = self.client.post(self.url, {'refresh': old_refresh}, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(set(response.data), {'access', 'refresh'})
        self.assertNotEqual(response.data['refresh'], old_refresh)

        # The old token was used once and rotated, so it is blacklisted now.
        reuse = self.client.post(self.url, {'refresh': old_refresh}, format='json')
        self.assertEqual(reuse.status_code, status.HTTP_401_UNAUTHORIZED)

        # The new refresh token works.
        again = self.client.post(self.url, {'refresh': response.data['refresh']}, format='json')
        self.assertEqual(again.status_code, status.HTTP_200_OK)

    def test_expired_refresh_token_returns_401(self):  # A1
        token = RefreshToken.for_user(self.user)
        token.set_exp(lifetime=timedelta(seconds=-1))  # expiry moved into the past

        response = self.client.post(self.url, {'refresh': str(token)}, format='json')

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_refresh_token_of_a_deleted_owner_returns_401(self):  # UC-ADMIN-007 deletes the owner account
        plan = SubscriptionPlan.objects.create(name=SubscriptionPlan.Name.BASIC)
        cafe = Cafe.objects.create(owner=self.user, plan=plan, slug='test-cafe', name={'ar': 'Test Cafe'})
        login = self.client.post(reverse('users:login'), {'email': EMAIL, 'password': PASSWORD}, format='json')
        admin = User.objects.create_user(email='admin@platform.com', role=User.Role.SYSTEM_ADMIN)
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {AccessToken.for_user(admin)}')
        deleted = self.client.delete(reverse('admin_api:cafe', args=[cafe.pk]))
        self.assertEqual(deleted.status_code, status.HTTP_204_NO_CONTENT)
        self.client.credentials()  # the refresh endpoint is public: no token

        response = self.client.post(self.url, {'refresh': login.data['refresh']}, format='json')

        # 401, not 500: the frontend must end the session and show the login page, not an outage.
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(response.data, {'detail': 'No active account found for the given token.'})


class LogoutTests(APITestCase):
    """UC-AUTH-003 - POST /api/v1/auth/logout/"""

    url = reverse('users:logout')

    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_user(email=EMAIL, password=PASSWORD)

    def setUp(self):
        # Same result as one login: a refresh token, and its access token in the Authorization header.
        self.refresh = RefreshToken.for_user(self.user)
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {self.refresh.access_token}')

    def test_logout_blacklists_the_refresh_token(self):  # Main flow
        response = self.client.post(self.url, {'refresh': str(self.refresh)}, format='json')

        self.assertEqual(response.status_code, status.HTTP_205_RESET_CONTENT)
        # Postcondition: the token can no longer be used to refresh.
        refresh = self.client.post(reverse('users:refresh'), {'refresh': str(self.refresh)}, format='json')
        self.assertEqual(refresh.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_already_blacklisted_token_returns_400(self):  # A1
        self.client.post(self.url, {'refresh': str(self.refresh)}, format='json')

        response = self.client.post(self.url, {'refresh': str(self.refresh)}, format='json')

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(response.data['detail'], 'Token is invalid or already blacklisted.')

    def test_missing_token_returns_400(self):  # A2
        response = self.client.post(self.url, {}, format='json')

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('refresh', response.data)

    def test_another_users_token_is_rejected_and_stays_valid(self):  # ownership rule in LogoutView
        other = User.objects.create_user(email='other@cafe.com', password=PASSWORD)
        other_refresh = RefreshToken.for_user(other)

        response = self.client.post(self.url, {'refresh': str(other_refresh)}, format='json')

        # Same answer as for an invalid token, so it reveals nothing about the other user.
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(response.data['detail'], 'Token is invalid or already blacklisted.')
        refresh = self.client.post(reverse('users:refresh'), {'refresh': str(other_refresh)}, format='json')
        self.assertEqual(refresh.status_code, status.HTTP_200_OK)

    def test_without_access_token_returns_401(self):
        self.client.credentials()  # remove the Authorization header

        response = self.client.post(self.url, {'refresh': str(self.refresh)}, format='json')

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)


class ChangePasswordTests(APITestCase):
    """UC-AUTH-004 - POST /api/v1/auth/change-password/"""

    url = reverse('users:change-password')
    new_password = 'An0ther-strong-pass!'

    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_user(email=EMAIL, password=PASSWORD)

    def setUp(self):
        cache.clear()  # the main flow logs in again at the end
        self.refresh = RefreshToken.for_user(self.user)
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {self.refresh.access_token}')

    def test_password_changes_and_every_refresh_token_is_blacklisted(self):  # Main flow
        second_device = RefreshToken.for_user(self.user)

        response = self.client.post(
            self.url, {'old_password': PASSWORD, 'new_password': self.new_password}, format='json'
        )

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(self.new_password))
        # Every outstanding refresh token is blacklisted, on every device.
        for token in (self.refresh, second_device):
            refresh = self.client.post(reverse('users:refresh'), {'refresh': str(token)}, format='json')
            self.assertEqual(refresh.status_code, status.HTTP_401_UNAUTHORIZED)
        # The user must log in again, with the new password.
        self.client.credentials()
        login = self.client.post(
            reverse('users:login'), {'email': EMAIL, 'password': self.new_password}, format='json'
        )
        self.assertEqual(login.status_code, status.HTTP_200_OK)

    def test_wrong_old_password_returns_400(self):  # A1
        response = self.client.post(
            self.url, {'old_password': 'wrong', 'new_password': self.new_password}, format='json'
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(response.data, {'old_password': ['Incorrect password.']})

    def test_weak_new_password_returns_400_and_keeps_the_old_one(self):  # A2
        response = self.client.post(
            self.url, {'old_password': PASSWORD, 'new_password': '12345678'}, format='json'
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('new_password', response.data)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(PASSWORD))

    def test_same_new_password_returns_400(self):  # A3
        response = self.client.post(
            self.url, {'old_password': PASSWORD, 'new_password': PASSWORD}, format='json'
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            response.data, {'new_password': ['The new password must be different from the old password.']}
        )

    def test_missing_fields_return_400_with_field_errors(self):  # A4
        response = self.client.post(self.url, {}, format='json')

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('old_password', response.data)
        self.assertIn('new_password', response.data)

    def test_without_access_token_returns_401(self):  # A5
        self.client.credentials()  # remove the Authorization header

        response = self.client.post(
            self.url, {'old_password': PASSWORD, 'new_password': self.new_password}, format='json'
        )

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)


class PasswordResetTests(APITestCase):
    """UC-AUTH-005 - POST /api/v1/auth/password-reset/confirm/, with links made by UC-ADMIN-010."""

    url = reverse('users:password-reset-confirm')
    new_password = 'An0ther-strong-pass!'
    INVALID = {'detail': 'This reset link is invalid or has expired.'}

    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_user(email=EMAIL, password=PASSWORD)
        plan = SubscriptionPlan.objects.create(name=SubscriptionPlan.Name.BASIC)
        # Inactive: auth endpoints never check the subscription (Global Convention 5).
        cls.cafe = Cafe.objects.create(owner=cls.user, plan=plan, slug='tartus-coffee', name={'ar': 'Tartus Coffee'})
        cls.admin = User.objects.create_user(email='admin@platform.com', role=User.Role.SYSTEM_ADMIN)

    def setUp(self):
        cache.clear()  # the throttle counters

    def link(self):
        """A fresh link from the admin endpoint, as the body the reset page sends: {uid, token}."""
        response = self.client.post(
            reverse('admin_api:cafe-password-reset-link', args=[self.cafe.pk]),
            HTTP_AUTHORIZATION=f'Bearer {AccessToken.for_user(self.admin)}',
        )
        uid, token = response.data['url'].split('#')[1].split('.')
        return {'uid': uid, 'token': token}

    def confirm(self, link, password=None):
        return self.client.post(self.url, {**link, 'new_password': password or self.new_password}, format='json')

    def assert_invalid(self, response):
        self.assertEqual((response.status_code, response.data), (status.HTTP_400_BAD_REQUEST, self.INVALID))
        self.assertEqual(response['X-Error-Code'], 'reset_link_invalid')
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(PASSWORD))  # unchanged

    def test_the_link_sets_the_password_and_ends_every_session(self):  # Main flow
        sessions = [RefreshToken.for_user(self.user), RefreshToken.for_user(self.user)]

        response = self.confirm(self.link())

        self.assertEqual((response.status_code, response.content), (status.HTTP_204_NO_CONTENT, b''))
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(self.new_password))
        for token in sessions:
            refresh = self.client.post(reverse('users:refresh'), {'refresh': str(token)}, format='json')
            self.assertEqual(refresh.status_code, status.HTTP_401_UNAUTHORIZED)
        login = self.client.post(reverse('users:login'), {'email': EMAIL, 'password': self.new_password}, format='json')
        self.assertEqual(login.status_code, status.HTTP_200_OK)  # not logged in by the reset itself

    def test_a_link_works_once_and_ends_the_links_made_before(self):  # A1, UC-ADMIN-010 A3
        first, second = self.link(), self.link()

        self.assertEqual(self.confirm(second).status_code, status.HTTP_204_NO_CONTENT)

        for link in (second, first):
            response = self.confirm(link, 'Yet-an0ther-pass!')
            self.assertEqual((response.status_code, response.data), (status.HTTP_400_BAD_REQUEST, self.INVALID))
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(self.new_password))

    def test_the_same_password_again_is_allowed_and_still_ends_the_link(self):  # step 4
        link = self.link()

        self.assertEqual(self.confirm(link, PASSWORD).status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(self.confirm(link, PASSWORD).status_code, status.HTTP_400_BAD_REQUEST)

    def test_a_password_change_ends_the_link(self):  # A1 after UC-AUTH-004
        link = self.link()
        self.client.post(
            reverse('users:change-password'), {'old_password': PASSWORD, 'new_password': 'Changed-pass-1!'},
            format='json', HTTP_AUTHORIZATION=f'Bearer {AccessToken.for_user(self.user)}',
        )

        response = self.confirm(link)

        self.assertEqual((response.status_code, response.data), (status.HTTP_400_BAD_REQUEST, self.INVALID))

    def test_a_link_expires_after_24_hours(self):  # A1
        link = self.link()
        with mock.patch('django.contrib.auth.tokens.PasswordResetTokenGenerator._now',
                        return_value=datetime.now() + timedelta(hours=23, minutes=59)):
            still_valid = default_token_generator.check_token(self.user, link['token'])
        with mock.patch('django.contrib.auth.tokens.PasswordResetTokenGenerator._now',
                        return_value=datetime.now() + timedelta(hours=24, minutes=1)):
            response = self.confirm(link)

        self.assertTrue(still_valid)
        self.assert_invalid(response)

    def test_every_invalid_link_gets_the_same_answer(self):  # A1
        link = self.link()
        other = User.objects.create_user(email='other@cafe.com', password=PASSWORD)
        cases = [
            ('wrong token', {**link, 'token': link['token'][:-1] + ('a' if link['token'][-1] != 'a' else 'b')}),
            ('token of another user', {**link, 'token': default_token_generator.make_token(other)}),
            ('unknown user', {**link, 'uid': urlsafe_base64_encode(b'999999')}),
            ('uid is not a number', {**link, 'uid': urlsafe_base64_encode(b'abc')}),
            ('uid is not base64', {**link, 'uid': '!!!'}),
            ('uid is too large', {**link, 'uid': urlsafe_base64_encode(b'9' * 30)}),
        ]
        for label, body in cases:
            with self.subTest(label):
                cache.clear()  # more cases than the throttle allows in a minute
                self.assert_invalid(self.confirm(body))

    def test_an_inactive_account_cannot_use_a_link(self):  # A1
        link = self.link()
        User.objects.filter(pk=self.user.pk).update(is_active=False)

        self.assert_invalid(self.confirm(link))

    def test_a_weak_password_returns_400_and_keeps_the_link(self):  # A2
        link = self.link()

        weak = self.confirm(link, '12345678')
        similar = self.confirm(link, EMAIL)

        self.assertEqual((weak.status_code, weak.data), (status.HTTP_400_BAD_REQUEST, {
            'new_password': ['This password is too common.', 'This password is entirely numeric.'],
        }))
        self.assertEqual(similar.data, {'new_password': ['The password is too similar to the email address.']})
        self.assertEqual(self.confirm(link).status_code, status.HTTP_204_NO_CONTENT)  # the link still works

    def test_the_link_is_checked_before_the_password(self):  # A1 wins over A2
        self.assert_invalid(self.confirm({'uid': 'MQ', 'token': 'wrong'}, '12345678'))

    def test_missing_fields_return_400_with_field_errors(self):  # A4
        response = self.client.post(self.url, {}, format='json')

        required = ['This field is required.']
        self.assertEqual((response.status_code, response.data),
                         (status.HTTP_400_BAD_REQUEST, {'uid': required, 'token': required, 'new_password': required}))

    def test_too_many_attempts_return_429(self):  # A3
        limit, _ = ScopedRateThrottle().parse_rate(ScopedRateThrottle.THROTTLE_RATES['password_reset'])
        for _attempt in range(limit):
            self.assertEqual(self.confirm({'uid': 'MQ', 'token': 'wrong'}).status_code, status.HTTP_400_BAD_REQUEST)

        response = self.confirm(self.link())  # even a valid link must wait

        self.assertEqual(response.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
        self.assertTrue(response.data['detail'].startswith('Request was throttled. Expected available in'))

    def test_a_stale_token_header_does_not_cause_a_401(self):
        response = self.client.post(self.url, {**self.link(), 'new_password': self.new_password}, format='json',
                                    HTTP_AUTHORIZATION='Bearer not-a-token')

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
