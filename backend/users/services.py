"""
Business rules for accounts (use_cases.md UC-AUTH-004, UC-AUTH-005 and UC-ADMIN-010): ending a user's
sessions, and the one-time password reset link.

The link's token comes from Django's default_token_generator: a signature over the user's password
hash and a timestamp. Nothing is stored. A new password changes the hash, so every link made before
stops working; that is what makes a link one-time.
"""

from datetime import timedelta

from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.contrib.auth.tokens import default_token_generator
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.utils import timezone
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_decode, urlsafe_base64_encode
from rest_framework.exceptions import ValidationError
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken

User = get_user_model()


def revoke_sessions(user):
    """
    Blacklists every outstanding refresh token of the user, so each device must log in again.
    Call it inside the transaction that changes the password: both succeed or fail together.
    """
    # One INSERT, not one query per token. ignore_conflicts skips rows blacklisted concurrently.
    outstanding_tokens = OutstandingToken.objects.filter(user=user, blacklistedtoken__isnull=True)
    BlacklistedToken.objects.bulk_create(
        [BlacklistedToken(token=token) for token in outstanding_tokens],
        ignore_conflicts=True,
    )


def change_password(user, new_password):
    """UC-AUTH-004 step 4: the new password and the end of every session, in one transaction."""
    with transaction.atomic():
        user.set_password(new_password)
        user.save(update_fields=['password'])
        revoke_sessions(user)


def password_reset_link(user):
    """
    UC-ADMIN-010: {"url", "expires_at"} for a one-time link that lets `user` set a new password.
    The secret part comes after "#", which a browser never sends to a server. No database write.
    """
    uid = urlsafe_base64_encode(force_bytes(user.pk))
    token = default_token_generator.make_token(user)
    return {
        'url': f'{settings.PUBLIC_MENU_BASE_URL}/reset-password#{uid}.{token}',
        'expires_at': timezone.now() + timedelta(seconds=settings.PASSWORD_RESET_TIMEOUT),
    }


def reset_password(*, uid, token, new_password):
    """
    UC-AUTH-005: sets the password of the user the link was made for and ends every session.

    Raises ValidationError (400) with one answer for every invalid link (A1): the caller learns
    nothing about why. The link is checked before the password (A2), which leaves the link usable.
    """
    with transaction.atomic():
        # Locked: two requests with the same link cannot both pass the token check.
        user = _user_of(uid)
        if user is None or not default_token_generator.check_token(user, token):
            raise ValidationError({'detail': 'This reset link is invalid or has expired.'}, code='reset_link_invalid')
        try:
            validate_password(new_password, user)
        except DjangoValidationError as exc:
            raise ValidationError({'new_password': list(exc.messages)}) from None
        user.set_password(new_password)
        user.save(update_fields=['password'])
        revoke_sessions(user)


def _user_of(uid):
    """The active user a link's uid names, locked for the transaction, or None for anything else."""
    try:
        pk = urlsafe_base64_decode(uid).decode()
    except (ValueError, UnicodeDecodeError):
        return None
    # Only a plain positive number may reach the query (18 digits always fit a bigint).
    if not (pk.isascii() and pk.isdigit() and len(pk) <= 18):
        return None
    return User.objects.select_for_update().filter(pk=int(pk), is_active=True).first()
