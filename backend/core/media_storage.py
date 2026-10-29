"""
Saving processed images to file storage and removing replaced ones.

Shared by item images (UC-OWNER-006) and cafe logos (UC-OWNER-010); a deleted cafe's whole
folder is removed too (UC-ADMIN-007). The storage is STORAGES['default']: Cloudflare R2
when USE_S3=True, backend/media/ in development.
"""

import logging
import uuid

from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.db import transaction
from rest_framework import status
from rest_framework.exceptions import APIException

logger = logging.getLogger(__name__)


class ImageUploadFailed(APIException):
    """UC-OWNER-006 A4 / UC-OWNER-010 A4. DRF has no 502 exception of its own."""

    status_code = status.HTTP_502_BAD_GATEWAY
    default_detail = 'Image upload failed. Please try again.'
    default_code = 'image_upload_failed'


def store_image(data, folder):
    """
    Save WebP bytes under the new random key <folder>/<uuid4>.webp and return its public URL.

    A new key per upload means a URL never shows other content later, which is what makes
    the one-year cache header safe. Raises ImageUploadFailed (502); the cause is only logged.
    """
    key = f'{folder}/{uuid.uuid4()}.webp'
    try:
        saved_key = default_storage.save(key, ContentFile(data))
        return default_storage.url(saved_key)
    except Exception:
        # Network errors, wrong R2 credentials, a full disk: the client only needs to retry.
        logger.exception('Image upload to storage failed for key %s', key)
        raise ImageUploadFailed() from None


def delete_image_on_commit(url):
    """
    Delete the file behind a stored image URL once the current transaction commits.

    Never before the commit: if the database save rolls back, the row still points to
    this file. Best effort: a failed delete is logged and the request still succeeds.
    """
    if url:
        transaction.on_commit(lambda: _delete_image(url))


def _delete_image(url):
    # Stored URLs are <storage base URL><key>, e.g. https://media.domain.com/cafes/1/items/<uuid4>.webp.
    base_url = default_storage.url('')
    if not url.startswith(base_url):
        # Not a file in our storage (for example saved before a domain change): nothing to delete.
        logger.warning('Old image %s is not in the current storage; not deleted', url)
        return
    try:
        default_storage.delete(url.removeprefix(base_url))
    except Exception:
        # A leftover file only costs a little storage.
        logger.exception('Deleting old image %s failed', url)


def delete_folder_on_commit(folder):
    """
    Delete every stored file under <folder>/ once the current transaction commits (UC-ADMIN-007:
    cafes/<cafe_id>/ holds the cafe's item images and logos). Best effort, like delete_image_on_commit.
    """
    transaction.on_commit(lambda: _delete_folder(folder))


def _delete_folder(folder):
    try:
        _delete_tree(folder)
    except FileNotFoundError:
        pass  # local storages: the cafe never stored a file (R2 simply lists nothing)
    except Exception:
        logger.exception('Deleting the stored files under %s/ failed', folder)


def _delete_tree(folder):
    # R2 has no real folders: listdir() groups the keys that start with "<folder>/" by the next "/".
    directories, files = default_storage.listdir(folder)
    for name in files:
        default_storage.delete(f'{folder}/{name}')
    for name in directories:
        _delete_tree(f'{folder}/{name}')
