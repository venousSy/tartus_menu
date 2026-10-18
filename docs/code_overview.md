# Code Overview - Learning Guide

Project: Tartus Smart Digital Menu (backend only, so far)
Snapshot: 2026-10-12, branch `feat/backend-auth-layer`
Stack in this snapshot: Python 3.14.8, Django 6.1.2, Django REST Framework 3.18.3, djangorestframework-simplejwt 5.5.1, PostgreSQL.

> This file is a LEARNING GUIDE. It is NOT a source of truth.
> The source of truth is `docs/use_cases.md`, `docs/system_design.md` and `docs/implementation_plan.md`.
> If this guide and those documents disagree, the documents win. Then this guide must be fixed.
> This guide describes the code as it is on the snapshot date. It will go out of date. Line numbers are approximate.

---

## 0. How to use this guide

You do not need to know Django. Read in this order:

1. Section 1: the big picture, and what is built and what is not.
2. Section 2: the Python syntax you will meet in the code.
3. Section 3: Django and DRF from zero.
4. Sections 4 to 8: the real code, file by file.
5. Section 9 onward: architecture rules, computer science ideas, gaps, glossary, exercises.

Rule for reading: after each section, close the guide and explain the section in your own words. If you cannot, read it again.

---

## 1. The big picture

### 1.1 What the system does

Cafes in Tartus get a digital menu. A customer scans a QR code on a table and sees the menu in Arabic or English. The cafe owner edits the menu in a dashboard. A platform operator (the Super Admin) creates cafes and turns their subscription on or off.

There are three kinds of people ("actors"):

| Actor | Stored as | Can do |
|---|---|---|
| Super Admin | `User.role = SYSTEM_ADMIN` | Create, edit, activate, delete cafes |
| Cafe Owner | `User.role = CAFE_OWNER` | Edit own cafe's menu, QR codes, settings |
| Customer (guest) | no account | Read a public menu |

`CAFE_STAFF` exists as a role value but is out of scope for the MVP (the first release).

### 1.2 The architecture in one picture

```
 Customer / Owner / Admin browser
            |
            v
   Next.js frontend  (NOT built yet)
            |   HTTP + JSON, prefix /api/v1/
            v
   Django + DRF backend  (partly built)
            |
            +---> PostgreSQL        (data)
            +---> Cloudflare R2     (images; settings exist, upload code does not)
```

The backend is a "modular monolith". Monolith means one program, deployed as one unit. Modular means the code is split into clear modules (Django "apps"): `users`, `cafes`, `menu`. This is simpler than microservices (many small programs) and fits a small team.

### 1.3 What is built and what is not (snapshot)

| Part | State |
|---|---|
| Django project `core` (settings, root urls) | Built |
| Models: `users.User`, `cafes.SubscriptionPlan/Cafe/CafeTable/BillingEvent`, `menu.Category/MenuItem` | Built |
| Migrations for all models | Built (`0001_initial` in each app) |
| Auth: login, refresh, logout, change-password views + serializers | Built |
| Permissions: `IsSystemAdmin`, `IsCafeOwner`, `IsActiveCafe` | Built, not used by any view yet |
| URL files for the apps (`users/urls.py` etc.) and the include in `core/urls.py` | NOT built. The auth endpoints cannot be called over HTTP yet. |
| `services.py` (business rules: plan limits, transactions) | NOT built |
| Login rate limit (throttle) and the cache it needs | NOT built (planned in the use case) |
| Admin API, dashboard API, public menu API | NOT built |
| Tests | NOT built |
| Image upload, QR/PDF generation, revalidation call to Next.js | NOT built |
| Frontend (Next.js), Docker, Nginx, CI/CD | NOT built |

Today's quick health check (run on the snapshot date): `python manage.py check` reports no issues. `python manage.py makemigrations --check --dry-run` reports "No changes detected", so the models and the migration files agree. (PostgreSQL was not running, so Django skipped its check of the applied-migration history and printed a warning. That is normal here.)

---

## 2. Python syntax you will meet in this code

Each item shows a real example from the project, then explains it.

### 2.1 Imports

```python
from django.db import models
from rest_framework_simplejwt.tokens import RefreshToken
from .serializers import LoginSerializer
```

- `from X import Y` loads the name `Y` from module `X`. `X` is a dotted path to a file or package.
- `from .serializers import ...` has a leading dot. It is a relative import: "from the file `serializers.py` that sits next to this file".
- `import X as Y` gives a module a shorter local name.

### 2.2 Classes, inheritance, mixins

```python
class User(AbstractBaseUser, PermissionsMixin):
```

- A class is a blueprint. The names in brackets are parent classes. `User` receives all their attributes and methods.
- Python allows many parents (multiple inheritance). When two parents define the same method, Python picks one by a fixed order called the MRO (method resolution order).
- A "mixin" is a small parent class that adds one extra ability and is not meant to be used alone. `PermissionsMixin` adds permission fields. `AbstractBaseUser` adds the password handling.

### 2.3 `self`, `cls`, `@classmethod`, decorators

```python
class CustomUserManager(BaseUserManager):
    @classmethod
    def normalize_email(cls, email):
        return super().normalize_email(email).lower()
```

- In a normal method the first parameter is `self`: the object. In a class method it is `cls`: the class itself.
- `@classmethod` is a decorator. A decorator is a function that wraps another function and changes how it behaves. The `@` line is shorthand for `normalize_email = classmethod(normalize_email)`.
- `super()` means "my parent class". `super().normalize_email(email)` runs the parent's version first. Then `.lower()` lowercases the result. This is "extend the parent's behavior, do not replace it".

### 2.4 Nested classes

```python
class User(...):
    class Role(models.TextChoices):
        SYSTEM_ADMIN = 'SYSTEM_ADMIN', _('System Admin')
    ...
class Cafe(models.Model):
    class Meta:
        db_table = 'cafes'
```

A class inside a class is just a way to group names. Django has a convention: an inner class called `Meta` holds options about the model (table name, ordering, constraints). Django reads it. It is not part of your data.

### 2.5 `*args`, `**kwargs`, and `**` unpacking

```python
def create_user(self, email, password=None, **extra_fields):
    user = self.model(email=email, **extra_fields)
```

```python
return self.get(**{f"{self.model.USERNAME_FIELD}__iexact": username})
```

- `**extra_fields` in a definition means: "collect all extra keyword arguments into a dict called `extra_fields`".
- `**some_dict` in a call means the opposite: "spread this dict as keyword arguments".
- The second example builds a dict with ONE key whose name is computed at run time. Here `USERNAME_FIELD` is `"email"`, so the key is `"email__iexact"`. The line is the same as `self.get(email__iexact=username)`. The dict trick is used because the field name is not fixed in the manager code.

### 2.6 f-strings

`f"Table {self.table_number} (cafe {self.cafe_id})"` puts the values of the expressions inside `{ }` into the string.

### 2.7 List comprehension

```python
return [value.strip() for value in os.getenv(name, '').split(',') if value.strip()]
```

Read it as: "make a list; for each `value` in the comma-separated pieces; keep it only if it is not empty after stripping; the item is `value.strip()`". It is a short form of a `for` loop with an `if` and `append`.

### 2.8 Truthiness and short-circuit logic

```python
return bool(
    request.user
    and request.user.is_authenticated
    and request.user.role == User.Role.SYSTEM_ADMIN
)
```

- In Python, `None`, `0`, `''`, `[]`, `{}` count as "false". Almost everything else counts as "true".
- `a and b` returns `a` if `a` is false, otherwise `b`. It stops at the first false value (short-circuit). So `request.user.role` is never read if the user is not authenticated.
- `and` can return a non-bool value (for example `None`). `bool(...)` forces a real `True` or `False`.

### 2.9 `getattr` with a default

```python
cafe = getattr(request.user, 'cafe', None)
```

`getattr(obj, "name", default)` reads `obj.name`. If that raises `AttributeError`, it returns `default` instead. It is used here because a user without a cafe raises an error when you read `user.cafe` (see 6.3).

### 2.10 `with` (context manager)

```python
with transaction.atomic():
    user.set_password(...)
    user.save(update_fields=['password'])
    ...
```

`with` runs setup code when entering the block and cleanup code when leaving it, even if an error happens. For `transaction.atomic()`: entering starts a database transaction; leaving normally commits; leaving by an exception rolls everything back.

### 2.11 `try / except`, `raise`

```python
try:
    token = RefreshToken(serializer.validated_data['refresh'])
except TokenError:
    return invalid_token_response
```

If the code in `try` raises `TokenError`, Python jumps to `except`. `raise SomeError("text")` creates an error on purpose. `raise X from exc` (in `manage.py`) records the original error as the cause.

### 2.12 Dict helpers

```python
extra_fields.setdefault("is_staff", True)          # set only if the key is missing
self.name.get('en', self.name.get('ar', self.slug)) # nested fallback
```

`d.get(key, default)` returns `default` instead of raising `KeyError`. The nested form means: English name, else Arabic name, else the slug.

### 2.13 Operator overloading, tuples

```python
BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_ROOT = BASE_DIR / 'staticfiles'
AUTH_HEADER_TYPES = ('Bearer',)
```

- `Path / 'x'` joins paths. The `/` operator is redefined for `Path` objects. It works on Windows and Linux.
- `__file__` is the path of the current file. `.parent.parent` goes up two folders (`core/settings.py` -> `core/` -> `backend/`).
- `('Bearer',)` is a tuple with ONE item. The comma makes it a tuple. `('Bearer')` would just be a string.

### 2.14 Dunder ("double underscore") names

- `__str__` defines how an object turns into text (used by the Django admin and by `print`).
- `if __name__ == '__main__':` runs `main()` only when the file is started directly, not when it is imported.
- `__file__` was shown above.

### 2.15 Strings that name code ("dotted paths")

```python
AUTH_USER_MODEL = 'users.User'
'DEFAULT_AUTHENTICATION_CLASSES': ('rest_framework_simplejwt.authentication.JWTAuthentication',)
cafe = models.ForeignKey('cafes.Cafe', ...)
```

Django and DRF often take the NAME of a class as text and import it later. Reasons: the settings file loads very early, importing real classes there would cause circular imports (A imports B, B imports A), and the setting can be changed without touching library code.

### 2.16 `gettext_lazy as _`

`_('System Admin')` marks a text for translation. "Lazy" means the translation is done when the text is shown, not when the code is loaded. In this project the labels are English only for now.

### 2.17 Late binding

In `CustomUserManager.create_superuser` the code uses `User.Role.SYSTEM_ADMIN`, but `User` is defined BELOW the manager in the file. This works because Python looks up the name `User` when the method RUNS, not when the method is defined. By then the module is fully loaded.

### 2.18 A classic pitfall: mutable defaults

`models.JSONField(default=dict)` passes the function `dict`, not `{}`. Django calls it for every new row, so each row gets its own empty dict. If you wrote `default={}`, one shared dict would be reused. Django also warns about this.

---

## 3. Django and DRF from zero

### 3.1 Project, app, and `manage.py`

- A Django **project** is the whole website configuration. Here it is the folder `backend/core/` (settings + root URLs).
- A Django **app** is one feature module inside the project: `users`, `cafes`, `menu`. An app has models, views, and so on. Apps are listed in `INSTALLED_APPS`.
- `backend/manage.py` is the command-line tool. It sets the environment variable `DJANGO_SETTINGS_MODULE=core.settings` (so Django knows where the settings are) and runs a command.

Commands you will use:

| Command | What it does |
|---|---|
| `python manage.py check` | Looks for configuration mistakes |
| `python manage.py makemigrations` | Creates a migration file from model changes |
| `python manage.py migrate` | Applies migrations to the database |
| `python manage.py shell` | Python prompt with Django loaded |
| `python manage.py createsuperuser` | Creates an admin user |
| `python manage.py test` | Runs tests |

Run them from `backend/` with the virtual environment active (`venv`). A virtual environment is a private folder of Python packages for one project, so versions do not clash with other projects.

### 3.2 Django's pieces and how DRF changes them

Classic Django is called MVT (Model, View, Template). This project builds an API, not HTML pages, so Templates are replaced by DRF **serializers** that produce JSON.

| Piece | Job | File here |
|---|---|---|
| Model | A Python class that maps to a database table | `models.py` |
| View | Receives a request, returns a response | `views.py` |
| Serializer (DRF) | Validates input data and converts objects to JSON | `serializers.py` |
| Permission (DRF) | Decides who may call a view | `permissions.py` |
| URL router | Maps a URL path to a view | `urls.py` (not built yet) |
| Middleware | Code that wraps every request | `settings.MIDDLEWARE` |

Note: the word "view" in Django means what many other frameworks call a "controller".

### 3.3 The life of one request

```
 Client                        sends  POST /api/v1/auth/logout/
                                      Authorization: Bearer <access token>
   |
   v
 Web server (Gunicorn in production, runserver in development)
   |   speaks WSGI: a standard interface between web servers and Python apps
   v
 Django middleware chain (settings.MIDDLEWARE), top to bottom
   |
   v
 URL router: core/urls.py -> app urls.py -> picks the view     (urls not wired yet)
   |
   v
 DRF APIView.dispatch(), in this order:
   1. Authentication  - who are you?   -> sets request.user      (JWTAuthentication)
   2. Permissions     - may you?       -> permission_classes
   3. Throttling      - too many?      -> (planned for login)
   4. Handler method  - post() / get() ...
          serializer.is_valid()  -> check input
          service function       -> business rules      (planned)
          ORM calls              -> SQL -> PostgreSQL
   5. Response object -> JSON
   If any step raises an exception, DRF turns it into {"detail": "..."} with a status code.
   |
   v
 Middleware chain, bottom to top  ->  response to client
```

Status codes used by this project (from `use_cases.md`): 400 invalid input, 401 not logged in or bad token, 403 logged in but not allowed (role, plan, subscription), 404 not found or belongs to another cafe, 429 too many requests.

401 vs 403 in DRF: if authentication failed or is missing, DRF answers 401 (because `JWTAuthentication` tells DRF which `WWW-Authenticate` header to send). If you are known but not allowed, it answers 403.

### 3.4 The ORM (object-relational mapper)

The ORM lets you use Python objects instead of writing SQL.

| Database | Django |
|---|---|
| table | model class |
| row | model instance |
| column | field |
| `SELECT ... WHERE` | `Model.objects.filter(...)` |

Key ideas:

- `Model.objects` is the **manager**. It is the entry point for queries.
- A **QuerySet** is a lazy description of a query. `Category.objects.filter(cafe=my_cafe)` does NOT hit the database yet. SQL runs when you loop over it, call `list()`, `len()`, `.count()`, `.exists()`, or index it. Lazy means you can chain `.filter().order_by()` and Django builds ONE query.
- `.get(...)` returns exactly one object or raises an error (`DoesNotExist`, or `MultipleObjectsReturned`).
- Double underscore lookups: `email__iexact="A@B.com"` (case-insensitive equal), `deleted_at__isnull=True`, `blacklistedtoken__isnull=True` (a lookup through a relation).
- Each foreign key gives you two names: `item.category` (the object, may cost a query) and `item.category_id` (the raw number, free).
- **N+1 problem**: loading 100 items and then reading `item.category.name` for each one runs 1 query for the list plus 100 queries for categories. Fix: `select_related('category')` (a SQL JOIN). You will see the code avoid it in `__str__` by using `self.cafe_id` instead of `self.cafe.slug`.

The pattern the project rules require for every cafe-owned table (not built yet):

```python
Category.objects.filter(cafe=request.user.cafe)   # tenant filter; objects already hides soft-deleted rows
```

### 3.5 Migrations

A migration is version control for the database schema. The flow:

1. You change a model class.
2. `makemigrations` compares your models to the existing migration files and writes a NEW Python file that describes the difference.
3. `migrate` runs those files in the right order and changes the real database. It records what it applied in a table called `django_migrations`.

Rules: never edit a migration that was already applied; never hand-write one (project rule: always generate it). Details are in section 7.

### 3.6 Settings

`core/settings.py` is a Python file with constants. Django reads the UPPERCASE names. Details are in section 5.

---

## 4. Project map

```
tartus_menu/
|-- AGENTS.md                 Rules for the AI assistant (one file per turn, layering, invariants)
|-- README.md                 Short project summary
|-- docs/                     Design documents (source of truth) + this guide
|-- backend/
|   |-- manage.py             Command-line entry point
|   |-- requirements.txt      Python dependencies
|   |-- core/                 Django PROJECT
|   |   |-- settings.py       All configuration
|   |   `-- urls.py           Root URL table (only /admin/ so far)
|   |-- users/                APP: accounts and authentication
|   |   |-- models.py         User + CustomUserManager
|   |   |-- serializers.py    Login, logout, change-password input rules
|   |   |-- views.py          The 4 auth endpoints (as classes)
|   |   |-- permissions.py    Role and subscription checks
|   |   `-- migrations/0001_initial.py
|   |-- cafes/                APP: the tenant (cafe), plans, tables, billing log
|   |   |-- models.py
|   |   `-- migrations/0001_initial.py
|   `-- menu/                 APP: categories and items
|       |-- models.py
|       `-- migrations/0001_initial.py
`-- (frontend/ not created yet)
```

Dependency direction between apps: `menu` -> `cafes` -> `users`. This means `menu` models point to `cafes`, and `cafes` points to `users`. Nothing points the other way. This avoids circular imports.

---

## 5. `core/settings.py` section by section

### 5.1 Paths and environment variables

```python
BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / '.env')
```

- `BASE_DIR` is the `backend/` folder.
- `load_dotenv` reads a file named `.env` (if it exists) and puts its lines into the process environment. Secrets live in `.env`, never in code (project invariant). `.env` is listed in `.gitignore`.
- `os.getenv('NAME', 'default')` reads an environment variable. Environment variables are ALWAYS text. That is why the code compares `== 'True'` and does not use real booleans.

This style (configuration from the environment) comes from the "twelve-factor app" method: the same code runs in development and production; only the environment differs.

### 5.2 `env_list`

A helper that turns `"a.com, b.com"` into `["a.com", "b.com"]`. It is used for `ALLOWED_HOSTS` and `CORS_ALLOWED_ORIGINS`.

### 5.3 `DEBUG`, `SECRET_KEY`, `ALLOWED_HOSTS`: fail safe, fail fast

```python
DEBUG = os.getenv('DJANGO_DEBUG', 'False') == 'True'
```

- Default is `False` (safe). Only the exact text `True` turns debug on. `true` or `1` stay off. When something is unclear, the code chooses the safe value ("fail safe").
- `DEBUG=True` shows detailed error pages with settings and code. Never in production.
- `SECRET_KEY`: if missing and not in debug, the code raises `ImproperlyConfigured` and the server refuses to start ("fail fast"). It is better to crash at startup than to run with a weak key.
- This key signs Django's cookies and, with simplejwt's defaults, it also signs the JWT tokens. If it leaks, an attacker can forge tokens for any user.
- `ALLOWED_HOSTS` is the list of host names the server accepts. It protects against HTTP Host header attacks.

### 5.4 `INSTALLED_APPS`

| Entry | Why it is there |
|---|---|
| `django.contrib.admin` | The built-in admin website |
| `django.contrib.auth` | Users, passwords, permissions framework |
| `django.contrib.contenttypes` | Required by auth's permission system |
| `django.contrib.sessions`, `messages` | Needed by the admin site |
| `django.contrib.staticfiles` | Serving CSS/JS of the admin |
| `rest_framework` | DRF |
| `rest_framework_simplejwt` | JWT authentication |
| `rest_framework_simplejwt.token_blacklist` | Adds database tables to remember issued and revoked refresh tokens |
| `corsheaders` | CORS headers (see 5.10) |
| `storages` | `django-storages`: save files to S3-compatible storage such as R2 |
| `users`, `cafes`, `menu` | Our apps |

### 5.5 `MIDDLEWARE`

Middleware is a list of small layers. Each request goes down the list; each response goes back up (like layers of an onion). Notable ones:

- `CorsMiddleware` is first so it can answer browser pre-flight checks early.
- `SecurityMiddleware` adds security headers and HTTPS rules.
- `SessionMiddleware`, `AuthenticationMiddleware`, `MessageMiddleware`, `CsrfViewMiddleware`: used by the Django admin site (cookie sessions, CSRF protection). The JSON API does not use them: DRF views are exempt from CSRF, and only DRF's `SessionAuthentication` would enforce it. Our API uses JWT in the `Authorization` header, which a malicious website cannot add to a cross-site request. That is why CSRF is not a problem for the API.
- `XFrameOptionsMiddleware` blocks the site from being shown inside a hostile iframe (clickjacking).

### 5.6 Templates, WSGI, URLs

- `ROOT_URLCONF = 'core.urls'` tells Django where the root URL table is.
- `TEMPLATES` is only needed for the admin site's HTML.
- `WSGI_APPLICATION = 'core.wsgi.application'` points to a file that does not exist yet (see section 11).

### 5.7 `DATABASES`

PostgreSQL with defaults for local development; every value can be overridden by `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`. The defaults are for a developer machine only. Production must set real values. `psycopg2-binary` is the Python driver that talks to PostgreSQL.

### 5.8 `AUTH_USER_MODEL = 'users.User'`

Tells Django: "use OUR user class, not the built-in one". This must be decided BEFORE the first `migrate`, because many tables point to the user table and changing it later is very painful. That is why `users` was the first migration.

### 5.9 Password validators, language, time

- Four built-in password validators: not too similar to the user's data, minimum length (8), not a common password, not only digits. They run when a password is changed (see `ChangePasswordSerializer`).
- `USE_TZ = True` with `TIME_ZONE = 'UTC'`: Django stores timezone-aware datetimes (PostgreSQL `timestamptz`) in UTC. Convert to local time only when you show it to a person.

### 5.10 Files: static, media, R2

- Static files are your CSS/JS (here: the admin site). `STATIC_ROOT` is where `collectstatic` gathers them for Nginx.
- Media files are user uploads (menu images). If `USE_S3` is `True`, Django saves them through `storages.backends.s3.S3Storage` to Cloudflare R2. R2 speaks the same protocol as Amazon S3, so `django-storages` and `boto3` work with it; only the endpoint URL differs. The region name is `auto` for R2.
- If `USE_S3` is off, files go to the local `media/` folder.
- Upload code is not written yet. Only the configuration exists.

### 5.11 `DEFAULT_AUTO_FIELD`

`BigAutoField` = a 64-bit integer primary key that PostgreSQL increments by itself. It is the type of every `id` column.

### 5.12 `REST_FRAMEWORK`

```python
'DEFAULT_AUTHENTICATION_CLASSES': ('rest_framework_simplejwt.authentication.JWTAuthentication',),
'DEFAULT_PERMISSION_CLASSES': ('rest_framework.permissions.IsAuthenticated',),
```

- Every view authenticates with a JWT by default.
- Every view requires a logged-in user by default. This is the "deny by default" principle: a developer who forgets to set permissions gets a closed endpoint, not an open one. Public endpoints must opt out on purpose (`LoginView` does this with `AllowAny`).

### 5.13 `SIMPLE_JWT`

| Setting | Value | Meaning |
|---|---|---|
| `ACCESS_TOKEN_LIFETIME` | 15 minutes | Short life limits damage if an access token is stolen |
| `REFRESH_TOKEN_LIFETIME` | 1 day | After a day the user must log in again |
| `ROTATE_REFRESH_TOKENS` | True | Every refresh call returns a NEW refresh token |
| `BLACKLIST_AFTER_ROTATION` | True | ...and the old one is revoked, so it works only once |
| `AUTH_HEADER_TYPES` | `('Bearer',)` | Header looks like `Authorization: Bearer <token>` |

### 5.14 CORS

Browsers apply the **same-origin policy**: a page from site A cannot read responses from site B. **CORS** (cross-origin resource sharing) is how site B says "site A may read my responses" using special headers. During development the frontend and the API run on different ports (different origins), so `CORS_ALLOW_ALL_ORIGINS = DEBUG` allows everything. In production Nginx serves both under one domain, so the allowed list can stay empty (same origin needs no CORS).

### 5.15 Production HTTPS settings

Only when `DEBUG` is off:

- `SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')`: Nginx ends the HTTPS connection and talks plain HTTP to Django. Nginx adds the header `X-Forwarded-Proto: https`. This setting tells Django to trust that header, so Django knows the original request was secure. Danger: if the proxy does not overwrite this header, a client could fake it. The code comment says so.
- `SESSION_COOKIE_SECURE`, `CSRF_COOKIE_SECURE`: cookies are sent only over HTTPS.

---

## 6. The data layer: models

### 6.1 Relationship overview

| Model | DB table | Key relations | When the parent is deleted |
|---|---|---|---|
| `users.User` | `users_user` | - | - |
| `cafes.SubscriptionPlan` | `subscription_plans` | - | - |
| `cafes.Cafe` | `cafes` | `owner` -> User (one-to-one), `plan` -> SubscriptionPlan | User deleted: cafe deleted (CASCADE). Plan: deletion is blocked (PROTECT) |
| `cafes.CafeTable` | `cafe_tables` | `cafe` -> Cafe | cafe deleted: tables deleted |
| `cafes.BillingEvent` | `billing_events` | `cafe` -> Cafe, `performed_by` -> User | cafe deleted: events deleted. User deleted: `performed_by` becomes NULL (SET_NULL) |
| `menu.Category` | `categories` | `cafe` -> Cafe | cafe deleted: categories deleted |
| `menu.MenuItem` | `menu_items` | `category` -> Category, `cafe` -> Cafe | either parent deleted: item deleted |

```
SubscriptionPlan 1 ----< N Cafe N >---- 1 (owner) User
                              |
          +-------------------+-------------------+----------------+
          | 1                 | 1                 | 1              | 1
          N CafeTable         N BillingEvent      N Category       N MenuItem (cafe_id copy)
                                                    | 1
                                                    N MenuItem
```

How to read "1 ----< N": one plan has many cafes.

`on_delete` choices used in the project:

- `CASCADE`: delete the children too. Used when children make no sense without the parent (a table without its cafe).
- `PROTECT`: refuse to delete the parent while children exist. Used for the plan, so a plan cannot disappear under living cafes.
- `SET_NULL`: keep the child, clear the link. Used for the audit log, so history survives when an admin account is removed. The column must allow NULL (`null=True`).

`related_name` is the name of the REVERSE link. `Cafe.owner` has `related_name='cafe'`, so you can write `user.cafe`. `Cafe.plan` has `related_name='cafes'`, so `plan.cafes.all()` lists the cafes on a plan.

### 6.2 `users/models.py`

**Why a custom user model.** Django's default user logs in with a `username`. This project wants login by email and a `role` field. So it defines `User` itself.

```python
class User(AbstractBaseUser, PermissionsMixin):
```

- `AbstractBaseUser` provides: `password` (stored hashed), `last_login`, `set_password()`, `check_password()`, `is_authenticated`.
- `PermissionsMixin` provides: `is_superuser`, `groups`, `user_permissions` and permission-checking methods (used by the admin site).
- The class adds: `email`, `role`, `is_staff`, `is_active`, `date_joined`.

**Passwords.** `set_password(raw)` never stores the raw text. It stores a salted, slow hash. In this Django version the default is PBKDF2 with SHA-256 and 1,500,000 iterations (checked in the installed `hashers.py`). A *salt* is random text added before hashing so two users with the same password get different hashes. A *slow* hash makes guessing passwords expensive for an attacker. The stored text looks like `algorithm$iterations$salt$hash`. `check_password(raw)` hashes the input the same way and compares.

**`Role` (an enum).**

```python
class Role(models.TextChoices):
    SYSTEM_ADMIN = 'SYSTEM_ADMIN', _('System Admin')
```

`TextChoices` is a Django enumeration. Each member has a `.value` (the text saved in the database, `'SYSTEM_ADMIN'`) and a `.label` (a human text). `Role.choices` gives the list of pairs. In code you write `User.Role.SYSTEM_ADMIN` instead of a raw string, so a typo becomes an error you can see. Note: the database column is a plain `varchar(20)`. The list of allowed values is checked by Django validation (and by DRF serializers), not by the database itself.

The default role is `CAFE_OWNER`, never the most powerful role. This is "least privilege": by default, give the smallest rights.

**`is_staff` vs `role`.** `is_staff` only controls access to the Django admin website. API authorization uses `role` (project invariant). `create_superuser` sets both (`is_staff=True`, `is_superuser=True`, `role=SYSTEM_ADMIN`).

**`USERNAME_FIELD = "email"`.** Tells Django which field is the login name. `REQUIRED_FIELDS = []` means the `createsuperuser` command asks only for email and password.

**`CustomUserManager`.** A manager is where "create" logic and query helpers live.

- `create_user(email, password=None, **extra_fields)`: checks the email exists, normalizes it, builds the object with `self.model(...)`, hashes the password with `set_password`, saves. `using=self._db` selects the database connection alias (supports several databases).
- `normalize_email` override: Django lowercases only the domain part (`Owner@Cafe.com` -> `Owner@cafe.com`). The override lowercases everything, so `Owner@Cafe.com` and `owner@cafe.com` cannot become two accounts.
- `get_by_natural_key(username)`: the "natural key" of a user is the value of `USERNAME_FIELD`. Django's `authenticate()` (and therefore simplejwt login) calls this method to find the user. The override uses `email__iexact`, so the login lookup ignores case. In SQL this is roughly `WHERE UPPER(email) = UPPER(...)`. (A plain unique index on `email` cannot serve an `UPPER()` search; with a very large user table you would add a functional index. Not needed for the MVP.)
- `clean()` on the model: forms such as the admin site call `clean()` but skip `create_user`, so the email is normalized there too.
- `create_superuser`: `setdefault` fills in the defaults only if the caller did not pass them, then checks them.

The database table is named `users_user` (Django's default `<app>_<model>`). The other models set `db_table` by hand.

### 6.3 `cafes/models.py`

**`SubscriptionPlan`** - the tiers (Basic, Pro).

- `max_categories`, `max_items`: `null=True, blank=True`. `NULL` means "unlimited". `null` is a DATABASE option (the column may hold NULL). `blank` is a VALIDATION option (a form or serializer may leave it empty). They are different; people confuse them.
- `allows_images`, `allows_branding`: capability flags. The project rule says: decide features by these flags, never by comparing the plan name. Reason: you can add or rename a plan without touching business code (open for extension, closed for modification).
- `get_name_display()` is a method Django creates automatically for any field with `choices`. It returns the label (`'Basic'`).

**`Cafe`** - the tenant. "Tenant" means one customer organization using the shared system. Everything a cafe owns points to it.

- `owner = OneToOneField(settings.AUTH_USER_MODEL, ..., related_name='cafe')`: one user owns at most one cafe, and one cafe has one owner. It uses `settings.AUTH_USER_MODEL` (text) instead of importing `User`, which avoids circular imports and respects the custom-user setting.
- Reading `user.cafe` when the user has no cafe raises `Cafe.RelatedObjectDoesNotExist`. That exception class also inherits from `AttributeError`, so `getattr(user, 'cafe', None)` safely returns `None`. The permission classes rely on this.
- `plan = ForeignKey(..., on_delete=PROTECT)`.
- `name = JSONField(default=dict)`: stores `{"ar": "...", "en": "..."}`. On PostgreSQL this is a `jsonb` column (binary JSON, can be indexed and queried). It keeps both languages in one column. The trade-off: the database does not check the shape of the JSON. The "only keys ar and en, ar required" rule must be enforced in serializers.
- `primary_color`, `logo_url`: `blank=True, default=''`. The project uses the empty string, not NULL, for "none" on text fields. Reason: otherwise there are two different "empty" values (`''` and `NULL`) and every check must handle both.
- `is_active = BooleanField(default=False)`: a new cafe is OFF until the Super Admin activates it (billing is manual).
- `created_at` uses `auto_now_add=True` (set once at creation). `updated_at` uses `auto_now=True` (reset on every `save()`). Note: `QuerySet.update()` does not trigger `auto_now`.
- `__str__` falls back from English name, to Arabic name, to slug.

**`CafeTable`** - one row per physical table, with a QR token.

- `validators=[MinValueValidator(1), MaxValueValidator(200)]`: limits the table number to 1..200. See 6.6 about what validators do and do not do.
- `qr_token = UUIDField(default=uuid.uuid4, editable=False, unique=True)`: a random 128-bit identifier. `default=uuid.uuid4` passes the function (called per row). `editable=False` hides it from forms and makes it read-only in model serializers. `unique=True` creates a unique index.
- `UniqueConstraint(fields=['cafe', 'table_number'])`: the PAIR must be unique. Table 5 may exist in many cafes, but only once in one cafe. A composite unique constraint also gives PostgreSQL an index on the pair.
- Design choice (from the docs): the table count is not stored. It is derived by counting active rows. Storing a count would create a value that can disagree with the rows ("single source of truth").

**`BillingEvent`** - an audit log (a record of who did what and when). `ordering = ['-created_at']` shows the newest first. `performed_by` uses `SET_NULL` so the history stays after an admin is deleted.

### 6.4 `menu/models.py`

**Soft delete.** Instead of `DELETE FROM`, the row gets a `deleted_at` timestamp. Why: an undo is possible, history is kept, and references from other rows do not break. The cost: EVERY normal query must exclude deleted rows, and unique rules and plan limits must be written with this in mind.

The project makes this automatic with a custom manager:

```python
class ActiveManager(models.Manager):
    def get_queryset(self):
        return super().get_queryset().filter(deleted_at__isnull=True)

class Category(models.Model):
    objects = ActiveManager()        # normal queries: hides deleted rows
    all_objects = models.Manager()   # escape hatch: includes deleted rows
```

Things to know:

1. The FIRST manager declared becomes the model's *default manager*. That is why `objects = ActiveManager()` is written first.
2. Reverse relations use the default manager's class. So `category.items.all()` hides soft-deleted items.
3. Forward foreign-key access (`item.category`) uses Django's plain base manager, so it can still return a soft-deleted category. Keep this in mind in services.
4. Managers are Python behavior, not schema. They do not appear in migration files.

**`MenuItem` and denormalization.** `MenuItem` already reaches its cafe through `category.cafe`. It also stores its own `cafe` foreign key. Storing the same fact twice is called **denormalization**. The reasons: filtering `MenuItem.objects.filter(cafe=...)` needs no JOIN, and it is a simple column for the future PostgreSQL row-level-security policy. The risk: the two values can disagree, and then an item could leak into another cafe's menu. The guard:

```python
def save(self, *args, **kwargs):
    if self.cafe_id != self.category.cafe_id:
        raise ValueError("MenuItem.cafe must match MenuItem.category.cafe.")
    super().save(*args, **kwargs)
```

Limits of this guard: `QuerySet.update()`, `bulk_create()` and `bulk_update()` do not call `save()`, so they skip the check. The code comment warns about this. Also, `self.category.cafe_id` costs one extra query when the category is not already loaded.

**Money.** `price = DecimalField(max_digits=10, decimal_places=2)`. Never use `float` for money: binary floating point cannot represent most decimal fractions exactly (`0.1 + 0.2` is `0.30000000000000004` in Python). `Decimal` stores exact decimal digits. The currency (SYP) is not stored; it is fixed by project decision.

**Ordering.** `sort_order` uses "gapped integers" (100, 200, 300). To move an item between two others, give it the middle number (150). Only one row changes, not the whole list. `Meta.ordering = ['sort_order', 'id']` makes every query sorted this way by default; `id` is the tie-breaker so results are stable.

`ForeignKey('cafes.Cafe')` uses the text form `'app.Model'`. It points to a model in another app without importing it.

### 6.5 Why JSON for names?

`{"ar": "...", "en": "..."}` in one column versus two columns (`name_ar`, `name_en`) or a translation table:

| Option | Good | Bad |
|---|---|---|
| JSON column (chosen) | One field, easy to add a language later, simple queries by id | Database does not check the shape; harder to search by text |
| Two columns | Database-level checks, easy to index | Schema change for each new language |
| Translation table | Fully normalized | More JOINs and more code for a 2-language MVP |

### 6.6 Validators versus database constraints

- A **validator** (like `MinValueValidator`) is Python code. It runs when `full_clean()` is called, and when a DRF `ModelSerializer` validates input. It does NOT run on a plain `.save()`, and not on raw SQL.
- A **constraint** (like `UniqueConstraint`, or a `CheckConstraint`) lives in the database. It protects the data against any code path, including scripts and the admin.

`system_design.md` section 2.2 mentions `CHECK` rules for `table_number` (1..200), `price >= 0` and `primary_color`. In the current models only `table_number` has a validator, and there are no database `CheckConstraint`s. See section 11.

---

## 7. Reading the migrations

Open `backend/cafes/migrations/0001_initial.py` while reading this.

```python
class Migration(migrations.Migration):
    initial = True
    dependencies = [migrations.swappable_dependency(settings.AUTH_USER_MODEL)]
    operations = [ migrations.CreateModel(name='SubscriptionPlan', fields=[...], options={...}), ... ]
```

- `initial = True`: the first migration of the app.
- `dependencies`: migrations that must run first. The result is a graph (a DAG, a directed acyclic graph). Here: `cafes` needs the user table, so it depends on "whatever model `AUTH_USER_MODEL` points to". `menu/0001` depends on `cafes/0001`. `users/0001` depends on `auth/0012...` because `User` has many-to-many links to `auth.Group` and `auth.Permission`.
- `operations`: the schema steps. `CreateModel` becomes `CREATE TABLE`. Field arguments (like `max_length`, `choices`, `validators`) are copied into the file, so a change to them creates a new migration.
- `users/0001` creates two extra join tables (`groups`, `user_permissions`) because of `PermissionsMixin`.
- Python behavior that is not schema does not appear in the file: custom managers (`ActiveManager`), the `save()` guard, `__str__`. Field arguments and `Meta` options (`ordering`, `db_table`, `constraints`) DO appear.

Project rules for migrations: generate with `makemigrations`, never hand-write, review the content, and keep each migration as its own step.

---

## 8. The authentication layer

### 8.1 Concepts first

- **Authentication**: proving who you are (login). **Authorization**: deciding what you may do (roles, permissions).
- A **session** keeps state on the server (a cookie points to server-side data). A **token** keeps the state inside the token itself and the server only checks it. Tokens fit APIs used by separate frontends and scale without a shared session store.
- **JWT** (JSON Web Token) has three parts joined by dots: `header.payload.signature`.
  - Header and payload are JSON encoded with base64url. They are NOT encrypted. Anyone can read them. Never put secrets inside.
  - The signature is an HMAC (a keyed hash; here HMAC-SHA256, simplejwt's default `HS256`) over header + payload, made with the server's secret key. If someone edits the payload, the signature no longer matches and the server rejects the token.
  - The payload contains "claims" (facts). Example access-token payload in this project:

```json
{
  "token_type": "access",
  "exp": 1760000900,
  "iat": 1760000000,
  "jti": "9b1c0f...",
  "user_id": "7",
  "role": "CAFE_OWNER"
}
```

`exp` = expiry time, `iat` = issued at, `jti` = unique token id, `user_id` and `role` identify the user.

### 8.2 Two tokens

| | Access token | Refresh token |
|---|---|---|
| Life | 15 minutes | 1 day |
| Sent | with every API request | only to `/auth/refresh/` |
| Server check | signature + expiry (and the user is loaded from the DB) | signature + expiry + must NOT be in the blacklist table |
| Revocable | No, it just expires | Yes, via the blacklist |

Why two? A stolen access token is useful for at most 15 minutes. The long-lived refresh token is stored on the server side (as a row) so it can be revoked. This is a compromise between stateless speed and the need to log users out.

The app `token_blacklist` adds two tables:

- `OutstandingToken`: one row for every refresh token that was issued.
- `BlacklistedToken`: one row for every revoked refresh token.

**Rotation**: every refresh call returns a new access token AND a new refresh token, and the old refresh token is blacklisted. A refresh token works only once. If it is used again, the server answers 401. The frontend must therefore send one refresh call at a time ("single-flight"), otherwise a second parallel call fails and logs the user out (see `use_cases.md` UC-AUTH-002).

### 8.3 Login (UC-AUTH-001) step by step

Code: `users/views.py` `LoginView`, `users/serializers.py` `CustomTokenObtainPairSerializer`.

```python
class LoginView(TokenObtainPairView):
    permission_classes = [AllowAny]
    serializer_class = CustomTokenObtainPairSerializer
```

`LoginView` is almost empty because simplejwt's `TokenObtainPairView` already does the work. The view only picks the serializer and states that no login is needed to call it (`AllowAny` overrides the global `IsAuthenticated` default).

What happens when the client sends `{"email": "...", "password": "..."}`:

1. The view calls `serializer.is_valid(raise_exception=True)`.
2. Our serializer's `validate()` runs. It first calls `super().validate(attrs)`, which does the heavy work:
   1. Django's `authenticate()` runs. It calls `get_by_natural_key` (our case-insensitive lookup), verifies the password hash, and checks `is_active`.
   2. If anything fails: 401 `{"detail": "No active account found with the given credentials."}`. The message is the same for "no such user", "wrong password" and "inactive account", so an attacker cannot learn which emails exist (information hiding). Django also does a dummy password hash when the user does not exist, so response time does not reveal it either.
   3. On success the serializer creates a refresh token with `get_token(user)`, then builds `{"refresh": ..., "access": ...}` from it.
3. Our override of `get_token` adds the claim `role` to the token:

```python
@classmethod
def get_token(cls, user):
    token = super().get_token(user)
    token['role'] = user.role
    return token
```

   The claim is put on the refresh token. simplejwt copies custom claims from the refresh token into the access token it derives from it (four claims are not copied: `token_type`, `exp`, `jti`, `iat`; the access token gets its own; checked in `no_copy_claims` in `tokens.py`). Because the `token_blacklist` app is installed, creating the refresh token also inserts an `OutstandingToken` row.
4. Our `validate()` then adds `data['role'] = self.user.role`, so the response body is `{"access": ..., "refresh": ..., "role": ...}`. The frontend can pick the right screen at once without decoding the token.

**Important design point.** The server never trusts the `role` inside the token for authorization. On every request, `JWTAuthentication` loads the user row from the database (and rejects inactive users). The permission classes read `request.user.role` from that row. So if an admin changes a user's role or deactivates the account, the change works immediately, even though the old token still says the old role. The claim is only a convenience for the frontend.

Not built yet from the use case: the 429 login throttle (needs `ScopedRateThrottle` settings, a cache backend and `throttle_scope` on the view).

### 8.4 An authenticated request

For any view with the default settings:

1. Client sends `Authorization: Bearer <access>`.
2. `JWTAuthentication` reads the header, validates signature, expiry and token type (must be `access`), takes `user_id` from the payload, and loads the user from the database.
3. `request.user` is set. If anything fails: 401.
4. Permission classes run against `request.user`.

### 8.5 Refresh (UC-AUTH-002)

`RefreshTokenView(TokenRefreshView)` is also nearly empty. All behavior comes from the settings (`ROTATE_REFRESH_TOKENS`, `BLACKLIST_AFTER_ROTATION`). Result: a new pair, the old refresh token blacklisted.

### 8.6 Logout (UC-AUTH-003)

Code: `LogoutView.post` in `users/views.py`.

Step by step:

1. `LogoutSerializer` checks that `refresh` is present (missing: 400 from DRF automatically).
2. `RefreshToken(text)` parses and verifies the token. It raises `TokenError` if the signature is wrong, the token is expired, or the token is already blacklisted. The code answers 400 `Token is invalid or already blacklisted.`
3. Ownership check: the `user_id` claim of the token must equal the id of the logged-in user (`request.user`). Otherwise user A could revoke user B's token. In that case the SAME error response is returned, so the answer reveals nothing about the other user's token. The comparison is `token_user_id != str(...)` because simplejwt stores the claim as a string. This is true for the installed version 5.5.1 (checked in `tokens.py`); `requirements.txt` allows `>=5.3`, so a logout integration test should protect this assumption.
4. `token.blacklist()` inserts the `BlacklistedToken` row. Race: if two logouts happen at once, the second may raise `TokenError`; that is caught too.
5. Success: `205 Reset Content`. The body is empty; the status tells the client to reset its view.

Coding style to notice: **guard clauses** (return early on bad input) keep the main path flat, and one prepared `invalid_token_response` object is reused in three places (DRY: do not repeat yourself).

Remember: the access token is NOT revoked by logout. It dies by itself within 15 minutes. This is the price of stateless access tokens.

### 8.7 Change password (UC-AUTH-004)

Code: `ChangePasswordSerializer` (validation) and `ChangePasswordView` (action).

**Serializer.** A DRF `Serializer` declares fields and validation. DRF runs checks in this order:

1. Field rules (`required`, type).
2. Field hooks named `validate_<field_name>`. Here `validate_old_password` checks the old password with `user.check_password`. Failure: `{"old_password": ["Incorrect password."]}`.
3. The object-level `validate(attrs)`. It runs ONLY if the earlier steps passed. Here it checks that the new password differs from the old one, then calls Django's `validate_password(new_password, user)`, which runs the four validators from `AUTH_PASSWORD_VALIDATORS`.

Details:

- `write_only=True` means the field is accepted as input and never put in output.
- Django and DRF both have a class called `ValidationError`. The code imports Django's as `DjangoValidationError` and converts its messages to DRF's error format, keyed to `new_password`. Passing a dict to `serializers.ValidationError({...})` attaches the error to a field.
- `self.context['request']` gives the serializer access to the request. DRF's generic views fill `context` automatically. This view is a plain `APIView`, so it passes `context={'request': request}` by hand.

**View.**

```python
with transaction.atomic():
    user.set_password(serializer.validated_data['new_password'])
    user.save(update_fields=['password'])

    outstanding_tokens = OutstandingToken.objects.filter(user=user, blacklistedtoken__isnull=True)
    BlacklistedToken.objects.bulk_create(
        [BlacklistedToken(token=token) for token in outstanding_tokens],
        ignore_conflicts=True,
    )
return Response(status=status.HTTP_204_NO_CONTENT)
```

- **Transaction** (`atomic`): the new password and the token revocation must succeed together or fail together. Without it, a crash in the middle could leave the new password set while old sessions stay alive. This is the "A" (atomicity) in ACID: Atomicity, Consistency, Isolation, Durability.
- `save(update_fields=['password'])` writes only that column (`UPDATE ... SET password = ...`), so it cannot overwrite other columns changed by someone else at the same moment.
- `blacklistedtoken__isnull=True`: "this outstanding token has no blacklist row yet". Django does a LEFT JOIN and tests for NULL.
- `bulk_create` inserts all rows in ONE query. A loop with `.create()` would be one query per token (the N+1 pattern). `ignore_conflicts=True` becomes PostgreSQL `INSERT ... ON CONFLICT DO NOTHING`, so a token revoked at the same time by another request does not cause an error.
- `204 No Content`: success with no body.
- Limit: existing ACCESS tokens stay valid until they expire (at most 15 minutes). Only refresh tokens are revoked.

Why the logic sits in the view and not in `services.py`: `use_cases.md` UC-AUTH-004 says "Plain DRF view with a serializer", and UC-AUTH-001 says "No Service Layer involvement". The project applies the service layer where business rules exist (plan limits and similar).

### 8.8 Permissions

File: `users/permissions.py`. A DRF permission class has up to two methods:

- `has_permission(request, view)`: checked BEFORE the view runs (gate on the endpoint).
- `has_object_permission(request, view, obj)`: checked when the view loads one object (not used here).

If a check returns `False`, DRF raises 403 and shows the class attribute `message` as `{"detail": "..."}`.

| Class | Passes when |
|---|---|
| `IsSystemAdmin` | user is logged in AND `role == SYSTEM_ADMIN` |
| `IsCafeOwner` | logged in AND `role == CAFE_OWNER` AND the user has a cafe |
| `IsActiveCafe` | the user's cafe exists AND `cafe.is_active` is true |

Points to notice:

- `IsCafeOwner` also requires that a cafe exists, so a view can safely use `request.user.cafe` afterwards.
- Order matters. Use `permission_classes = [IsCafeOwner, IsActiveCafe]`. DRF checks the classes in order and stops at the first failure, so a non-owner receives the role message and not the misleading "subscription inactive" message. This matches Global Convention 5 in `use_cases.md`.
- Authorization uses `role`, not `is_staff` (project invariant).
- None of these classes is attached to a view yet.

---

## 9. Architecture rules and why they exist

### 9.1 The layers

```
 urls.py          maps a path to a view
 views.py         THIN: read the request, call one service, return a response
 serializers.py   validate input, shape output (no business rules)
 permissions.py   who may call (role checks)
 services.py      BUSINESS RULES: plan limits, transactions, multi-step work
 models.py        data, constraints, simple invariants
```

Dependencies point downward only: a view may call a service, a service may use models, a model never calls a view. Benefits: each file has one reason to change (the Single Responsibility Principle from SOLID); services can be tested without HTTP; the same service can later be called by a command-line job or an admin action.

Trade-off: for plain CRUD with no rules, a service is extra ceremony. The project rule: add layers where a rule exists, and add no abstraction without a second real use.

### 9.2 What a future endpoint will look like (PLANNED, not built)

`POST /api/v1/dashboard/categories/`:

1. URL -> `CategoryListCreateView`.
2. Permissions: `[IsCafeOwner, IsActiveCafe]`.
3. Serializer validates `name` (`ar` required, only keys `ar`/`en`).
4. View calls `services.create_category(cafe=request.user.cafe, data=...)`. The cafe comes from the logged-in user, never from the request body.
5. The service opens `transaction.atomic()`, locks the cafe row with `select_for_update()`, counts non-deleted categories, compares with `plan.max_categories` (a flag/limit, never the plan name), picks the next `sort_order`, creates the row.
6. View returns 201.

Why the lock: two parallel requests could both read "4 of 5 categories used" and both insert, giving 6. `select_for_update()` makes the second request wait until the first commits (a race condition fixed by a row lock; see Global Convention 8).

### 9.3 Multi-tenancy

How to keep many cafes' data in one system:

| Model | Isolation | Cost |
|---|---|---|
| Database per tenant | Strongest | Many databases to run and migrate |
| Schema per tenant | Strong | Migrations run per schema |
| **Shared tables + `cafe_id` (chosen)** | Weakest by itself; relies on correct filters | Cheapest, simplest |

Because isolation depends on every query remembering the filter, the project adds layers: take `cafe` from `request.user.cafe` only, filter every queryset by it, return 404 (not 403) for other cafes' rows, and write a cross-tenant test per endpoint. PostgreSQL row-level security (the database itself hides other cafes' rows) is planned after the MVP.

Why 404 and not 403 for another cafe's data: 403 would confirm "this id exists but is not yours". 404 gives an attacker nothing, so ids cannot be probed.

### 9.4 The project invariants (from `AGENTS.md`)

- Tenant isolation as described above.
- Soft delete for categories and items; every normal query filters `deleted_at IS NULL`.
- Plan rules live in `services.py`, decided by flags and limits.
- Admin endpoints authorize by `role == SYSTEM_ADMIN`.
- API prefix `/api/v1/`; errors are `{"detail": "..."}`; currency SYP, no currency field.
- No secrets in code; new environment variables go into `.env.example`.
- Out of MVP: `CAFE_STAFF` features, analytics, Redis, table sessions, ordering.

---

## 10. Computer science ideas behind the code

| Idea | Where it appears | One-line meaning |
|---|---|---|
| Hashing + salt + key stretching | `set_password` / `check_password` | Store a slow salted hash, never the password |
| HMAC / digital signature | JWT signature | Detect any change to the token without storing it |
| Stateless vs stateful auth | Access vs refresh token | Trade server memory for revocation power |
| RBAC (role-based access control) | `User.role`, permission classes | Rights follow the role, not the person |
| Least privilege / deny by default | default role, default `IsAuthenticated` | Start closed, open on purpose |
| Information hiding | same login error, 404 masking, same logout error | Do not leak facts through error messages |
| Fail fast / fail safe | settings checks, `DEBUG` default | Crash early or choose the safe value |
| Atomicity, ACID | `transaction.atomic()` | All steps or none |
| Race condition, locking | `select_for_update` (planned) | Serialize competing writers |
| Normalization vs denormalization | `MenuItem.cafe` | Duplicate a fact on purpose for speed/safety, then guard it |
| Constraints and indexes | `unique`, `UniqueConstraint` | The database enforces rules and speeds lookups |
| Lazy evaluation | QuerySets | Build the query first, run it once |
| N+1 queries | `bulk_create`, `cafe_id` in `__str__` | Avoid one query per row |
| Soft delete | `deleted_at`, `ActiveManager` | Mark instead of remove |
| Separation of concerns, layering | views/serializers/services/models | Each part has one job |
| Dependency direction | apps and layers | Dependencies point one way, no cycles |
| REST and HTTP semantics | 204, 205, 401, 403, 404, 429 | Use standard codes so clients behave correctly |
| Same-origin policy, CORS, CSRF | settings, middleware | Browser security model |
| Twelve-factor config | environment variables | Same code, different environment |
| Floating point error | `DecimalField` for price | Money needs exact decimals |
| Graph / DAG | migration dependencies | Order by dependency |

---

## 11. Known gaps and open points (snapshot facts, nothing changed)

These are facts found while reading the code. They are listed so you know them; they are not edits.

1. `core/settings.py` sets `WSGI_APPLICATION = 'core.wsgi.application'`, but `core/wsgi.py` and `core/asgi.py` do not exist. Gunicorn (production server) could not start yet. `manage.py check` still passes.
2. There is no `__init__.py` in `core/`, `users/`, `cafes/`, `menu/` (only in the `migrations/` folders). Python 3 accepts such folders as "namespace packages", and Django works with them today, but this is unusual.
3. The app URL files are missing and `core/urls.py` only has `admin/`. The four auth views exist but cannot be reached over HTTP.
4. `system_design.md` section 2.2 lists database CHECK rules (`table_number` 1..200, `price >= 0`, `primary_color` pattern). The models have a validator for `table_number` only; there are no `CheckConstraint`s.
5. `requirements.txt` has `gunicorn>=21.2,<22.0` and `Pillow>=11.3,<13.0`, while `system_design.md` section 7 asks for `gunicorn>=23` and `Pillow>=12.3`.
6. `.env.example` does not exist, though `settings.py` reads about fifteen environment variables.
7. `backend/core/__pycache__/settings.cpython-314.pyc` is tracked by git (compiled Python files should not be committed).
8. `docs/system_design.md` names the user table `users`; Django names it `users_user` because the model sets no `db_table`.
9. Admin site: `admin/` is the default path. The design plans a hidden path from `DJANGO_ADMIN_PATH`.

---

## 12. Glossary

| Term | Meaning |
|---|---|
| API / endpoint | A URL the frontend can call to read or change data |
| App (Django) | A feature module inside a Django project |
| Atomic | All steps happen or none happen |
| Authentication | Proving identity |
| Authorization | Deciding allowed actions |
| Blacklist (token) | A list of revoked tokens |
| BFF | Backend For Frontend: the Next.js server sits between the browser and Django and keeps tokens in HttpOnly cookies |
| Claim | One fact inside a JWT payload |
| CORS | Browser rule and headers for cross-site reads |
| CSRF | Attack that makes a logged-in browser send an unwanted request |
| Denormalization | Storing a fact in two places on purpose |
| FK / PK | Foreign key / primary key |
| Hash | One-way function; same input gives same output, cannot be reversed |
| ISR | Incremental Static Regeneration: Next.js caches a page and rebuilds it later |
| JSONB | PostgreSQL's binary JSON column type |
| JWT | A signed token with three dot-separated parts |
| Manager | The object behind `Model.objects` |
| Middleware | Code that wraps every request and response |
| Migration | A versioned description of a schema change |
| Mixin | A small parent class that adds one ability |
| ORM | Object-relational mapper: tables as Python classes |
| QuerySet | A lazy, chainable database query |
| Race condition | A bug that depends on the timing of two actions |
| RBAC | Role-based access control |
| Rotation (token) | Issue a new refresh token on each refresh and revoke the old one |
| Salt | Random text added before hashing a password |
| Serializer | Validates input and converts objects to/from JSON |
| Service layer | Functions that hold business rules |
| Soft delete | Mark a row as deleted instead of removing it |
| Tenant | One customer organization using a shared system (here: a cafe) |
| Throttle | Limit on how often a client may call an endpoint |
| Transaction | A group of database steps treated as one |
| WSGI | Standard interface between Python web apps and web servers |

---

## 13. Study path and exercises

### 13.1 Reading order (about 2 hours)

1. `docs/use_cases.md`: Global Conventions and UC-AUTH-001 to 004.
2. `docs/system_design.md`: sections 2 (schema) and 3.1 (auth API).
3. `backend/users/models.py`
4. `backend/users/serializers.py`
5. `backend/users/views.py`
6. `backend/users/permissions.py`
7. `backend/cafes/models.py`, then `backend/menu/models.py`
8. `backend/core/settings.py`
9. The three `0001_initial.py` migration files.

### 13.2 Predict, then check

For each question, write your answer first, then find the proof in the code.

1. A user logs in with `OWNER@Cafe.com`, but the account was created as `owner@cafe.com`. Does login work? Which method makes it work?
2. A Cafe Owner whose cafe is inactive calls `POST /auth/change-password/`. What happens, and which sentence in `use_cases.md` says so?
3. An admin changes a user's role to `SYSTEM_ADMIN`. The user still holds an old access token that says `CAFE_OWNER`. Which role does `IsSystemAdmin` see? Why?
4. A category is soft-deleted. Does `Category.objects.all()` return it? Does `Category.all_objects.all()`?
5. What stops two cafes from both having a table number 5? What stops one cafe from having it twice?
6. What would break if `ChangePasswordView` saved the password but crashed before blacklisting the tokens, and the `atomic()` block were missing?
7. Why does `LogoutView` return the same 400 for a foreign token and for an expired token?

### 13.3 Hands-on (needs PostgreSQL running and `migrate` applied)

Run from `backend/` with the venv active.

Look at a password hash:

```python
# python manage.py shell
from users.models import User
u = User.objects.create_user(email="Demo@Cafe.com", password="a-long-test-pass-1")
print(u.email)          # note the lowercase
print(u.password)       # algorithm$iterations$salt$hash
print(u.check_password("a-long-test-pass-1"))
```

Decode the payload of a token (a JWT payload is only base64, not secret):

```python
import base64, json
token = "<paste an access token here>"
payload = token.split(".")[1]
payload += "=" * (-len(payload) % 4)
print(json.loads(base64.urlsafe_b64decode(payload)))
```

Print the SQL a queryset would run (nothing hits the database):

```python
from menu.models import Category
print(Category.objects.filter(cafe_id=1).query)
```

Look for `"deleted_at" IS NULL` in the output.

### 13.4 Explain it back

Write 5 to 10 lines for each of: the login flow, the logout flow, the soft-delete manager, tenant isolation. Send them for review. Explaining in your own words is the strongest way to learn.
