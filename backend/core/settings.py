"""
Django settings for Tartus Menu project.
"""

import os
from pathlib import Path
from datetime import timedelta
from dotenv import load_dotenv
from django.core.exceptions import ImproperlyConfigured

# Build paths inside the project like this: BASE_DIR / 'subdir'.
BASE_DIR = Path(__file__).resolve().parent.parent

# Load environment variables from a .env file if it exists
load_dotenv(BASE_DIR / '.env')


def env_list(name):
    """Read a comma-separated environment variable as a list, ignoring spaces and empty items."""
    return [value.strip() for value in os.getenv(name, '').split(',') if value.strip()]


# SECURITY WARNING: don't run with debug turned on in production!
# Default to False for safety. Must explicitly set DJANGO_DEBUG=True in .env for development.
DEBUG = os.getenv('DJANGO_DEBUG', 'False') == 'True'

# SECURITY WARNING: keep the secret key used in production secret!
SECRET_KEY = os.getenv('DJANGO_SECRET_KEY')
if not SECRET_KEY:
    if DEBUG:
        SECRET_KEY = 'unsafe-development-key-do-not-use-in-production'
    else:
        raise ImproperlyConfigured("DJANGO_SECRET_KEY must be set in production.")

ALLOWED_HOSTS = env_list('DJANGO_ALLOWED_HOSTS')
if not DEBUG and not ALLOWED_HOSTS:
    raise ImproperlyConfigured("DJANGO_ALLOWED_HOSTS must be set in production.")


# Application definition
INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'django.contrib.postgres',  # part of Django; ArrayField (menu_items.tags) needs it installed
    
    # Third-party apps
    'rest_framework',
    'rest_framework_simplejwt',
    'rest_framework_simplejwt.token_blacklist',
    'corsheaders',
    'storages',
    
    # Local apps
    'core',  # no models; installed so Django finds its management command backup_database
    'users',
    'cafes',
    'menu',
    'analytics',
]

MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware', # Must be at the top to intercept CORS requests
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'core.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'core.wsgi.application'


# Database
# Using PostgreSQL natively as defined in our architecture
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': os.getenv('DB_NAME', 'tartus_db'),
        'USER': os.getenv('DB_USER', 'postgres'),
        'PASSWORD': os.getenv('DB_PASSWORD', 'postgres'),
        'HOST': os.getenv('DB_HOST', 'localhost'),
        'PORT': os.getenv('DB_PORT', '5432'),
        # Persistent connections: a worker keeps its connection for up to this many seconds and reuses
        # it for the next requests, instead of opening a new one per request. 0 closes it after each request.
        # "or 60": an empty value in .env means the default too.
        'CONN_MAX_AGE': int(os.getenv('DB_CONN_MAX_AGE') or 60),
        # Before reusing a kept connection, Django checks that it still works (for example after a
        # PostgreSQL restart) and opens a new one if not, so the request does not fail.
        'CONN_HEALTH_CHECKS': True,
        # No connection pool (OPTIONS "pool"): Django does not allow it together with CONN_MAX_AGE, and
        # with sync Gunicorn workers (one request at a time each) one kept connection per worker is enough.
    }
}


# Cache
# DatabaseCache stores entries in a PostgreSQL table, so every Gunicorn worker shares them.
# The login throttle counters need this (the default in-memory cache is per process; no Redis in MVP).
# Create the table once per database: python manage.py createcachetable
CACHES = {
    'default': {
        'BACKEND': 'django.core.cache.backends.db.DatabaseCache',
        'LOCATION': 'django_cache',
    }
}


# Tests: Django's runner plus the Row-Level Security setup (core/test_runner.py, system_design.md §7.1).
TEST_RUNNER = 'core.test_runner.RlsTestRunner'


# Custom User Model definition
AUTH_USER_MODEL = 'users.User'


# Password validation
AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

# Lifetime of a password reset link (UC-ADMIN-010, UC-AUTH-005): 24 hours. The Super Admin sends the
# link by hand (for example by WhatsApp), so it needs more than minutes; Django's default is 3 days.
PASSWORD_RESET_TIMEOUT = 86400

# Email: only the password reset email (UC-AUTH-006), over SMTP. Optional, like error tracking: without
# EMAIL_HOST nothing is sent and the endpoint answers 503; the Super Admin's link (UC-ADMIN-010) still works.
EMAIL_HOST = os.getenv('EMAIL_HOST', '')
if EMAIL_HOST:
    EMAIL_PORT = int(os.getenv('EMAIL_PORT') or 587)  # 587 = SMTP with STARTTLS
    EMAIL_USE_TLS = True
    EMAIL_HOST_USER = os.getenv('EMAIL_HOST_USER', '')
    EMAIL_HOST_PASSWORD = os.getenv('EMAIL_HOST_PASSWORD', '')
    # Seconds to wait for the mail server. Django's default is no limit at all.
    EMAIL_TIMEOUT = 10
    # The sender, for example "Tartus Menu <no-reply@menu.domain.com>". Its domain must be verified at
    # the provider (deploy/README.md §15), or the mail is refused or lands in spam.
    DEFAULT_FROM_EMAIL = os.getenv('DEFAULT_FROM_EMAIL', '')
    if not DEFAULT_FROM_EMAIL:
        raise ImproperlyConfigured("DEFAULT_FROM_EMAIL must be set when EMAIL_HOST is set.")
elif DEBUG:
    # Development: the email is printed in the runserver console instead of being sent. Its text is
    # base64 there (it holds Arabic); decode it to read the link, or make one on the admin page.
    EMAIL_BACKEND = 'django.core.mail.backends.console.EmailBackend'
else:
    EMAIL_BACKEND = 'django.core.mail.backends.dummy.EmailBackend'  # sends nothing
PASSWORD_RESET_EMAIL_ENABLED = bool(EMAIL_HOST) or DEBUG


# Internationalization
LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True

# Where the cafes are. Subscription dates are calendar days in this zone (core/business_time.py);
# stored moments stay UTC.
BUSINESS_TIME_ZONE = 'Asia/Damascus'


# Static files & Media configurations
STATIC_URL = 'static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'

# Cloudflare R2 / AWS S3 Configuration for Media
USE_S3 = os.getenv('USE_S3', 'False') == 'True'
if USE_S3:
    # Django 4.2+ selects file storage through STORAGES (DEFAULT_FILE_STORAGE was removed in 5.1).
    # Both aliases must be defined once STORAGES is set.
    STORAGES = {
        'default': {'BACKEND': 'storages.backends.s3.S3Storage'},
        'staticfiles': {'BACKEND': 'django.contrib.staticfiles.storage.StaticFilesStorage'},
    }
    AWS_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID')
    AWS_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY')
    AWS_STORAGE_BUCKET_NAME = os.getenv('R2_BUCKET_NAME')
    AWS_S3_ENDPOINT_URL = os.getenv('R2_ENDPOINT_URL') # Custom Cloudflare R2 endpoint
    AWS_S3_CUSTOM_DOMAIN = os.getenv('R2_CUSTOM_DOMAIN')
    if not AWS_S3_CUSTOM_DOMAIN:
        # Without a custom domain django-storages returns signed URLs that expire after one hour.
        # Saved into image_url or logo_url, every image would break an hour later.
        raise ImproperlyConfigured("R2_CUSTOM_DOMAIN must be set when USE_S3=True.")
    AWS_S3_REGION_NAME = 'auto'  # Cloudflare R2 uses the region name "auto"
    AWS_S3_SIGNATURE_VERSION = 's3v4'
    # Every upload gets a new random key, so a stored object never changes: browsers and the CDN
    # may cache it for a year (UC-OWNER-006).
    AWS_S3_OBJECT_PARAMETERS = {'CacheControl': 'public, max-age=31536000, immutable'}
else:
    # Local storage, for development only (Compose always sets USE_S3=True). Django serves these files
    # itself in DEBUG (core/urls.py). The URL is absolute because the pages come from Next.js on another
    # port: a relative /media/... would be asked from Next.js, which has no such files.
    MEDIA_URL = os.getenv('DJANGO_MEDIA_URL') or 'http://127.0.0.1:8000/media/'
    MEDIA_ROOT = BASE_DIR / 'media'

# Daily database backup (manage.py backup_database, step 14): a separate PRIVATE R2 bucket with its own
# API token, so the token of the public images bucket can never read a dump. Checked by the command only.
R2_BACKUP_BUCKET_NAME = os.getenv('R2_BACKUP_BUCKET_NAME', '')
R2_BACKUP_ACCESS_KEY_ID = os.getenv('R2_BACKUP_ACCESS_KEY_ID', '')
R2_BACKUP_SECRET_ACCESS_KEY = os.getenv('R2_BACKUP_SECRET_ACCESS_KEY', '')
# The account's S3 API endpoint; the same as R2_ENDPOINT_URL unless set.
R2_BACKUP_ENDPOINT_URL = os.getenv('R2_BACKUP_ENDPOINT_URL') or os.getenv('R2_ENDPOINT_URL', '')
# age public key ("age1..."); every dump is encrypted for it. The private key stays off the server.
BACKUP_AGE_PUBLIC_KEY = os.getenv('BACKUP_AGE_PUBLIC_KEY', '')


# Default primary key field type
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'


# Django REST Framework Configuration
REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': (
        'rest_framework_simplejwt.authentication.JWTAuthentication',
    ),
    'DEFAULT_PERMISSION_CLASSES': (
        'rest_framework.permissions.IsAuthenticated',
    ),
    # Rates for ScopedRateThrottle. A view opts in with throttle_scope (UC-AUTH-001 uses "login").
    'DEFAULT_THROTTLE_RATES': {
        'login': os.getenv('LOGIN_THROTTLE_RATE', '5/min'),
        'password_reset': '5/min',  # UC-AUTH-005: tries of a reset link, per client IP
        'password_reset_email': '5/hour',  # UC-AUTH-006: requests for a reset email, per client IP
    },
    # Number of trusted proxies in front of Django; throttling reads the client IP with it.
    # Production (Nginx): 1. Default 0 ignores X-Forwarded-For, so a client cannot fake its IP.
    'NUM_PROXIES': int(os.getenv('DJANGO_NUM_PROXIES', '0')),
    # DRF's handler, plus the X-Error-Code header the frontend translates by (core/exceptions.py).
    'EXCEPTION_HANDLER': 'core.exceptions.api_exception_handler',
    # The frontend only reads JSON. DRF's Browsable API (an HTML page per endpoint that shows its
    # allowed methods) stays a development tool and is off when DEBUG is False.
    'DEFAULT_RENDERER_CLASSES': (
        ('rest_framework.renderers.JSONRenderer', 'rest_framework.renderers.BrowsableAPIRenderer')
        if DEBUG else
        ('rest_framework.renderers.JSONRenderer',)
    ),
}

# Simple JWT Configuration
SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(minutes=15),
    'REFRESH_TOKEN_LIFETIME': timedelta(days=1),
    'ROTATE_REFRESH_TOKENS': True,
    'BLACKLIST_AFTER_ROTATION': True,
    'AUTH_HEADER_TYPES': ('Bearer',),
}

# CORS Configuration for Next.js Frontend
CORS_ALLOW_ALL_ORIGINS = DEBUG
# In production Nginx serves the frontend and /api/ on the same domain, so this list may be empty.
CORS_ALLOWED_ORIGINS = [] if DEBUG else env_list('CORS_ALLOWED_ORIGINS')

# Public menu revalidation, Django -> Next.js (core/revalidation.py). Empty URL = disabled.
FRONTEND_REVALIDATE_URL = os.getenv('FRONTEND_REVALIDATE_URL', '')
FRONTEND_REVALIDATE_SECRET = os.getenv('FRONTEND_REVALIDATE_SECRET', '')

# Where customers open the menu; QR codes point to <this>/menu/<slug>?table=N (UC-OWNER-007).
PUBLIC_MENU_BASE_URL = os.getenv('PUBLIC_MENU_BASE_URL', '').rstrip('/')
if not PUBLIC_MENU_BASE_URL:
    if DEBUG:
        PUBLIC_MENU_BASE_URL = 'http://localhost:3000'  # the Next.js dev server
    else:
        # A printed QR code with a wrong address cannot be fixed later: fail at startup instead.
        raise ImproperlyConfigured("PUBLIC_MENU_BASE_URL must be set in production.")

# Path of the Django admin site, without slashes (system_design.md sections 1 and 5). A non-obvious
# path keeps bots from finding the login page at /admin/; Nginx routes the same path to Django.
DJANGO_ADMIN_PATH = os.getenv('DJANGO_ADMIN_PATH', '').strip('/')
if not DEBUG and DJANGO_ADMIN_PATH in ('', 'admin'):
    raise ImproperlyConfigured("DJANGO_ADMIN_PATH must be set to a non-obvious path in production.")
DJANGO_ADMIN_PATH = DJANGO_ADMIN_PATH or 'admin'  # development default

# Logging to the console (stderr), where Docker collects it. Django's other loggers keep their defaults.
LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {
        'plain': {'format': '{asctime} {levelname} {name}: {message}', 'style': '{'},
    },
    'handlers': {
        'console': {'class': 'logging.StreamHandler', 'formatter': 'plain'},
    },
    'loggers': {
        # Our modules (core.revalidation, core.media_storage) log errors that never fail the request.
        'core': {'handlers': ['console'], 'level': 'INFO'},
        # users.services logs a password reset email that could not be sent (UC-AUTH-006 A6).
        'users': {'handlers': ['console'], 'level': 'INFO'},
        # Server errors (5xx) with their traceback. Django's default only e-mails them, and no ADMINS are set.
        # 4xx answers are WARNING and stay out; Nginx logs every request anyway.
        'django.request': {'handlers': ['console'], 'level': 'ERROR', 'propagate': False},
    },
}

# Error tracking with Sentry or GlitchTip (core/error_tracking.py, system_design.md §5): only when a DSN is
# set, so development, tests and CI send nothing. SENTRY_RELEASE names the deployed image (compose.yaml).
SENTRY_DSN = os.getenv('SENTRY_DSN', '')
if SENTRY_DSN:
    from core.error_tracking import init_error_tracking

    init_error_tracking(
        SENTRY_DSN,
        release=os.getenv('SENTRY_RELEASE', ''),
        environment=os.getenv('SENTRY_ENVIRONMENT') or 'production',
    )

# Production HTTPS settings.
# Nginx terminates TLS and must always set X-Forwarded-Proto, otherwise this header can be spoofed.
# The HTTP -> HTTPS redirect and HSTS are left to Nginx (deploy/nginx/default.conf.template).
if not DEBUG:
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    # `check --deploy` warns that Django sets neither of them. Nginx does both, so these two warnings are
    # expected; silencing them lets CI fail on any other deploy warning (--fail-level WARNING).
    SILENCED_SYSTEM_CHECKS = [
        'security.W004',  # SECURE_HSTS_SECONDS: Nginx sends Strict-Transport-Security
        'security.W008',  # SECURE_SSL_REDIRECT: Nginx redirects port 80 to HTTPS
    ]
