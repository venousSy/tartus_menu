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
from reportlab.graphics import renderPDF
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.pdfgen import canvas

QUIET_ZONE_MODULES = 4
PREVIEW_BOX_SIZE = 10  # pixels per module in the preview PNG
PDF_QR_SIZE = 8 * cm  # printed width of each code, quiet zone included (the use case asks for at least 3 cm)
PDF_URL_FONT_SIZE = 10  # points; a long slug makes it smaller so the URL always fits the page


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


def qr_codes_pdf(cafe, tables):
    """
    The print-ready PDF of UC-OWNER-008 as bytes: one A4 page per table, in the given order.

    Each page has the QR code of table_url() drawn as vector shapes (sharp at any print size),
    with the table number and the URL under it. The number is printed without a word such as
    "Table": the built-in PDF fonts have no Arabic letters, and a number needs no translation.
    """
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4, pageCompression=1)
    page_width, page_height = A4
    qr_bottom = page_height / 2 - 2 * cm  # the code a little above the middle, the text under it

    for table in tables:
        url = table_url(cafe, table.table_number)
        drawing = Drawing(PDF_QR_SIZE, PDF_QR_SIZE)
        drawing.add(QrCodeWidget(
            url, barLevel='Q', barBorder=QUIET_ZONE_MODULES, barWidth=PDF_QR_SIZE, barHeight=PDF_QR_SIZE
        ))
        renderPDF.draw(drawing, pdf, (page_width - PDF_QR_SIZE) / 2, qr_bottom)

        pdf.setFont('Helvetica-Bold', 48)
        pdf.drawCentredString(page_width / 2, qr_bottom - 2 * cm, str(table.table_number))
        # Leave 1 cm of margin on each side; stringWidth at size 1 scales linearly with the size.
        url_size = min(PDF_URL_FONT_SIZE, (page_width - 2 * cm) / pdf.stringWidth(url, 'Helvetica', 1))
        pdf.setFont('Helvetica', url_size)
        pdf.drawCentredString(page_width / 2, qr_bottom - 3 * cm, url)
        pdf.showPage()  # ends this table's page

    pdf.save()
    return buffer.getvalue()
