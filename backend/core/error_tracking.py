"""
Error tracking with Sentry or GlitchTip (same SDK; system_design.md §5 "Error Tracking").

settings.py calls init_error_tracking() only when SENTRY_DSN is set, so development, tests and CI send
nothing. Only errors are sent (no performance tracing), and scrub_event() removes what could identify
a person or open an account before an event leaves the server. This module imports nothing from Django:
settings.py loads it before Django is set up.
"""

# Request headers that carry credentials or a visitor's address.
SENSITIVE_HEADERS = frozenset({'authorization', 'cookie', 'x-revalidate-secret', 'x-forwarded-for'})


def scrub_event(event, hint):
    """
    before_send hook: drop the request body (passwords, emails, uploads), the cookies and the sensitive
    headers. The SDK already leaves most of them out with send_default_pii=False; this makes it certain.
    """
    request = event.get('request')
    if isinstance(request, dict):
        request.pop('data', None)
        request.pop('cookies', None)
        headers = request.get('headers')
        if isinstance(headers, dict):
            request['headers'] = {
                name: value for name, value in headers.items() if name.lower() not in SENSITIVE_HEADERS
            }
    return event


def init_error_tracking(dsn, *, release='', environment='production'):
    """Start the SDK: errors only, no personal data, every event through scrub_event()."""
    import sentry_sdk  # imported here, so a run without a DSN never loads the SDK

    sentry_sdk.init(
        dsn=dsn,
        release=release or None,
        environment=environment,
        send_default_pii=False,
        # Both are on by default; local variables and bodies may hold a password or what an owner typed.
        include_local_variables=False,
        max_request_body_size='never',
        traces_sample_rate=0,
        before_send=scrub_event,
    )
