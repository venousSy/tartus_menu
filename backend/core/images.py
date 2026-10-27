"""
Image upload pipeline shared by item images (UC-OWNER-006) and cafe logos (UC-OWNER-010).

process_image() checks an uploaded file by its content and re-encodes it as WebP.
It knows nothing about R2 or models: the services store the bytes it returns.
"""

from io import BytesIO

from PIL import Image, ImageOps
from rest_framework.exceptions import ValidationError

MAX_UPLOAD_BYTES = 2 * 1024 * 1024
MAX_PIXELS = 25_000_000  # width x height; blocks decompression bombs before any decoding
ALLOWED_FORMATS = ('JPEG', 'PNG', 'WEBP')
WEBP_QUALITY = 80

ITEM_IMAGE_MAX_SIDE = 1200
LOGO_MAX_SIDE = 512

INVALID_TYPE_MESSAGE = 'Only JPEG, PNG, and WebP images are allowed.'
TOO_LARGE_FILE_MESSAGE = 'Image must be under 2MB.'
TOO_LARGE_DIMENSIONS_MESSAGE = 'Image dimensions are too large.'

# What Pillow raises for a file it cannot read. UnidentifiedImageError is an OSError.
UNREADABLE_IMAGE_ERRORS = (OSError, SyntaxError, ValueError)


def process_image(uploaded_file, *, max_side, keep_transparency=False):
    """
    Validate an uploaded image and return it as WebP bytes.

    Checks, in the order of the use case: file size, format (by content, never by the
    client's Content-Type or file name), pixel count. Then applies the phone's rotation,
    resizes so the longest side is at most max_side (never enlarged), drops all metadata
    and encodes as WebP. Item images are flattened onto white; logos keep transparency.
    Raises ValidationError, which DRF answers with 400 {"detail": "..."}.
    """
    if uploaded_file.size > MAX_UPLOAD_BYTES:
        raise _bad_image(TOO_LARGE_FILE_MESSAGE)

    try:
        # open() reads only the header, so width and height are known before decoding.
        image = Image.open(uploaded_file, formats=ALLOWED_FORMATS)
    except Image.DecompressionBombError:  # Pillow's own limit (about 179 megapixels)
        raise _bad_image(TOO_LARGE_DIMENSIONS_MESSAGE) from None
    except UNREADABLE_IMAGE_ERRORS:
        raise _bad_image(INVALID_TYPE_MESSAGE) from None

    if image.width * image.height > MAX_PIXELS:
        raise _bad_image(TOO_LARGE_DIMENSIONS_MESSAGE)

    try:
        image.load()  # full decode: catches truncated and corrupt files
        # Phones save photos unrotated plus an EXIF "orientation" tag. Apply it now,
        # because the tag is dropped with the rest of the metadata below.
        ImageOps.exif_transpose(image, in_place=True)
    except UNREADABLE_IMAGE_ERRORS:
        raise _bad_image(INVALID_TYPE_MESSAGE) from None

    if image.mode not in ('RGB', 'RGBA'):  # palette, grayscale or CMYK
        image = image.convert('RGBA' if image.has_transparency_data else 'RGB')
    image.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)  # never enlarges

    if image.mode == 'RGBA' and not keep_transparency:
        background = Image.new('RGB', image.size, 'white')
        background.paste(image, mask=image.getchannel('A'))
        image = background

    output = BytesIO()
    # save() writes only the metadata passed to it. None is passed, so EXIF (with the
    # GPS location), ICC and XMP from the upload never reach the stored file.
    image.save(output, format='WEBP', quality=WEBP_QUALITY)
    return output.getvalue()


def _bad_image(message):
    # A dict keeps DRF's {"detail": "..."} shape; a plain string would answer ["..."].
    return ValidationError({'detail': message})
