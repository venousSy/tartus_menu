"""
The test runner (settings.TEST_RUNNER): Django's own, plus the Row-Level Security setup of
system_design.md §7.1 ("Tests").

Tests write their fixtures straight through the ORM, outside any service, so outside any tenant
scope; with the policies on, PostgreSQL would refuse those rows. So the runner turns the bypass on
for the test connection, and turns it off for the time of every HTTP request a test sends. Inside a
request only the scopes that the services open (core/tenancy.py) decide which rows exist, exactly
as in production: a service without a scope reads nothing and fails its test.

The policies bind only a role that is not a superuser. CI runs the tests as such a role; with a
superuser (the usual local setup) everything here still runs, but PostgreSQL enforces nothing.
"""

from django.core.signals import request_finished, request_started
from django.db import DatabaseError, connection
from django.db.backends.signals import connection_created
from django.test.runner import DiscoverRunner
from django.test.testcases import DatabaseOperationForbidden


def _set(cafe_id, bypass):
    # Local to the transaction when there is one (every TestCase test runs in one), so a rollback
    # leaves nothing behind; for the session otherwise.
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT set_config('app.cafe_id', %s, %s), set_config('app.rls_bypass', %s, %s)",
                [cafe_id, connection.in_atomic_block, bypass, connection.in_atomic_block],
            )
    except (DatabaseOperationForbidden, DatabaseError):
        # A SimpleTestCase may not use the database, and a test of an outage has none:
        # in both there are no rows to protect.
        pass


def _bypass_for_fixtures(sender, connection, **kwargs):
    with connection.cursor() as cursor:
        cursor.execute("SELECT set_config('app.rls_bypass', 'on', false)")


def _enforce_in_request(sender, **kwargs):
    _set('', 'off')


def _bypass_after_request(sender, **kwargs):
    _set('', 'on')


def policies_enforced():
    """
    Whether PostgreSQL applies the policies to the role the tests run as. It skips them for a
    superuser and for a role with BYPASSRLS, whatever the settings say.
    """
    with connection.cursor() as cursor:
        cursor.execute('SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user')
        return not cursor.fetchone()[0]


def data_queries(captured):
    """
    The queries of a CaptureQueriesContext that read or write tables: without the savepoints of a
    nested transaction and without the reads and writes of the two RLS settings, which a tenant
    scope and this runner add around them.
    """
    return [
        query['sql'] for query in captured
        if not query['sql'].startswith(('SAVEPOINT', 'RELEASE SAVEPOINT')) and 'app.rls_bypass' not in query['sql']
    ]


class enforced:
    """
    `with enforced():` for a test that calls a service or a command directly, without an HTTP
    request: inside it the bypass is off, as in production.
    """

    def __enter__(self):
        _set('', 'off')

    def __exit__(self, *error):
        _set('', 'on')


class RlsTestRunner(DiscoverRunner):
    def setup_test_environment(self, **kwargs):
        super().setup_test_environment(**kwargs)
        connection_created.connect(_bypass_for_fixtures)
        request_started.connect(_enforce_in_request)
        request_finished.connect(_bypass_after_request)

    def teardown_test_environment(self, **kwargs):
        request_finished.disconnect(_bypass_after_request)
        request_started.disconnect(_enforce_in_request)
        connection_created.disconnect(_bypass_for_fixtures)
        super().teardown_test_environment(**kwargs)
