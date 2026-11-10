"""
Tests for the project-wide pieces in core/: the JSON 404 handler (use_cases.md Global Convention 2), the
health check (system_design.md §3.7), error tracking, the JSON-only API in production, and the daily
backup command (system_design.md §5, "Scheduled Jobs").
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
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import sentry_sdk
from botocore.exceptions import ClientError
from django.conf import settings
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import OperationalError
from django.test import Client, SimpleTestCase, TestCase, override_settings
from rest_framework.settings import perform_import
from rest_framework.views import APIView

from core.error_tracking import init_error_tracking, scrub_event
from core.management.commands import backup_database

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
        # Without the fake: the real pg_dump reads the test database (its tables come from the migrations).
        call_command('backup_database', stdout=io.StringIO())

        sql = gzip.decompress(self.uploaded['body'].removeprefix(AGE_MARK)).decode()
        self.assertIn('CREATE TABLE public.cafes', sql)
        self.assertNotIn('OWNER TO', sql)
