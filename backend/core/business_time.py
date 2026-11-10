"""
The business calendar. The database and Django's TIME_ZONE stay UTC; days that people talk about
("paid until the 10th") are days in settings.BUSINESS_TIME_ZONE (Asia/Damascus).
"""

from zoneinfo import ZoneInfo

from django.conf import settings
from django.utils import timezone


def business_today():
    """Today's date where the cafes are. At 22:30 UTC it is already tomorrow in Damascus."""
    return timezone.now().astimezone(ZoneInfo(settings.BUSINESS_TIME_ZONE)).date()
