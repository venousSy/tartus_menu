"""
Public menu revalidation: Django asks Next.js to rebuild cached /menu/<slug> pages.

Contract: system_design.md section 3.5. Triggers: use_cases.md Global Convention 9.
Service functions call schedule_menu_revalidation(cafe.slug) after every write
that changes what the public menu shows.
"""

import json
import logging
import urllib.request

from django.conf import settings
from django.db import transaction

logger = logging.getLogger(__name__)

# A slow or missing frontend must never hold a dashboard request for long.
REVALIDATE_TIMEOUT_SECONDS = 2


def schedule_menu_revalidation(*slugs):
    """
    Revalidate /menu/<slug> for each slug once the current transaction commits.

    on_commit: if the transaction rolls back, nothing is sent, so Next.js never
    rebuilds a page from data that was not saved. Outside a transaction it runs at once.
    Pass two slugs when a cafe slug changes: the old one and the new one (UC-ADMIN-006).
    """
    slugs = [slug for slug in slugs if slug]
    if slugs:
        transaction.on_commit(lambda: _send_revalidation(slugs))


def _send_revalidation(slugs):
    url = settings.FRONTEND_REVALIDATE_URL
    if not url:
        return  # Not configured, e.g. local development without the frontend.

    try:
        request = urllib.request.Request(
            url,
            data=json.dumps({'slugs': slugs}).encode('utf-8'),
            headers={
                'Content-Type': 'application/json',
                'X-Revalidate-Secret': settings.FRONTEND_REVALIDATE_SECRET,
            },
            method='POST',
        )
        # urlopen raises on network errors, timeouts and non-2xx answers (e.g. 401: wrong secret).
        with urllib.request.urlopen(request, timeout=REVALIDATE_TIMEOUT_SECONDS):
            pass
    except Exception:
        # Any error is only logged and never fails the original request (system_design.md 3.5).
        # Next.js also rebuilds the page at least every 5 minutes, so a lost call heals itself.
        logger.exception('Menu revalidation failed for slugs %s', slugs)
