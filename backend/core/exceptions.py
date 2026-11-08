"""
DRF's exception handler plus one header: X-Error-Code.

Error bodies stay in DRF's format, {"detail": "..."} (system_design.md). The frontend translates the
message; matching the English text breaks silently when a text is reworded, so a whole-request error
also names its code in a header (for example "images_need_pro"). The code comes from the exception:
DRF's own ("not_found", "permission_denied", "throttled") or the one a service passes.
"""

from rest_framework.views import exception_handler

ERROR_CODE_HEADER = 'X-Error-Code'


def api_exception_handler(exc, context):
    response = exception_handler(exc, context)
    if response is not None and isinstance(response.data, dict):
        code = getattr(response.data.get('detail'), 'code', None)  # ErrorDetail carries its code
        if isinstance(code, str):
            response[ERROR_CODE_HEADER] = code
    return response
