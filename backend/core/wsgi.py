"""
WSGI config for Tartus Menu project.

It exposes the WSGI callable as a module-level variable named ``application``.
Gunicorn (production) loads it as ``core.wsgi:application``,
and runserver (development) finds it through settings.WSGI_APPLICATION.
"""

import os

from django.core.wsgi import get_wsgi_application

# Point Django to our core settings file (same default as manage.py)
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'core.settings')

application = get_wsgi_application()
