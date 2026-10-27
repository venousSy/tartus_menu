"""
QR code helpers for the cafe tables (use_cases.md UC-OWNER-007, UC-OWNER-008 and UC-OWNER-011).

A printed code lives on a table for years and gets wet, scratched and photographed in dim light,
so every code uses error correction level Q (about 25% of it may be damaged) and a quiet zone
(empty border) of 4 modules, as the use case requires.
"""

import base64
from io import BytesIO

import qrcode
from django.conf import settings
from qrcode.constants import ERROR_CORRECT_Q

QUIET_ZONE_MODULES = 4
PREVIEW_BOX_SIZE = 10  # pixels per module in the preview PNG


def table_url(cafe, table_number):
    """https://menu.domain.com/menu/<slug>?table=N. The table parameter is display-only (UC-GUEST-001)."""
    return f'{settings.PUBLIC_MENU_BASE_URL}/menu/{cafe.slug}?table={table_number}'


def qr_png_data_url(url):
    """The QR code for `url` as a PNG data URL ("data:image/png;base64,..."); nothing is stored on R2."""
    code = qrcode.QRCode(
        error_correction=ERROR_CORRECT_Q, border=QUIET_ZONE_MODULES, box_size=PREVIEW_BOX_SIZE
    )
    code.add_data(url)
    code.make(fit=True)  # the smallest QR version that fits the URL
    buffer = BytesIO()
    code.make_image().save(buffer)  # a Pillow image, saved as PNG
    return 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode('ascii')
