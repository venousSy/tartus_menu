"""
API integration tests for the auth endpoints (use_cases.md UC-AUTH-001 to UC-AUTH-004).
Each test sends real HTTP requests through URL -> view -> serializer -> database.
"""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.urls import reverse
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
