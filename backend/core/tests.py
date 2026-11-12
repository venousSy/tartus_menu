"""
Tests for the project-wide pieces in core/: the JSON 404 handler (use_cases.md Global Convention 2), the
health check (system_design.md §3.7), error tracking, the JSON-only API in production, the daily
backup command (system_design.md §5, "Scheduled Jobs") and Row-Level Security (system_design.md §7.1).
"""

import gzip
import io
import os
import runpy
import shutil
import subprocess
import tempfile
import threading
import unittest
from datetime import date, datetime, timezone
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import sentry_sdk
from botocore.exceptions import ClientError
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DatabaseError, OperationalError, connection, transaction
from django.test import Client, SimpleTestCase, TestCase, override_settings
from rest_framework.settings import perform_import
from rest_framework.views import APIView

from analytics import services as analytics_services
from analytics.models import MenuViewCount
from cafes import services as cafe_services
from cafes.models import BillingEvent, Cafe, CafeTable, SubscriptionPlan
from core.error_tracking import init_error_tracking, scrub_event
from core.management.commands import backup_database
from core.tenancy import all_tenants, tenant
from core.test_runner import enforced, policies_enforced
from menu import services as menu_services
from menu.models import Category, MenuItem, MenuItemVariant

User = get_user_model()

BACKUP_SETTINGS = {
    'R2_BACKUP_BUCKET_NAME': 'tartus-backups',
    'R2_BACKUP_ACCESS_KEY_ID': 'test-key-id',
    'R2_BACKUP_SECRET_ACCESS_KEY': 'test-secret',
    'R2_BACKUP_ENDPOINT_URL': 'https://account.r2.example',
    'BACKUP_AGE_PUBLIC_KEY': 'age1testpublickey',
}
AGE_MARK = b'FAKE-AGE:'  # what the fake encrypt() puts before the bytes it "encrypts"
REAL_ENCRYPT = backup_database.encrypt  # kept before BackupDatabaseTests.setUp replaces it with the fake
FAKE_SQL = b'-- PostgreSQL database dump\nCREATE TABLE public.cafes (id bigint);\n'


class JsonNotFoundTests(SimpleTestCase):
    """handler404. The test runner sets DEBUG=False, as in production, so Django uses the handler."""

    def test_unmatched_urls_answer_the_api_404(self):
        urls = [
            '/api/v1/dashboard/categories/abc/',  # <int:pk> rejects "abc" before any view runs
            '/api/v1/admin/cafes/1/unknown/',
            '/api/v1/not-an-endpoint/',
        ]
        for url in urls:
            with self.subTest(url=url):
                response = self.client.get(url)

                self.assertEqual(response.status_code, 404)
                self.assertEqual(response['Content-Type'], 'application/json')
                self.assertEqual(response.json(), {'detail': 'Not found.'})


class HealthTests(TestCase):
    """GET /api/v1/health/ (system_design.md §3.7): what the uptime monitor and the Docker healthchecks read."""

    url = '/api/v1/health/'

    def test_healthy_answers_200_without_login(self):
        # A stale or broken token must not matter: the check uses no authentication at all.
        response = self.client.get(self.url, HTTP_AUTHORIZATION='Bearer not-a-token')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'status': 'ok'})

    def test_database_down_answers_503_with_its_code(self):
        with (
            mock.patch('core.views.connection.cursor', side_effect=OperationalError('connection refused')),
            self.assertLogs('django.request', level='ERROR'),  # Django logs every 5xx
        ):
            response = self.client.get(self.url)

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {'detail': 'Database unavailable.'})
        self.assertEqual(response['X-Error-Code'], 'db_unavailable')

    def test_only_get_is_allowed(self):
        self.assertEqual(self.client.post(self.url).status_code, 405)


def run_settings(debug, **extra_env):
    """settings.py run again for DJANGO_DEBUG=`debug` with valid production values; returns its names.

    settings.py reads the environment once, at import; the test runner only turns settings.DEBUG off later,
    so the imported settings follow the developer's .env. Running the file again shows any case.
    """
    env = {
        'DJANGO_DEBUG': 'True' if debug else 'False',
        'DJANGO_SECRET_KEY': 'test-secret-key',
        'DJANGO_ALLOWED_HOSTS': 'menu.example.test',
        'PUBLIC_MENU_BASE_URL': 'https://menu.example.test',
        'DJANGO_ADMIN_PATH': 'hidden-admin',
        'USE_S3': 'False',
        'SENTRY_DSN': '',
        **extra_env,
    }
    with mock.patch.dict(os.environ, env):  # load_dotenv never overrides variables that are already set
        return runpy.run_path(str(Path(settings.BASE_DIR) / 'core' / 'settings.py'))


def rest_framework_setting(debug):
    """REST_FRAMEWORK as settings.py builds it for DJANGO_DEBUG=`debug`."""
    return run_settings(debug)['REST_FRAMEWORK']


class _FakeTracker(BaseHTTPRequestHandler):
    """A stand-in for Sentry's ingest endpoint: keeps every envelope the SDK posts, unzipped."""

    envelopes = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        if self.headers.get('Content-Encoding') == 'gzip':
            body = gzip.decompress(body)
        type(self).envelopes.append(body)
        self.send_response(200)
        self.end_headers()

    def log_message(self, *args):  # keep the test output quiet
        pass


class ErrorTrackingTests(SimpleTestCase):
    """Sentry or GlitchTip (core/error_tracking.py, system_design.md §5): only with a DSN, never personal data."""

    def test_settings_start_the_sdk_only_when_a_dsn_is_set(self):
        with mock.patch('sentry_sdk.init') as init:
            run_settings(debug=False)
            init.assert_not_called()

            run_settings(debug=False, SENTRY_DSN='https://key@errors.example.test/1', SENTRY_RELEASE='abc123')

        init.assert_called_once_with(
            dsn='https://key@errors.example.test/1', release='abc123', environment='production',
            send_default_pii=False, include_local_variables=False, max_request_body_size='never',
            traces_sample_rate=0, before_send=scrub_event,
        )

    def test_scrub_event_removes_body_cookies_and_credentials(self):
        event = {'request': {
            'url': 'https://menu.example.test/api/v1/auth/login/', 'data': {'password': 'secret'},
            'cookies': {'access': 'jwt'},
            'headers': {'Authorization': 'Bearer jwt', 'Cookie': 'access=jwt', 'X-Revalidate-Secret': 's',
                        'X-Forwarded-For': '203.0.113.7', 'User-Agent': 'Mozilla/5.0'},
        }}

        self.assertEqual(scrub_event(event, {}), {'request': {
            'url': 'https://menu.example.test/api/v1/auth/login/', 'headers': {'User-Agent': 'Mozilla/5.0'},
        }})
        self.assertEqual(scrub_event({'message': 'no request'}, {}), {'message': 'no request'})

    def test_a_server_error_reaches_the_tracker_without_credentials(self):
        # The real SDK and transport against a local fake tracker: what would leave the server.
        _FakeTracker.envelopes = []
        server = ThreadingHTTPServer(('127.0.0.1', 0), _FakeTracker)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        init_error_tracking(f'http://publickey@127.0.0.1:{server.server_port}/1', release='test', environment='test')
        self.addCleanup(sentry_sdk.init)  # without a DSN: the SDK is off again for the other tests

        def failing_get(*args, **kwargs):
            # A local variable of the failing frame, like something an owner typed. Built at run time, so its
            # value is not in the source lines the SDK sends, and named so the SDK's own filter does not hide it.
            owner_input = '-'.join(['owner', 'typed', 'text'])
            raise RuntimeError(f'boom for the tracker ({len(owner_input)})')

        client = Client(raise_request_exception=False)
        with (
            mock.patch('core.views.HealthView.get', side_effect=failing_get),
            self.assertLogs('django.request', level='ERROR'),  # Django logs every 5xx too
        ):
            response = client.get('/api/v1/health/', HTTP_AUTHORIZATION='Bearer secret-token-value',
                                  HTTP_COOKIE='access=secret-cookie-value', HTTP_X_FORWARDED_FOR='203.0.113.7')
        sentry_sdk.flush(timeout=5)

        self.assertEqual(response.status_code, 500)
        sent = b''.join(_FakeTracker.envelopes)
        self.assertIn(b'boom for the tracker', sent)
        for secret in (b'secret-token-value', b'secret-cookie-value', b'203.0.113.7', b'owner-typed-text'):
            self.assertNotIn(secret, sent)


class JsonOnlyApiTests(SimpleTestCase):
    """Production answers JSON only: DRF's Browsable API is a development tool (DEBUG=True)."""

    JSON = ('rest_framework.renderers.JSONRenderer',)
    BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

    def test_renderers_follow_debug(self):
        self.assertEqual(rest_framework_setting(debug=False)['DEFAULT_RENDERER_CLASSES'], self.JSON)
        self.assertEqual(
            rest_framework_setting(debug=True)['DEFAULT_RENDERER_CLASSES'],
            self.JSON + ('rest_framework.renderers.BrowsableAPIRenderer',),
        )

    def get_with_production_renderers(self, accept):
        # DRF copies DEFAULT_RENDERER_CLASSES into APIView.renderer_classes when the class is defined,
        # so override_settings cannot change it afterwards: give APIView the production classes instead.
        names = rest_framework_setting(debug=False)['DEFAULT_RENDERER_CLASSES']
        renderers = perform_import(names, 'DEFAULT_RENDERER_CLASSES')
        with mock.patch.object(APIView, 'renderer_classes', renderers):
            return self.client.get('/api/v1/dashboard/settings/', HTTP_ACCEPT=accept)

    def test_a_browser_gets_json_not_the_browsable_api_page(self):
        response = self.get_with_production_renderers(self.BROWSER_ACCEPT)

        self.assertEqual(response.status_code, 401)  # no token
        self.assertEqual(response['Content-Type'], 'application/json')
        self.assertNotIn(b'<html', response.content)

    def test_html_only_is_not_acceptable(self):
        response = self.get_with_production_renderers('text/html')

        self.assertEqual(response.status_code, 406)
        self.assertEqual(response['Content-Type'], 'application/json')


class FakePgDump:
    """Stands in for subprocess.Popen(['pg_dump', ...]): prints `sql`, writes `error` to stderr, exits."""

    calls = []

    def __init__(self, sql=FAKE_SQL, error=b'', returncode=0):
        self.sql, self.error, self.exit_code = sql, error, returncode

    def __call__(self, command, stdout, stderr, env):
        FakePgDump.calls.append({'command': command, 'env': env})
        stderr.write(self.error)
        self.stdout = io.BytesIO(self.sql)
        self.returncode = self.exit_code
        return self

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@override_settings(**BACKUP_SETTINGS)
class BackupDatabaseTests(TestCase):
    """manage.py backup_database: pg_dump -> gzip -> age -> backups/YYYY-MM-DD.sql.gz.age in the private bucket."""

    def setUp(self):
        FakePgDump.calls = []
        self.uploaded = {}
        self.encrypted_for = []
        # The real age runs in test_a_real_age_round_trip. Here a fake marks the bytes, so the tests can
        # check that exactly the encrypted file is uploaded (and it would also hit the fake Popen).
        encrypt_patch = mock.patch(
            'core.management.commands.backup_database.encrypt',
            side_effect=lambda source, target, key: (self.encrypted_for.append(key),
                                                     target.write(AGE_MARK + source.read())),
        )
        encrypt_patch.start()
        self.addCleanup(encrypt_patch.stop)
        client_patch = mock.patch('core.management.commands.backup_database.boto3.client')
        self.client_factory = client_patch.start()
        self.addCleanup(client_patch.stop)
        self.s3 = self.client_factory.return_value
        # Keep a copy of the bytes, because the command deletes its temporary file afterwards.
        self.s3.upload_fileobj.side_effect = (
            lambda file, bucket, key, ExtraArgs: self.uploaded.update(
                bucket=bucket, key=key, body=file.read(), extra=ExtraArgs))

    def run_backup(self, pg_dump=None):
        out = io.StringIO()
        with mock.patch('core.management.commands.backup_database.subprocess.Popen', pg_dump or FakePgDump()):
            call_command('backup_database', stdout=out)
        return out.getvalue()

    def test_uploads_the_encrypted_gzipped_dump_under_todays_key(self):
        output = self.run_backup()

        key = f"backups/{datetime.now(timezone.utc):%Y-%m-%d}.sql.gz.age"
        self.assertEqual((self.uploaded['bucket'], self.uploaded['key']), ('tartus-backups', key))
        self.assertEqual(self.uploaded['extra'], {'ContentType': 'application/octet-stream'})
        self.assertEqual(self.encrypted_for, ['age1testpublickey'])
        self.assertTrue(self.uploaded['body'].startswith(AGE_MARK))  # never the plain gzip
        self.assertEqual(gzip.decompress(self.uploaded['body'].removeprefix(AGE_MARK)), FAKE_SQL)
        self.assertIn(f"Uploaded {key} ({len(self.uploaded['body'])} bytes).", output)
        # The client uses the backup bucket's own token and endpoint, never the images bucket's.
        self.client_factory.assert_called_once_with(
            's3', endpoint_url='https://account.r2.example', aws_access_key_id='test-key-id',
            aws_secret_access_key='test-secret', region_name='auto')

    def test_pg_dump_gets_the_password_only_in_its_environment(self):
        self.run_backup()

        [call] = FakePgDump.calls
        command = call['command']
        self.assertEqual(command[0], 'pg_dump')
        self.assertIn('--no-owner', command)
        self.assertIn('--no-privileges', command)
        password = call['env']['PGPASSWORD']
        self.assertTrue(password)
        self.assertNotIn(password, command)

    def test_missing_settings_stop_before_any_work(self):
        with self.settings(R2_BACKUP_BUCKET_NAME='', R2_BACKUP_SECRET_ACCESS_KEY=''):
            with self.assertRaisesMessage(
                    CommandError,
                    'Backup not configured, missing: R2_BACKUP_BUCKET_NAME, R2_BACKUP_SECRET_ACCESS_KEY.'):
                self.run_backup()

        self.assertEqual(FakePgDump.calls, [])
        self.s3.upload_fileobj.assert_not_called()

    def test_a_failed_pg_dump_is_reported_and_nothing_is_uploaded(self):
        failing = FakePgDump(sql=b'-- half a dump', error=b'pg_dump: error: connection refused\n', returncode=1)

        with self.assertRaisesMessage(CommandError, 'pg_dump failed (exit 1): pg_dump: error: connection refused'):
            self.run_backup(failing)

        self.s3.upload_fileobj.assert_not_called()

    def test_without_a_public_key_nothing_is_dumped_or_uploaded(self):  # never an unencrypted dump
        with self.settings(BACKUP_AGE_PUBLIC_KEY=''):
            with self.assertRaisesMessage(CommandError, 'Backup not configured, missing: BACKUP_AGE_PUBLIC_KEY.'):
                self.run_backup()

        self.assertEqual(FakePgDump.calls, [])
        self.s3.upload_fileobj.assert_not_called()

    def test_a_failed_encryption_is_reported_and_nothing_is_uploaded(self):
        failing = CommandError('age failed (exit 1): malformed recipient')
        with mock.patch('core.management.commands.backup_database.encrypt', side_effect=failing):
            with self.assertRaisesMessage(CommandError, 'age failed (exit 1): malformed recipient'):
                self.run_backup()

        self.s3.upload_fileobj.assert_not_called()

    @unittest.skipUnless(shutil.which('age') and shutil.which('age-keygen'), 'age is not installed here')
    def test_a_real_age_round_trip(self):
        # The real encrypt() with a throwaway key pair: only the private key gives the bytes back.
        with tempfile.TemporaryDirectory() as folder:
            identity = Path(folder) / 'key.txt'
            keygen = subprocess.run(['age-keygen', '-o', str(identity)], capture_output=True, text=True, check=True)
            public_key = keygen.stderr.split('Public key: ')[1].strip()
            with tempfile.TemporaryFile() as source, tempfile.TemporaryFile() as target:
                source.write(FAKE_SQL)
                source.seek(0)
                REAL_ENCRYPT(source, target, public_key)
                target.seek(0)
                encrypted = target.read()
            decrypted = subprocess.run(['age', '--decrypt', '-i', str(identity)], input=encrypted,
                                       capture_output=True, check=True).stdout

        self.assertNotIn(b'CREATE TABLE', encrypted)
        self.assertEqual(decrypted, FAKE_SQL)

    def test_a_failed_upload_is_reported(self):
        self.s3.upload_fileobj.side_effect = ClientError(
            {'Error': {'Code': 'NoSuchBucket', 'Message': 'The specified bucket does not exist'}}, 'PutObject')

        with self.assertRaisesMessage(CommandError, 'Upload of backups/'):
            self.run_backup()

    @unittest.skipUnless(shutil.which('pg_dump'), 'pg_dump is not installed here (it is in the Docker image)')
    def test_a_real_pg_dump_of_the_test_database(self):
        if policies_enforced():
            # pg_dump refuses a table whose policy would hide rows from it. In production the backup
            # runs as the owner role, a superuser (system_design.md §7.1); CI runs this test as one too.
            self.skipTest('pg_dump needs a role that the Row-Level Security policies do not bind')
        # Without the fake: the real pg_dump reads the test database (its tables come from the migrations).
        call_command('backup_database', stdout=io.StringIO())

        sql = gzip.decompress(self.uploaded['body'].removeprefix(AGE_MARK)).decode()
        self.assertIn('CREATE TABLE public.cafes', sql)
        self.assertNotIn('OWNER TO', sql)
        # A restore gets the policies back with the tables.
        self.assertIn('CREATE POLICY tenant_isolation ON public.menu_items', sql)


TENANT_TABLES = {'billing_events', 'cafe_tables', 'categories', 'menu_items', 'menu_item_variants', 'menu_view_counts'}


class RowLevelSecurityTests(TestCase):
    """
    system_design.md §7.1: PostgreSQL itself hides the rows of other cafes. These tests ask the
    database without any cafe filter, so only the policies and the scopes of core/tenancy.py decide.
    """

    @classmethod
    def setUpTestData(cls):
        # Written with the bypass that the test runner keeps on outside requests.
        plan = SubscriptionPlan.objects.create(name=SubscriptionPlan.Name.PRO, allows_detailed_analytics=True)
        cls.rows = {}  # cafe pk -> one row of each tenant table
        cls.cafes = []
        for slug in ('first-cafe', 'second-cafe'):
            owner = User.objects.create_user(email=f'{slug}@test.local', password='Str0ng-test-pass!')
            cafe = Cafe.objects.create(owner=owner, plan=plan, slug=slug, name={'ar': slug}, is_active=True,
                                       subscription_expires_on=date(2020, 1, 1))  # long overdue, for the nightly job
            category = Category.objects.create(cafe=cafe, name={'ar': 'Drinks'})
            item = MenuItem.objects.create(cafe=cafe, category=category, name={'ar': 'Tea'}, price=Decimal('5.00'))
            cls.rows[cafe.pk] = [
                BillingEvent.objects.create(cafe=cafe, action=BillingEvent.Action.ACTIVATED),
                CafeTable.objects.create(cafe=cafe, table_number=1),
                category,
                item,
                MenuItemVariant.objects.create(cafe=cafe, item=item, name={'ar': 'Large'}, price=Decimal('7.00')),
                MenuViewCount.objects.create(cafe=cafe, hour=datetime(2026, 1, 1, 10, tzinfo=timezone.utc), count=3),
            ]
            cls.cafes.append(cafe)
        cls.first, cls.second = cls.cafes
        cls.models = [type(row) for row in cls.rows[cls.first.pk]]

    def cafes_seen(self):
        """For each tenant table: the cafes whose rows an unfiltered query returns right now."""
        return [set(model._base_manager.values_list('cafe_id', flat=True)) for model in self.models]

    def test_every_table_with_a_cafe_id_has_a_forced_policy(self):
        # Also true for a superuser: it reads the catalog, not the rows. A new tenant table without
        # a policy in its migration fails here.
        with connection.cursor() as cursor:
            cursor.execute("""
                SELECT c.relname, c.relrowsecurity AND c.relforcerowsecurity, p.polname
                FROM pg_class c
                JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'cafe_id' AND NOT a.attisdropped
                LEFT JOIN pg_policy p ON p.polrelid = c.oid
                WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
            """)
            found = {table: (forced, policy) for table, forced, policy in cursor.fetchall()}

        self.assertEqual(found, {table: (True, 'tenant_isolation') for table in TENANT_TABLES})
        self.assertEqual({model._meta.db_table for model in self.models}, TENANT_TABLES)

    def test_outside_a_scope_no_row_exists(self):
        self.require_enforced_policies()
        with enforced():
            self.assertEqual(self.cafes_seen(), [set()] * 6)

    def test_a_tenant_scope_shows_only_that_cafe_and_ends_with_its_block(self):
        self.require_enforced_policies()
        with enforced():
            with tenant(self.first):
                self.assertEqual(self.cafes_seen(), [{self.first.pk}] * 6)
            self.assertEqual(self.cafes_seen(), [set()] * 6)
            with tenant(self.second):
                self.assertEqual(self.cafes_seen(), [{self.second.pk}] * 6)

    def test_the_all_tenants_scope_shows_every_cafe(self):
        self.require_enforced_policies()
        with enforced(), all_tenants():
            self.assertEqual(self.cafes_seen(), [{self.first.pk, self.second.pk}] * 6)

    def test_an_inner_scope_gives_the_outer_one_back_also_after_an_error(self):
        self.require_enforced_policies()
        with enforced(), tenant(self.first):
            with all_tenants():
                self.assertEqual(len(self.cafes_seen()[0]), 2)
            self.assertEqual(self.cafes_seen(), [{self.first.pk}] * 6)

            with self.assertRaises(ZeroDivisionError), tenant(self.second):
                1 / 0
            self.assertEqual(self.cafes_seen(), [{self.first.pk}] * 6)

    def test_a_row_for_another_cafe_cannot_be_inserted(self):
        self.require_enforced_policies()
        with enforced(), tenant(self.first):
            # atomic(): the refused INSERT breaks only this savepoint, not the test's transaction.
            with self.assertRaisesMessage(DatabaseError, 'row-level security policy'), transaction.atomic():
                CafeTable.objects.create(cafe=self.second, table_number=2)
            CafeTable.objects.create(cafe=self.first, table_number=2)  # its own cafe: accepted

    def test_rows_of_another_cafe_cannot_be_changed_or_deleted(self):
        self.require_enforced_policies()
        foreign = self.rows[self.second.pk]
        with enforced(), tenant(self.first):
            for row in foreign:
                with self.subTest(table=row._meta.db_table):
                    rows = type(row)._base_manager.filter(pk=row.pk)
                    self.assertEqual(rows.update(cafe_id=self.first.pk), 0)  # not found, so not moved
                    self.assertEqual(rows.delete()[0], 0)
            # A row of its own cafe cannot be handed to another cafe either.
            with self.assertRaisesMessage(DatabaseError, 'row-level security policy'), transaction.atomic():
                Category.objects.filter(cafe=self.first).update(cafe_id=self.second.pk)
        for row in foreign:
            row.refresh_from_db()  # still there, unchanged (read with the bypass)
            self.assertEqual(row.cafe_id, self.second.pk)

    def test_services_called_outside_a_request_open_their_own_scope(self):
        # The nightly commands, the QR link lookup and the menu open counter are called here as the
        # scheduler and the public views call them: with no scope around them.
        self.require_enforced_policies()
        token = CafeTable.objects.get(cafe=self.second).qr_token
        with enforced():
            self.assertEqual(cafe_services.resolve_qr_token(token), {'slug': 'second-cafe', 'table_number': 1})
            analytics_services.record_view('second-cafe', table=1)
            _, categories = menu_services.get_public_menu('first-cafe')
            self.assertEqual([category.cafe_id for category in categories], [self.first.pk])
            self.assertEqual(sorted(cafe_services.expire_due_subscriptions()), ['first-cafe', 'second-cafe'])
            self.assertEqual(analytics_services.prune_old_views(today=date(2030, 1, 1)), 3)

        self.assertEqual(BillingEvent.objects.filter(action=BillingEvent.Action.EXPIRED).count(), 2)
        self.assertFalse(MenuViewCount.objects.exists())

    def require_enforced_policies(self):
        if not policies_enforced():
            self.skipTest('the tests run as a superuser: PostgreSQL does not apply the policies to it')


class CreateAppRoleTests(TestCase):
    """manage.py create_app_role (system_design.md §7.1, "Database roles"). It needs a role that may create roles."""

    ROLE = 'tartus_app_probe'
    ENVIRONMENT = {'DB_APP_USER': ROLE, 'DB_APP_PASSWORD': "it's-only-a-test"}  # the quote must not break the SQL

    def one(self, query, *params):
        with connection.cursor() as cursor:
            cursor.execute(query, params)
            return cursor.fetchone()

    def test_the_app_role_may_only_read_and_write_rows_and_the_policies_bind_it(self):
        if not self.one('SELECT rolsuper OR rolcreaterole FROM pg_roles WHERE rolname = current_user')[0]:
            self.skipTest('the tests run as a role that may not create roles')
        plan = SubscriptionPlan.objects.create(name=SubscriptionPlan.Name.BASIC)
        owner = User.objects.create_user(email='owner@test.local', password='Str0ng-test-pass!')
        cafe = Cafe.objects.create(owner=owner, plan=plan, slug='probe-cafe', name={'ar': 'Probe'})
        Category.objects.create(cafe=cafe, name={'ar': 'Drinks'})

        with mock.patch.dict(os.environ, self.ENVIRONMENT):
            call_command('create_app_role', stdout=io.StringIO())
            call_command('create_app_role', stdout=io.StringIO())  # again: it updates, it does not fail

        # CREATE ROLE is part of the test's transaction, so the role is gone again after the test.
        self.assertEqual(
            self.one('SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles '
                     'WHERE rolname = %s', self.ROLE),
            (True, False, False, False, False),
        )
        rights = {right: self.one('SELECT has_table_privilege(%s, %s, %s)', self.ROLE, 'categories', right)[0]
                  for right in ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')}
        self.assertEqual(rights, {'SELECT': True, 'INSERT': True, 'UPDATE': True, 'DELETE': True, 'TRUNCATE': False})
        self.assertTrue(self.one('SELECT has_sequence_privilege(%s, %s, %s)', self.ROLE, 'categories_id_seq', 'USAGE')[0])
        self.assertNotEqual(self.one("SELECT tableowner FROM pg_tables WHERE tablename = 'categories'")[0], self.ROLE)

        # As that role, PostgreSQL applies the policy: no row without a tenant, the cafe's rows with it.
        with connection.cursor() as cursor:
            cursor.execute(f'SET LOCAL ROLE {self.ROLE}')
            try:
                with enforced():
                    self.assertEqual(Category.objects.count(), 0)
                    with tenant(cafe):
                        self.assertEqual(Category.objects.count(), 1)
            finally:
                cursor.execute('RESET ROLE')

    def test_it_refuses_to_run_without_a_name_and_a_password_or_for_its_own_role(self):
        with mock.patch.dict(os.environ, {'DB_APP_USER': '', 'DB_APP_PASSWORD': ''}):
            with self.assertRaisesMessage(CommandError, 'Set DB_APP_USER and DB_APP_PASSWORD'):
                call_command('create_app_role')
        own = {'DB_APP_USER': connection.settings_dict['USER'], 'DB_APP_PASSWORD': 'x'}
        with mock.patch.dict(os.environ, own), self.assertRaisesMessage(CommandError, 'must not be the role'):
            call_command('create_app_role')
