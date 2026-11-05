"""
Tests for the project-wide pieces in core/: the JSON 404 handler (use_cases.md Global Convention 2), the
JSON-only API in production, and the daily backup command (system_design.md §5, "Scheduled Jobs").
"""

import gzip
import io
import os
import runpy
import shutil
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from botocore.exceptions import ClientError
from django.conf import settings
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.settings import perform_import
from rest_framework.views import APIView

BACKUP_SETTINGS = {
    'R2_BACKUP_BUCKET_NAME': 'tartus-backups',
    'R2_BACKUP_ACCESS_KEY_ID': 'test-key-id',
    'R2_BACKUP_SECRET_ACCESS_KEY': 'test-secret',
    'R2_BACKUP_ENDPOINT_URL': 'https://account.r2.example',
}
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


def rest_framework_setting(debug):
    """REST_FRAMEWORK as settings.py builds it for DJANGO_DEBUG=`debug`, with valid production values.

    settings.py reads DJANGO_DEBUG once, at import; the test runner only turns settings.DEBUG off later,
    so the imported REST_FRAMEWORK follows the developer's .env. Running the file again shows both cases.
    """
    env = {
        'DJANGO_DEBUG': 'True' if debug else 'False',
        'DJANGO_SECRET_KEY': 'test-secret-key',
        'DJANGO_ALLOWED_HOSTS': 'menu.example.test',
        'PUBLIC_MENU_BASE_URL': 'https://menu.example.test',
        'DJANGO_ADMIN_PATH': 'hidden-admin',
        'USE_S3': 'False',
    }
    with mock.patch.dict(os.environ, env):  # load_dotenv never overrides variables that are already set
        return runpy.run_path(str(Path(settings.BASE_DIR) / 'core' / 'settings.py'))['REST_FRAMEWORK']


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
    """manage.py backup_database: pg_dump -> gzip -> backups/YYYY-MM-DD.sql.gz in the private bucket."""

    def setUp(self):
        FakePgDump.calls = []
        self.uploaded = {}
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

    def test_uploads_the_gzipped_dump_under_todays_key(self):
        output = self.run_backup()

        key = f"backups/{datetime.now(timezone.utc):%Y-%m-%d}.sql.gz"
        self.assertEqual((self.uploaded['bucket'], self.uploaded['key']), ('tartus-backups', key))
        self.assertEqual(self.uploaded['extra'], {'ContentType': 'application/gzip'})
        self.assertEqual(gzip.decompress(self.uploaded['body']), FAKE_SQL)
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

    def test_a_failed_upload_is_reported(self):
        self.s3.upload_fileobj.side_effect = ClientError(
            {'Error': {'Code': 'NoSuchBucket', 'Message': 'The specified bucket does not exist'}}, 'PutObject')

        with self.assertRaisesMessage(CommandError, 'Upload of backups/'):
            self.run_backup()

    @unittest.skipUnless(shutil.which('pg_dump'), 'pg_dump is not installed here (it is in the Docker image)')
    def test_a_real_pg_dump_of_the_test_database(self):
        # Without the fake: the real pg_dump reads the test database (its tables come from the migrations).
        call_command('backup_database', stdout=io.StringIO())

        sql = gzip.decompress(self.uploaded['body']).decode()
        self.assertIn('CREATE TABLE public.cafes', sql)
        self.assertNotIn('OWNER TO', sql)
