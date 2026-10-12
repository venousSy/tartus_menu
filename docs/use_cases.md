# Use Cases — Tartus Smart Digital Menu

## Table of Contents

### Auth
- [UC-AUTH-001] Login
- [UC-AUTH-002] Refresh Token
- [UC-AUTH-003] Logout
- [UC-AUTH-004] Change Password

### Super Admin
- [UC-ADMIN-001] Create Cafe
- [UC-ADMIN-002] List Cafes
- [UC-ADMIN-003] View Cafe Details
- [UC-ADMIN-004] Activate Subscription
- [UC-ADMIN-005] Deactivate Subscription
- [UC-ADMIN-006] Edit Cafe
- [UC-ADMIN-007] Delete Cafe
- [UC-ADMIN-008] View Billing History
- [UC-ADMIN-009] View Platform Stats

### Cafe Owner
- [UC-OWNER-001] Manage Categories
- [UC-OWNER-002] Manage Menu Items
- [UC-OWNER-003] Reorder Categories
- [UC-OWNER-004] Reorder Menu Items
- [UC-OWNER-005] Toggle Item Availability
- [UC-OWNER-006] Upload Item Image
- [UC-OWNER-007] Generate QR Codes
- [UC-OWNER-008] Download QR PDF
- [UC-OWNER-009] Update Cafe Settings
- [UC-OWNER-010] Upload Cafe Logo
- [UC-OWNER-011] Preview QR Codes
- [UC-OWNER-012] List Categories
- [UC-OWNER-013] List Menu Items
- [UC-OWNER-014] View Cafe Settings

### Customer (Guest)
- [UC-GUEST-001] View Public Menu
- [UC-GUEST-002] View Inactive Cafe Screen


---

## Global Conventions

These rules apply to every use case in this document. If a use case seems to contradict them, these rules win.

**1. Actors and roles**

| Actor name used in this document | User.role value | Notes |
|---|---|---|
| Super Admin | SYSTEM_ADMIN | Platform operator. Authorization for all /api/v1/admin/ endpoints is decided by role = SYSTEM_ADMIN. is_staff = true is set for these users only so they can open the Django admin site. |
| Cafe Owner | CAFE_OWNER | Owns exactly one cafe. |
| Customer (Guest) | none | Unauthenticated visitor. |

The User model also defines the role CAFE_STAFF. CAFE_STAFF is OUT OF SCOPE for the MVP: no use case covers it and no endpoint grants it any access.

**2. HTTP status rules**

- 400 Bad Request: validation failure.
- 401 Unauthorized: missing, invalid or expired credentials or token.
- 403 Forbidden: the caller is authenticated but not allowed because of role, plan or subscription status.
- 404 Not Found: the resource does not exist OR belongs to another cafe. A cafe-scoped endpoint must never answer 403 for a resource owned by another cafe (ownership masking). The body is always {"detail": "Not found."}.
- 429 Too Many Requests: a rate limit was exceeded (see UC-AUTH-001). The body is DRF's standard throttle message: {"detail": "Request was throttled. Expected available in N seconds."}.

**3. Plan limits and plan features**

- Plan limits count only rows with deleted_at IS NULL. Hidden categories (is_visible = false) and unavailable items (is_available = false) DO count.
- A NULL limit (max_categories or max_items) means unlimited.
- Features are enforced by plan flags, never by plan name: allows_images (item images) and allows_branding (logo and primary color).
- Changing a slug is not a plan feature: only a Super Admin can change a cafe slug.

**4. Public menu URL**

https://menu.domain.com/menu/[cafe-slug]?table=N — the table parameter is display-only.

**5. Active cafe (subscription) rule**

- Every /api/v1/dashboard/ endpoint requires the owner's cafe to be active (cafe.is_active = true). The only exception is GET /api/v1/dashboard/settings/ (UC-OWNER-014), which answers 200 even when the cafe is inactive.
- An inactive cafe gets 403 Forbidden — {"detail": "Your subscription is inactive. Please contact support."}.
- The role check runs first, then the active check. A caller who is not a Cafe Owner gets the role error, never the subscription message.
- Auth endpoints (/api/v1/auth/) never check the subscription. The owner of an inactive cafe can still log in, refresh, log out and change the password.

**6. Bilingual text fields**

The fields name (cafes, categories, menu items) and description (menu items) are JSON objects with the keys "ar" (Arabic) and "en" (English).

- name: "ar" is required and must be a non-empty string. "en" is optional: it may be missing or an empty string.
- description: optional. When present, "ar" and "en" are both optional strings.
- Any other key is rejected: 400 Bad Request — {"<field>": ["Only the keys \"ar\" and \"en\" are allowed."]}.
- Other validation errors (missing or blank "ar", a value that is not a string) use DRF's standard field-level errors under the field name, for example {"name": {"ar": ["This field is required."]}}.
- Display fallback: when the reader chose English and the "en" value is missing or empty, the "ar" value is shown.

**7. Plan features after a plan change**

- A plan change never deletes stored feature data. Item images (image_url), the logo (logo_url) and the primary color (primary_color) stay in the database and on R2.
- The public menu (UC-GUEST-001) shows them only while the current plan allows them: image_url is returned as "" when plan.allows_images is false; logo_url and primary_color are returned as "" when plan.allows_branding is false (the frontend then uses the default theme).
- Dashboard responses (UC-OWNER-013, UC-OWNER-014) return the stored values together with the plan flags, so the UI can explain that they are hidden on the current plan.
- Upgrading again makes the stored values visible again. Nothing has to be uploaded again.
- An empty string "" means "none" for image_url, logo_url and primary_color. These fields never use NULL.

**8. Concurrency**

Every service operation that checks a plan limit, assigns a sort_order, reorders rows or syncs tables runs inside one database transaction and first locks the cafe row (SELECT ... FOR UPDATE, Django select_for_update()). A second request for the same cafe waits until the first one commits. This stops two parallel requests from both passing a limit check or receiving the same sort_order. Requests for other cafes are not blocked.

**9. Public menu freshness**

The customer menu page is cached by Next.js (ISR). To keep it fresh:

- After the database commit of every successful write that changes what the public menu shows, the backend asks the frontend to revalidate (rebuild) the page /menu/[slug] of that cafe (system_design.md §3.5).
- Triggers: UC-OWNER-001 to UC-OWNER-006, UC-OWNER-009, UC-OWNER-010, UC-ADMIN-004, UC-ADMIN-005, UC-ADMIN-006 and UC-ADMIN-007. When UC-ADMIN-006 changes the slug, both the old and the new slug are revalidated.
- The call runs after the commit and never changes the API response. If it fails, the error is logged and the request still succeeds.
- Fallback: the page is also rebuilt on a time basis at most every 5 minutes, so a lost call heals itself.
- Expected result: a change is visible on the public menu within a few seconds.

**10. Prices**

- Prices are in Syrian pounds (SYP) after the redenomination of 2026-01-01 (100 old pounds = 1 new pound; the ISO code stays SYP). The currency is hardcoded; there is no currency field.
- Stored as NUMERIC(10,2). A price must be 0 or greater. The API returns the price as a string with two decimals, for example "50.00".
- Display rule (frontend): Western digits (0-9) in both languages, trailing ".00" hidden ("50", "12.50"), followed by the currency label (the Arabic abbreviation of Syrian pound in Arabic, "SYP" in English).

---

## AUTH Use Cases

---

### UC-AUTH-001 — Login

> **As any registered user (Super Admin or Cafe Owner), I want to log in with my email and password so that I receive a JWT access token and can access protected resources.**

| Field | Value |
|---|---|
| **Actor** | Super Admin, Cafe Owner |
| **Trigger** | User submits credentials on the login form |
| **Preconditions** | User account exists and is active (is_active = true) |
| **Postconditions (Success)** | JWT access token + refresh token are returned; role field contains the stored User.role value in uppercase (for example SYSTEM_ADMIN or CAFE_OWNER) |
| **Postconditions (Failure)** | No tokens issued; error message returned |
| **API** | POST /api/v1/auth/login/ |
| **Architectural Note** | Handled by simplejwt. The role field is injected via a custom token serializer. No Service Layer involvement. Rate limited with DRF ScopedRateThrottle (scope "login", default 5 requests per minute per client IP, configurable with the LOGIN_THROTTLE_RATE environment variable). Throttle counters are stored in Django's DatabaseCache, which all Gunicorn workers share (no Redis). Behind the proxies, the client IP is read from X-Forwarded-For with DRF NUM_PROXIES (system_design.md §3.6). Nginx adds a second limit (limit_req) in front of the API. |

**Main Flow:**
1. User provides email and password.
2. System validates credentials against the User table.
3. System generates a short-lived access token (15 min) and a refresh token (1 day).
4. System returns { access, refresh, role }.

**Alternate Flows:**
- **A1 — Wrong credentials:** System returns 401 Unauthorized with {"detail": "No active account found with the given credentials."}.
- **A2 — Inactive account:** System returns 401 Unauthorized. (Admin must re-activate the account.)
- **A3 — Missing fields:** System returns 400 Bad Request with field-level validation errors.
- **A4 — Too many attempts:** 429 Too Many Requests — {"detail": "Request was throttled. Expected available in N seconds."} (N = seconds until a new attempt is allowed). Every attempt counts, successful or not.

---

### UC-AUTH-002 — Refresh Access Token

> **As any authenticated user, I want to exchange my refresh token for a new access token so that my session stays alive without re-entering credentials.**

| Field | Value |
|---|---|
| **Actor** | Super Admin, Cafe Owner |
| **Trigger** | Client detects that the access token has expired (or pre-emptively refreshes) |
| **Preconditions** | A valid, non-blacklisted refresh token exists |
| **Postconditions (Success)** | A new access token and a new refresh token are returned; the submitted refresh token is blacklisted |
| **API** | POST /api/v1/auth/refresh/ |
| **Architectural Note** | Handled by simplejwt with ROTATE_REFRESH_TOKENS = True and BLACKLIST_AFTER_ROTATION = True. Requires rest_framework_simplejwt.token_blacklist in INSTALLED_APPS. Refresh token lifetime: 1 day. Because each refresh token works only once, the frontend (Next.js BFF, system_design.md §3.6) must run at most one refresh call at a time per session (single-flight) and let other waiting requests reuse its result. Otherwise a parallel refresh gets 401 (A2) and logs the user out. |

**Main Flow:**
1. Client sends { refresh: "<token>" }.
2. System validates the refresh token (not expired, not blacklisted).
3. System returns a new { access, refresh } pair and blacklists the submitted refresh token.

**Alternate Flows:**
- **A1 — Expired refresh token:** 401 Unauthorized. User must log in again.
- **A2 — Blacklisted token (after logout, or already used once and rotated):** 401 Unauthorized.

---

### UC-AUTH-003 — Logout

> **As any authenticated user, I want to log out so that my refresh token is invalidated and cannot be reused.**

| Field | Value |
|---|---|
| **Actor** | Super Admin, Cafe Owner |
| **Trigger** | User clicks "Logout" |
| **Preconditions** | User holds a valid refresh token |
| **Postconditions (Success)** | Refresh token is blacklisted; subsequent refresh attempts fail |
| **API** | POST /api/v1/auth/logout/ |
| **Architectural Note** | Uses simplejwt token blacklisting. Requires INSTALLED_APPS to include rest_framework_simplejwt.token_blacklist. |

**Main Flow:**
1. Client sends { refresh: "<token>" } with the Authorization header.
2. System blacklists the refresh token.
3. System returns 205 Reset Content.

**Alternate Flows:**
- **A1 — Already blacklisted token:** 400 Bad Request — token is already invalid.
- **A2 — Missing token:** 400 Bad Request.

---

### UC-AUTH-004 — Change Password

> **As any authenticated user, I want to change my password so that I can replace the initial password given to me by the Super Admin.**

| Field | Value |
|---|---|
| **Actor** | Super Admin, Cafe Owner |
| **Trigger** | User submits the change-password form |
| **Preconditions** | User is authenticated with a valid access token |
| **Postconditions (Success)** | Password is changed; all outstanding refresh tokens of the user are blacklisted; the user must log in again |
| **API** | POST /api/v1/auth/change-password/ |
| **Architectural Note** | Plain DRF view with a serializer. The new password is checked with Django's AUTH_PASSWORD_VALIDATORS. Blacklisting all outstanding tokens requires rest_framework_simplejwt.token_blacklist in INSTALLED_APPS. |

**Main Flow:**
1. User sends { old_password, new_password }.
2. System verifies old_password against the stored hash.
3. System validates new_password with the configured password validators.
4. System saves the new password and blacklists every outstanding refresh token of the user.
5. System returns 204 No Content.

**Alternate Flows:**
- **A1 — Wrong old_password:** 400 Bad Request — {"old_password": ["Incorrect password."]}.
- **A2 — new_password fails validation:** 400 Bad Request — {"new_password": [<validator messages>]}.
- **A3 — new_password equals old_password:** 400 Bad Request — {"new_password": ["The new password must be different from the old password."]}.
- **A4 — Missing fields:** 400 Bad Request with field-level errors.
- **A5 — Unauthenticated:** 401 Unauthorized.

---

## ADMIN Use Cases

---

### UC-ADMIN-001 — Create Cafe

> **As a Super Admin, I want to create a new cafe account (with its owner user) so that a cafe can start using the platform.**

| Field | Value |
|---|---|
| **Actor** | Super Admin (role = SYSTEM_ADMIN) |
| **Trigger** | Admin fills the "Create Cafe" form and submits |
| **Preconditions** | Admin is authenticated with a valid JWT |
| **Postconditions (Success)** | A new Cafe record and a new User record (role=CAFE_OWNER) are created atomically; cafe is_active = false by default |
| **API** | POST /api/v1/admin/cafes/ |
| **Architectural Note** | Executed in a **Service Layer** method (CafeService.create_cafe()), wrapped in a DB transaction (atomic). The owner User is created first; if it fails, the cafe is not created. |

**Main Flow:**
1. Admin provides: slug, name (ar/en), plan, owner.email, owner.password.
2. System validates slug uniqueness and email uniqueness.
3. System creates the User (role=CAFE_OWNER) and the Cafe (linked to that user, inactive).
4. System returns the full cafe detail object with is_active: false.

**Alternate Flows:**
- **A1 — Duplicate slug:** 400 Bad Request — {"slug": ["A cafe with this slug already exists."]}.
- **A2 — Duplicate owner email:** 400 Bad Request — {"owner.email": ["A user with this email already exists."]}.
- **A3 — Invalid plan name:** 400 Bad Request.
- **A4 — Non-admin caller:** 403 Forbidden.
- **A5 — Invalid name (for example missing or blank "ar", or an unknown key):** 400 Bad Request with field-level errors under name (Global Convention 6).

---

### UC-ADMIN-002 — List All Cafes

> **As a Super Admin, I want to see a paginated list of all cafes so that I can monitor the platform and manage each cafe.**

| Field | Value |
|---|---|
| **Actor** | Super Admin |
| **Trigger** | Admin navigates to the Cafe List screen |
| **Preconditions** | Admin is authenticated |
| **Postconditions (Success)** | Returns a paginated list of cafes with summary fields (id, name, slug, plan, is_active, owner email) |
| **API** | GET /api/v1/admin/cafes/ |
| **Architectural Note** | Queryset returns all cafes (no cafe_id filter — admin sees everything). Pagination via DRF PageNumberPagination. |

**Main Flow:**
1. Admin sends GET request (optional: ?page=2&search=tartus).
2. System returns paginated list of cafes sorted by created_at DESC.

**Alternate Flows:**
- **A1 — No cafes yet:** Returns { count: 0, results: [] } with 200 OK.
- **A2 — Non-admin caller:** 403 Forbidden.

---

### UC-ADMIN-003 — View Cafe Details

> **As a Super Admin, I want to view the full details of a specific cafe so that I can review its configuration, plan, and subscription status.**

| Field | Value |
|---|---|
| **Actor** | Super Admin |
| **Trigger** | Admin clicks on a cafe in the list |
| **Preconditions** | Cafe exists |
| **API** | GET /api/v1/admin/cafes/{id}/ |

**Main Flow:**
1. Admin requests cafe by ID.
2. System returns full cafe object: name, slug, plan, is_active, subscription dates, logo_url, primary_color, owner email.

**Alternate Flows:**
- **A1 — Cafe not found:** 404 Not Found.
- **A2 — Non-admin caller:** 403 Forbidden.

---

### UC-ADMIN-004 — Activate Subscription

> **As a Super Admin, I want to activate a cafe's subscription so that the cafe owner can use the platform and their menu becomes publicly visible.**

| Field | Value |
|---|---|
| **Actor** | Super Admin |
| **Trigger** | Admin clicks "Activate" on a cafe detail page |
| **Preconditions** | Cafe exists; is_active = false |
| **Postconditions (Success)** | cafe.is_active = true; subscription_start_at set to now; a BillingEvent (action='activated') is created |
| **API** | POST /api/v1/admin/cafes/{id}/activate/ |
| **Architectural Note** | Service Layer method CafeService.activate(cafe, performed_by). Wrapped in atomic. Creates the BillingEvent audit record in the same transaction. |

**Main Flow:**
1. Admin triggers activation.
2. Service sets is_active = true, subscription_start_at = now().
3. Service creates BillingEvent(action='activated', performed_by=admin).
4. Returns updated cafe object.

**Alternate Flows:**
- **A1 — Cafe already active:** 400 Bad Request — {"detail": "Cafe is already active."}.
- **A2 — Cafe not found:** 404 Not Found.
- **A3 — Non-admin caller:** 403 Forbidden.

---

### UC-ADMIN-005 — Deactivate Subscription

> **As a Super Admin, I want to deactivate a cafe's subscription so that their public menu is hidden and they lose dashboard access.**

| Field | Value |
|---|---|
| **Actor** | Super Admin |
| **Trigger** | Admin clicks "Deactivate" on a cafe detail page |
| **Preconditions** | Cafe exists; is_active = true |
| **Postconditions (Success)** | cafe.is_active = false; subscription_end_at set to now; a BillingEvent (action='deactivated') is created |
| **API** | POST /api/v1/admin/cafes/{id}/deactivate/ |
| **Architectural Note** | Mirror of UC-ADMIN-004. Service Layer enforces atomicity. |

**Main Flow:**
1. Admin triggers deactivation.
2. Service sets is_active = false, subscription_end_at = now().
3. Service creates BillingEvent(action='deactivated', performed_by=admin).
4. Returns updated cafe object.

**Alternate Flows:**
- **A1 — Cafe already inactive:** 400 Bad Request — {"detail": "Cafe is already inactive."}.
- **A2 — Cafe not found:** 404 Not Found.

---

### UC-ADMIN-006 — Edit Cafe

> **As a Super Admin, I want to update a cafe's details or subscription plan so that I can correct mistakes or upgrade/downgrade their tier.**

| Field | Value |
|---|---|
| **Actor** | Super Admin |
| **Trigger** | Admin edits cafe fields and submits |
| **Preconditions** | Cafe exists |
| **Postconditions (Success)** | Cafe record updated; if plan changed, a BillingEvent(action='plan_changed') is created |
| **API** | PATCH /api/v1/admin/cafes/{id}/ |
| **Architectural Note** | Service Layer checks if plan field changed and conditionally creates the BillingEvent. This keeps the audit trail clean. is_active cannot be changed through this endpoint; use UC-ADMIN-004 and UC-ADMIN-005 so that a BillingEvent is always recorded. Changing the slug invalidates every QR code already printed for the cafe (there is no redirect from the old slug in the MVP). logo_url cannot be changed through this endpoint: logos come only from the owner's upload (UC-OWNER-010), so every logo is a validated file on our R2 storage. A primary_color set by the Super Admin is stored even when the plan has allows_branding = false; it stays hidden from customers until the plan allows it (Global Convention 7). |

**Main Flow:**
1. Admin sends partial update (any combination of: name, slug, primary_color, plan).
2. System validates slug uniqueness (if changed).
3. If plan changed, system logs a BillingEvent.
4. Returns updated cafe.

**Alternate Flows:**
- **A1 — Duplicate slug:** 400 Bad Request.
- **A2 — Downgrading plan while cafe exceeds new limits:** 400 Bad Request — Service Layer enforces this. Only non-deleted categories and items are counted. e.g., "Cannot downgrade to Basic: cafe has 8 categories (max 5)." Item images, the logo and the primary color never block a downgrade: they are kept and hidden from customers (Global Convention 7).
- **A3 — Request body contains is_active:** 400 Bad Request — {"is_active": ["Use the activate or deactivate endpoint."]}.
- **A4 — Request body contains logo_url:** 400 Bad Request — {"logo_url": ["This field cannot be changed here. The cafe owner uploads the logo."]}.
- **A5 — primary_color is not "#RRGGBB" or "":** 400 Bad Request — {"primary_color": ["Enter a color in #RRGGBB format."]}.
- **A6 — Invalid name:** 400 Bad Request with field-level errors under name (Global Convention 6).
- **A7 — Cafe not found:** 404 Not Found.

---

### UC-ADMIN-007 — Delete Cafe

> **As a Super Admin, I want to permanently delete a cafe so that all its data is removed from the platform.**

| Field | Value |
|---|---|
| **Actor** | Super Admin |
| **Trigger** | Admin confirms deletion in a dialog |
| **Preconditions** | Cafe exists |
| **Postconditions (Success)** | Cafe, its owner user account, and all related data (categories, menu items, tables, billing events) are hard-deleted |
| **API** | DELETE /api/v1/admin/cafes/{id}/ |
| **Architectural Note** | Hard delete — no soft delete for cafes per the design. Service Layer method CafeService.delete_cafe(cafe) runs in one DB transaction (atomic): it deletes the cafe (DB CASCADE removes categories, menu items, cafe tables and billing events) and then deletes the owner User, so no orphan account remains. Irreversible. Billing history is deleted together with the cafe. After the commit, the backend deletes every R2 object under the prefix cafes/<cafe_id>/ (item images and logos, see UC-OWNER-006). This cleanup is best effort: a failure is logged and the response is still 204. |

**Main Flow:**
1. Admin confirms deletion.
2. System deletes the Cafe record and its owner User in one transaction.
3. PostgreSQL CASCADE deletes all related categories, items, tables, and billing events.
4. Returns 204 No Content.

**Alternate Flows:**
- **A1 — Cafe not found:** 404 Not Found.

---

### UC-ADMIN-008 — View Billing History

> **As a Super Admin, I want to see the billing event history for a cafe so that I have a full audit trail of activations, deactivations, and plan changes.**

| Field | Value |
|---|---|
| **Actor** | Super Admin |
| **Trigger** | Admin clicks "Billing History" on a cafe detail page |
| **Preconditions** | Cafe exists |
| **Postconditions (Success)** | Returns a list of BillingEvent records sorted by created_at DESC |
| **API** | GET /api/v1/admin/cafes/{id}/billing/ |
| **Architectural Note** | Billing events are deleted together with the cafe (UC-ADMIN-007). The history covers the lifetime of the cafe only. |

**Main Flow:**
1. Admin requests billing history for a cafe.
2. System returns list: [{ action, notes, performed_by_email, created_at }].

**Alternate Flows:**
- **A1 — No events yet:** Returns empty list [].
- **A2 — Cafe not found:** 404 Not Found.

---

### UC-ADMIN-009 — View Platform Stats

> **As a Super Admin, I want to see summary statistics for the whole platform so that I can monitor growth and subscription health.**

| Field | Value |
|---|---|
| **Actor** | Super Admin |
| **Trigger** | Admin opens the dashboard home page |
| **API** | GET /api/v1/admin/stats/ |
| **Architectural Note** | Computed with simple Django ORM aggregations. No caching in MVP — acceptable given low admin traffic. |

**Main Flow:**
1. Admin requests stats.
2. System returns: { total_cafes, active_cafes, inactive_cafes, basic_plan_count, pro_plan_count }.


---

## OWNER Use Cases

---

### UC-OWNER-001 — Manage Categories (Create / Edit / Hide / Delete)

> **As a Cafe Owner, I want to create, edit, hide, and delete categories so that I can organize my menu structure.**

| Field | Value |
|---|---|
| **Actor** | Cafe Owner |
| **Trigger** | Owner interacts with the Categories screen in their dashboard |
| **Preconditions** | Owner is authenticated; cafe is_active = true; plan limits not exceeded (for create) |
| **Postconditions (Success)** | Category is created / updated / soft-deleted (together with its items); sort_order assigned automatically (gapped: 100, 200, ...) |
| **APIs** | POST /api/v1/dashboard/categories/ · PATCH /api/v1/dashboard/categories/{id}/ · DELETE /api/v1/dashboard/categories/{id}/ |
| **Architectural Note** | Service Layer (CategoryService) enforces plan limits on CREATE. Soft delete sets deleted_at = now() and excludes the category from all future queries. cafe_id is injected from request.user.cafe — never from the request body (security). Soft-deleted categories and items never count toward plan limits. The plan-limit check and the sort_order assignment run under the cafe row lock (Global Convention 8). name follows Global Convention 6. |

**Main Flow (Create):**
1. Owner provides name (ar/en) and optional is_visible.
2. Service checks plan limit: if plan.max_categories is not NULL and the number of this cafe's categories with deleted_at IS NULL is >= plan.max_categories, reject.
3. Service assigns sort_order = (max_current_sort_order + 100).
4. Category is saved and returned.

**Main Flow (Edit):**
1. Owner provides updated name and/or is_visible.
2. Service validates ownership (category.cafe_id == request.user.cafe.id).
3. Category is updated and returned.

**Main Flow (Delete):**
1. Owner requests deletion.
2. Service, in one transaction, sets deleted_at = now() on the category and on every item of that category whose deleted_at IS NULL (same timestamp).
3. Returns 204 No Content.

**Alternate Flows:**
- **A1 — Plan limit exceeded (Basic):** 403 Forbidden — {"detail": "Your Basic plan allows a maximum of 5 categories. Upgrade to Pro for unlimited."}.
- **A2 — Category belongs to another cafe:** 404 Not Found (ownership masking — attacker sees no difference from "not found").
- **A3 — Cafe inactive:** 403 Forbidden — {"detail": "Your subscription is inactive. Please contact support."}.
- **A4 — Invalid name:** 400 Bad Request with field-level errors under name (Global Convention 6).

---

### UC-OWNER-002 — Manage Menu Items (Create / Edit / Delete)

> **As a Cafe Owner, I want to create, edit, and delete menu items within a category so that my menu reflects my actual offerings.**

| Field | Value |
|---|---|
| **Actor** | Cafe Owner |
| **Trigger** | Owner interacts with the Items screen in their dashboard |
| **Preconditions** | Owner is authenticated; cafe active; category exists and belongs to this cafe |
| **Postconditions (Success)** | Item created/updated/soft-deleted |
| **APIs** | POST /api/v1/dashboard/items/ · PATCH /api/v1/dashboard/items/{id}/ · DELETE /api/v1/dashboard/items/{id}/ |
| **Architectural Note** | cafe_id is denormalized on menu_items for RLS performance. The Service Layer (ItemService) validates: (1) category ownership, (2) item plan limits, (3) image upload permission (plan.allows_images must be true). The plan-limit check and the sort_order assignment run under the cafe row lock (Global Convention 8). name and description follow Global Convention 6; price follows Global Convention 10. image_url, sort_order and cafe are read-only here and ignored if sent: images are set only through UC-OWNER-006, order only through UC-OWNER-004, and the cafe always comes from request.user.cafe. |

**Main Flow (Create):**
1. Owner provides: category_id, name (ar/en), description (ar/en), price, is_featured, is_new.
2. Service validates category_id belongs to this cafe.
3. Service checks item limit: if plan.max_items is not NULL and the number of this cafe's items with deleted_at IS NULL is >= plan.max_items, reject.
4. Service assigns sort_order.
5. Item saved. Returns item object.

**Main Flow (Edit):**
1. Owner provides partial update fields.
2. Service validates ownership.
3. Item updated and returned.

**Main Flow (Delete):**
1. Service soft-deletes by setting deleted_at = now().
2. Returns 204 No Content.

**Alternate Flows:**
- **A1 — Plan item limit exceeded (Basic):** 403 Forbidden.
- **A2 — Category not found or belongs to another cafe:** 404 Not Found.
- **A3 — Price is negative:** 400 Bad Request.
- **A4 — Invalid name or description:** 400 Bad Request with field-level errors (Global Convention 6).
- **A5 — Cafe inactive:** 403 Forbidden — {"detail": "Your subscription is inactive. Please contact support."} (Global Convention 5).

---

### UC-OWNER-003 — Reorder Categories

> **As a Cafe Owner, I want to drag and drop categories to change their display order so that I can highlight important sections first.**

| Field | Value |
|---|---|
| **Actor** | Cafe Owner |
| **Trigger** | Owner finishes a drag-and-drop reorder and it auto-saves |
| **Preconditions** | At least 2 categories exist |
| **Postconditions (Success)** | sort_order values are updated using the Gapped Integer algorithm |
| **API** | POST /api/v1/dashboard/categories/reorder/ |
| **Architectural Note** | Body: { ordered_ids: [3, 1, 2] }. Service reassigns sort_order as 100, 200, 300.... Uses bulk_update() for efficiency. All IDs must belong to this cafe — partial ownership = reject all. Runs under the cafe row lock (Global Convention 8). |

**Main Flow:**
1. Client sends the full ordered list of category IDs.
2. Service validates all IDs belong to this cafe.
3. Service bulk-updates sort_order (first item gets 100, second gets 200, etc.).
4. Returns 200 OK with updated categories.

**Alternate Flows:**
- **A1 — ID list contains a foreign category:** 404 Not Found — {"detail": "Not found."}; the entire operation is rejected and nothing is updated.
- **A2 — ID list is incomplete (missing categories):** 400 Bad Request — must include all non-deleted categories.
- **A3 — Cafe inactive:** 403 Forbidden — {"detail": "Your subscription is inactive. Please contact support."} (Global Convention 5).

---

### UC-OWNER-004 — Reorder Menu Items

> **As a Cafe Owner, I want to reorder items within a category so that I can control which items appear first.**

| Field | Value |
|---|---|
| **Actor** | Cafe Owner |
| **Trigger** | Owner reorders items via drag-and-drop |
| **API** | POST /api/v1/dashboard/items/reorder/ |
| **Architectural Note** | Same Gapped Integer algorithm as UC-OWNER-003. Items can only be reordered within a single category per call. Runs under the cafe row lock (Global Convention 8). |

**Main Flow:**
1. Client sends { ordered_ids: [12, 10, 11] }.
2. Service validates all item IDs belong to this cafe.
3. Service bulk-updates sort_order.
4. Returns updated items list.

**Alternate Flows:**
- **A1 — IDs span multiple categories:** 400 Bad Request — reorder must be within one category.
- **A2 — Foreign item ID included:** 404 Not Found — {"detail": "Not found."}; the entire operation is rejected and nothing is updated.
- **A3 — Cafe inactive:** 403 Forbidden — {"detail": "Your subscription is inactive. Please contact support."} (Global Convention 5).

---

### UC-OWNER-005 — Toggle Item Availability

> **As a Cafe Owner, I want to instantly toggle an item's availability on/off so that customers don't see sold-out items.**

| Field | Value |
|---|---|
| **Actor** | Cafe Owner |
| **Trigger** | Owner taps the availability toggle on an item |
| **Preconditions** | Item exists and belongs to this cafe |
| **Postconditions (Success)** | is_available is set to the sent value; the change appears on the public menu within a few seconds through on-demand revalidation (Global Convention 9) |
| **API** | PATCH /api/v1/dashboard/items/{id}/availability/ |
| **Architectural Note** | Dedicated endpoint (not the general PATCH) to signal intent clearly and allow optimistic UI updates. Body: { is_available: false }. Service updates only this field. |

**Main Flow:**
1. Owner sends { is_available: false } (or true).
2. Service updates the single field.
3. Returns { id, is_available: false }.

**Alternate Flows:**
- **A1 — Item not found / foreign:** 404 Not Found.
- **A2 — Cafe inactive:** 403 Forbidden — {"detail": "Your subscription is inactive. Please contact support."} (Global Convention 5).

---

### UC-OWNER-006 — Upload Item Image

> **As a Cafe Owner on a Pro plan, I want to upload an image for a menu item so that customers can see what they are ordering.**

| Field | Value |
|---|---|
| **Actor** | Cafe Owner (Pro plan only) |
| **Trigger** | Owner selects and uploads an image file |
| **Preconditions** | Cafe is active; cafe.plan.allows_images is true; item exists, is not soft-deleted and belongs to this cafe |
| **Postconditions (Success)** | A processed WebP image is stored on Cloudflare R2; item.image_url is updated; the old image is removed from R2 |
| **API** | POST /api/v1/dashboard/items/{id}/image/ |
| **Architectural Note** | Service Layer checks that cafe.plan.allows_images is true before upload. The file is validated by its content, not by the client's Content-Type header or file name: Pillow opens it with a format allowlist (JPEG, PNG, WebP). The file must be 2 MB or smaller and at most 25 megapixels (width x height); the pixel limit protects against decompression bombs (small files that expand to huge images in memory). The image is then processed: resized so the longest side is at most 1200 px (never enlarged), all metadata removed (EXIF, including the GPS location), and saved as WebP. It is stored on R2 under a new random key cafes/<cafe_id>/items/<uuid4>.webp with Cache-Control: public, max-age=31536000, immutable, and served from the R2 custom domain. Uses django-storages + boto3. The old image is deleted from R2 after the database commit (transaction.on_commit); if that delete fails, the error is logged and the request still succeeds. |

**Main Flow:**
1. Client sends multipart/form-data with image field.
2. Service validates that cafe.plan.allows_images is true.
3. Service validates the file: size, format detected by Pillow, pixel count.
4. Service resizes the image, removes its metadata and converts it to WebP.
5. Service uploads it to R2 under a new random key and gets back its public URL.
6. Service updates item.image_url and returns the updated item.
7. After the commit, the old image (if any) is deleted from R2.

**Alternate Flows:**
- **A1 — Basic plan:** 403 Forbidden — {"detail": "Item images require a Pro plan."}.
- **A2 — Not a JPEG, PNG or WebP image (including files Pillow cannot read):** 400 Bad Request — {"detail": "Only JPEG, PNG, and WebP images are allowed."}.
- **A3 — File too large (>2MB):** 400 Bad Request — {"detail": "Image must be under 2MB."}.
- **A4 — R2 upload failure:** 502 Bad Gateway — logged server-side; user sees {"detail": "Image upload failed. Please try again."}.
- **A5 — Image larger than 25 megapixels:** 400 Bad Request — {"detail": "Image dimensions are too large."}.
- **A6 — Cafe inactive:** 403 Forbidden — {"detail": "Your subscription is inactive. Please contact support."} (Global Convention 5).
- **A7 — Item not found, soft-deleted or belongs to another cafe:** 404 Not Found — {"detail": "Not found."}.

---

### UC-OWNER-007 — Generate QR Codes

> **As a Cafe Owner, I want to set the number of tables and generate a QR code for each table so that customers can scan and view the menu.**

| Field | Value |
|---|---|
| **Actor** | Cafe Owner |
| **Trigger** | Owner sets table count and clicks Generate |
| **Preconditions** | Owner is authenticated; cafe is active; cafe has a valid slug |
| **Postconditions (Success)** | Active CafeTable rows exist for table numbers 1 through table_count and for no other number; the response lists them with table number, URL, QR token and QR image |
| **API** | POST /api/v1/dashboard/qr/generate/ |
| **Architectural Note** | Tables are persisted in the CafeTable model (fields: cafe, table_number, qr_token, is_active, created_at, updated_at; UNIQUE per cafe on table_number). Service Layer method TableService.sync_tables(cafe, table_count) runs in one DB transaction (atomic). It never deletes rows: tables above the requested count are deactivated (is_active = false), so their qr_token survives re-activation. table_count is NOT stored anywhere; it is always derived as the number of active CafeTable rows. QR URL format: https://menu.domain.com/menu/[cafe-slug]?table=N. The qr_token is stored and returned but is NOT part of the URL in the MVP; the table query parameter stays display-only (see UC-GUEST-001). qr_image_url is a base64 data URL produced with the qrcode library; nothing is stored on R2. sync_tables runs under the cafe row lock (Global Convention 8). QR codes use error correction level Q (still readable when part of the printed code is dirty or damaged) and a quiet zone (empty border) of 4 modules. |

**Main Flow:**
1. Owner sends { "table_count": 12 }.
2. Service syncs the tables in one transaction: (a) creates an active CafeTable with a new qr_token for every number from 1 to table_count that has no row; (b) sets is_active = true on every existing inactive row in that range, keeping its qr_token; (c) sets is_active = false on every active row whose table_number is greater than table_count.
3. Service builds, for each active table in ascending table_number order, url = https://menu.domain.com/menu/[cafe-slug]?table=N and qr_image_url.
4. Returns 200 OK: { "table_count": 12, "tables": [ { "id", "table_number", "url", "qr_token", "qr_image_url" } ] }.

**Alternate Flows:**
- **A1 — table_count missing, not an integer, 0 or negative:** 400 Bad Request with a field-level error on table_count.
- **A2 — table_count > 200:** 400 Bad Request — {"table_count": ["Ensure this value is less than or equal to 200."]} (DRF's built-in max_value message; same field-level format as A1).
- **A3 — Same table_count sent again:** 200 OK; no rows are created, every qr_token is unchanged (idempotent).
- **A4 — Smaller table_count than before:** the tables above it are deactivated and disappear from the preview and the PDF; they are not deleted.
- **A5 — Cafe inactive:** 403 Forbidden — {"detail": "Your subscription is inactive. Please contact support."} (Global Convention 5).

---

### UC-OWNER-008 — Download QR PDF

> **As a Cafe Owner, I want to download a print-ready PDF of all QR codes so that I can print and place them on tables.**

| Field | Value |
|---|---|
| **Actor** | Cafe Owner |
| **Trigger** | Owner clicks "Download PDF" |
| **Preconditions** | Cafe is active; the cafe has at least one active CafeTable (QR codes were generated with UC-OWNER-007) |
| **Postconditions (Success)** | PDF file is returned as a download; one page per active table in ascending table_number order; each page contains one QR code and its table number |
| **API** | GET /api/v1/dashboard/qr/download-pdf/ |
| **Architectural Note** | Generated server-side using reportlab from the persisted active CafeTable rows; the table count is derived from them. Response content type: application/pdf. Not cached — URLs are built from the cafe's current slug on every request. Each QR code is drawn as vector shapes with reportlab's built-in QR widget (reportlab.graphics.barcode.qr), so it stays sharp at any print size. It encodes exactly the same URL as UC-OWNER-011, uses error correction level Q and a 4-module quiet zone, is printed at least 3 cm wide, and has the table number and the URL printed under it. |

**Main Flow:**
1. Owner requests the PDF.
2. Service loads the cafe's active tables ordered by table_number ascending and generates the PDF with one QR code per page using reportlab.
3. Returns streaming PDF response with Content-Disposition: attachment; filename="qrcodes.pdf".

**Alternate Flows:**
- **A1 — No active tables:** 400 Bad Request — {"detail": "Please generate QR codes first."}.
- **A2 — Cafe inactive:** 403 Forbidden — {"detail": "Your subscription is inactive. Please contact support."} (Global Convention 5).

---

### UC-OWNER-009 — Update Cafe Settings

> **As a Cafe Owner, I want to update my cafe name and primary color so that my brand is correctly represented.**

| Field | Value |
|---|---|
| **Actor** | Cafe Owner |
| **Trigger** | Owner edits and saves settings |
| **Preconditions** | Owner is authenticated; cafe is active |
| **Postconditions (Success)** | Cafe record updated |
| **API** | PATCH /api/v1/dashboard/settings/ |
| **Architectural Note** | Primary color is a Pro-plan feature: the Service Layer allows it only when plan.allows_branding is true. The slug is NOT editable by cafe owners; only a Super Admin can change it (UC-ADMIN-006). primary_color must be "#RRGGBB" (6 hexadecimal digits) or "" (back to the default theme). name follows Global Convention 6. |

**Main Flow:**
1. Owner sends partial update: { name: {ar, en}, primary_color }.
2. If primary_color is present, Service validates that plan.allows_branding is true.
3. System saves the changes.
4. Returns updated cafe settings.

**Alternate Flows:**
- **A1 — Request body contains the key slug:** 403 Forbidden — {"detail": "Only a Super Admin can change the cafe slug."}; nothing is updated, even if other fields are valid.
- **A2 — Basic plan trying to change primary_color:** 403 Forbidden — {"detail": "Custom colors require a Pro plan."}.
- **A3 — primary_color is not "#RRGGBB" or "":** 400 Bad Request — {"primary_color": ["Enter a color in #RRGGBB format."]}.
- **A4 — Invalid name:** 400 Bad Request with field-level errors under name (Global Convention 6).
- **A5 — Cafe inactive:** 403 Forbidden — {"detail": "Your subscription is inactive. Please contact support."} (Global Convention 5).

---

### UC-OWNER-010 — Upload Cafe Logo

> **As a Cafe Owner on a Pro plan, I want to upload a logo for my cafe so that it appears on the customer-facing menu page.**

| Field | Value |
|---|---|
| **Actor** | Cafe Owner (Pro plan only) |
| **Trigger** | Owner selects and uploads a logo image |
| **Preconditions** | Cafe is active; cafe.plan.allows_branding is true |
| **Postconditions (Success)** | A processed WebP logo is stored on R2; cafe.logo_url updated; the old logo is removed from R2 |
| **API** | POST /api/v1/dashboard/settings/logo/ |
| **Architectural Note** | Same validation and processing pipeline as UC-OWNER-006 (format checked by Pillow, max 2 MB, max 25 megapixels, metadata removed, saved as WebP), except that the longest side is at most 512 px and transparency is kept. Stored under the new random key cafes/<cafe_id>/logo/<uuid4>.webp. The allows_branding check is enforced in the Service Layer. The old logo is deleted from R2 after the commit (best effort, failures logged). |

**Main Flow:**
1. Owner uploads logo via multipart/form-data.
2. Service validates that cafe.plan.allows_branding is true.
3. Service validates the file: size, format detected by Pillow, pixel count.
4. Service resizes the image, removes its metadata, converts it to WebP and uploads it to R2 under a new random key.
5. Service updates cafe.logo_url and returns the updated settings.
6. After the commit, the old logo (if any) is deleted from R2.

**Alternate Flows:**
- **A1 — Basic plan:** 403 Forbidden — {"detail": "Custom logos require a Pro plan."}.
- **A2 — Invalid file type / too large:** 400 Bad Request — same messages as UC-OWNER-006 A2 and A3.
- **A3 — Image larger than 25 megapixels:** 400 Bad Request — {"detail": "Image dimensions are too large."}.
- **A4 — R2 upload failure:** 502 Bad Gateway — {"detail": "Image upload failed. Please try again."}.
- **A5 — Cafe inactive:** 403 Forbidden — {"detail": "Your subscription is inactive. Please contact support."} (Global Convention 5).

---

### UC-OWNER-011 — Preview QR Codes

> **As a Cafe Owner, I want to see all my current QR codes on screen so that I can check them before printing.**

| Field | Value |
|---|---|
| **Actor** | Cafe Owner |
| **Trigger** | Owner opens the QR Codes screen |
| **Preconditions** | Owner is authenticated; cafe is active |
| **Postconditions (Success)** | The active tables of the cafe are returned with their QR codes; nothing is modified |
| **API** | GET /api/v1/dashboard/qr/preview/ |
| **Architectural Note** | Read-only. Same response shape as UC-OWNER-007. Derived from the persisted active CafeTable rows; the table count is derived from them. |

**Main Flow:**
1. Owner requests the preview.
2. Service loads the cafe's active tables ordered by table_number ascending and builds url and qr_image_url for each.
3. Returns 200 OK: { "table_count": 12, "tables": [ { "id", "table_number", "url", "qr_token", "qr_image_url" } ] }.

**Alternate Flows:**
- **A1 — No active tables:** 200 OK with { "table_count": 0, "tables": [] }.
- **A2 — Cafe inactive:** 403 Forbidden — {"detail": "Your subscription is inactive. Please contact support."} (Global Convention 5).

---

### UC-OWNER-012 — List Categories

> **As a Cafe Owner, I want to see all my categories so that I can manage my menu structure.**

| Field | Value |
|---|---|
| **Actor** | Cafe Owner |
| **Trigger** | Owner opens the Categories screen |
| **Preconditions** | Owner is authenticated; cafe is_active = true |
| **Postconditions (Success)** | All non-deleted categories of the owner's cafe are returned, including hidden ones |
| **API** | GET /api/v1/dashboard/categories/ |
| **Architectural Note** | Queryset is filtered by cafe_id taken from request.user.cafe and by deleted_at IS NULL. Not paginated in the MVP: the response is a plain JSON array. |

**Main Flow:**
1. Owner requests the list.
2. System returns [ { id, name: {ar, en}, sort_order, is_visible } ] sorted by sort_order ascending.

**Alternate Flows:**
- **A1 — No categories yet:** 200 OK with [].
- **A2 — Cafe inactive:** 403 Forbidden — {"detail": "Your subscription is inactive. Please contact support."}.

---

### UC-OWNER-013 — List Menu Items

> **As a Cafe Owner, I want to see my menu items, optionally filtered by category, so that I can manage what I sell.**

| Field | Value |
|---|---|
| **Actor** | Cafe Owner |
| **Trigger** | Owner opens the Items screen or selects a category |
| **Preconditions** | Owner is authenticated; cafe is_active = true |
| **Postconditions (Success)** | All non-deleted items of the owner's cafe are returned, including items with is_available = false |
| **API** | GET /api/v1/dashboard/items/ (optional query parameter: ?category=<category_id>) |
| **Architectural Note** | Queryset is filtered by cafe_id taken from request.user.cafe and by deleted_at IS NULL. Not paginated in the MVP: the response is a plain JSON array. |

**Main Flow:**
1. Owner requests the list (optionally with ?category=<id>).
2. System returns [ { id, category_id, name: {ar, en}, description: {ar, en}, price, image_url, is_available, is_featured, is_new, sort_order } ]. Without the filter: sorted by the category's sort_order ascending, then the item's sort_order ascending. With the filter: only that category's items, sorted by sort_order ascending.

**Alternate Flows:**
- **A1 — No items:** 200 OK with [].
- **A2 — category is not an integer:** 400 Bad Request.
- **A3 — category does not exist or belongs to another cafe:** 404 Not Found — {"detail": "Not found."}.
- **A4 — Cafe inactive:** 403 Forbidden — {"detail": "Your subscription is inactive. Please contact support."}.

---

### UC-OWNER-014 — View Cafe Settings

> **As a Cafe Owner, I want to view my cafe profile and plan so that I know what I can change and whether my subscription is active.**

| Field | Value |
|---|---|
| **Actor** | Cafe Owner |
| **Trigger** | Owner opens the Settings screen or the dashboard loads |
| **Preconditions** | Owner is authenticated |
| **Postconditions (Success)** | The cafe profile and plan flags are returned |
| **API** | GET /api/v1/dashboard/settings/ |
| **Architectural Note** | Unlike the write endpoints, which require an active cafe, this read endpoint answers 200 OK even when the cafe is inactive, so the frontend can show the "subscription inactive" state. It is the only dashboard endpoint without the active-cafe check (Global Convention 5). Stored logo_url and primary_color are returned even when the current plan hides them from customers (Global Convention 7); the plan flags in the same response tell the UI why. |

**Main Flow:**
1. Owner requests the settings.
2. System returns { name: {ar, en}, slug, primary_color, logo_url, is_active, plan: { name, max_categories, max_items, allows_images, allows_branding } }.

**Alternate Flows:**
- **A1 — Cafe inactive:** 200 OK with is_active: false (this is not an error).


---

## GUEST Use Cases

---

### UC-GUEST-001 — View Public Menu

> **As a Customer (guest), I want to scan a QR code at my table and immediately see the cafe's full menu so that I can browse items and decide what to order.**

| Field | Value |
|---|---|
| **Actor** | Customer (unauthenticated) |
| **Trigger** | Customer scans the QR code at a table (navigates to /menu/[slug]?table=N) |
| **Preconditions** | Cafe exists and is_active = true |
| **Postconditions (Success)** | Full menu rendered: cafe branding, all visible categories, all available items |
| **API** | GET /api/v1/menu/{slug}/ |
| **Architectural Note** | No authentication required. Response includes only categories with is_visible = true AND deleted_at IS NULL and, inside them, only items with deleted_at IS NULL AND is_available = true. Plan-gated values (image_url, logo_url, primary_color) are hidden according to Global Convention 7. The table query param is display-only — backend does not validate or store it. The frontend reads it in the browser, not on the server, so the cached page is the same for every table. Next.js renders this with ISR (Incremental Static Regeneration) for performance and keeps it fresh with on-demand revalidation (Global Convention 9). The API is called by the Next.js server, not by the customer's browser, so it is not rate limited per client IP; rate limiting for /menu/ is done in Nginx. The noindex, nofollow meta tag and the X-Robots-Tag response header prevent search engine indexing. |

**Main Flow:**
1. Customer's browser navigates to /menu/tartus-coffee?table=3.
2. Next.js fetches from GET /api/v1/menu/tartus-coffee/.
3. API returns: cafe branding + categories (sorted by sort_order) + items per category (sorted by sort_order, only is_available=true shown to customer).
4. Frontend renders the menu with the cafe's primary_color as a CSS variable (default theme when primary_color is "").
5. Customer can toggle language between Arabic and English in the browser (no new request); missing English text falls back to Arabic (Global Convention 6). Prices are displayed as described in Global Convention 10.

**Alternate Flows:**
- **A1 — Slug not found:** 404 Not Found — frontend shows a generic "Menu not found" page.
- **A2 — Cafe is inactive:** 200 OK with is_active: false — frontend shows "This cafe's menu is temporarily unavailable." screen (UC-GUEST-002).
- **A3 — No categories yet:** Returns empty categories: [] — frontend shows "Menu coming soon" message.

---

### UC-GUEST-002 — View Inactive Cafe Screen

> **As a Customer, when I scan a QR code for a cafe with an inactive subscription, I want to see a clear message so that I know the service is temporarily unavailable.**

| Field | Value |
|---|---|
| **Actor** | Customer (unauthenticated) |
| **Trigger** | API returns is_active: false in the menu response |
| **Preconditions** | Cafe exists but is_active = false |
| **Postconditions** | Customer sees a user-friendly screen, not a generic error |
| **API** | GET /api/v1/menu/{slug}/ (returns 200, not 503) |
| **Architectural Note** | Returning 200 OK with is_active: false (rather than a 503) is a deliberate design decision: it allows Next.js ISR to cache and serve this graceful state without triggering error boundary pages. The frontend is responsible for rendering the "unavailable" UI when it detects is_active: false. |

**Main Flow:**
1. Customer scans QR code.
2. API returns { cafe: { is_active: false, ... }, categories: [] }.
3. Frontend detects is_active: false and renders: cafe name (if known) + message: "This menu is temporarily unavailable. Please ask staff for assistance."

---

## Appendix: Use Case Index

| ID | Name | Actor | API Endpoint |
|---|---|---|---|
| UC-AUTH-001 | Login | Any | POST /api/v1/auth/login/ |
| UC-AUTH-002 | Refresh Token | Any | POST /api/v1/auth/refresh/ |
| UC-AUTH-003 | Logout | Any | POST /api/v1/auth/logout/ |
| UC-AUTH-004 | Change Password | Any | POST /api/v1/auth/change-password/ |
| UC-ADMIN-001 | Create Cafe | Super Admin | POST /api/v1/admin/cafes/ |
| UC-ADMIN-002 | List Cafes | Super Admin | GET /api/v1/admin/cafes/ |
| UC-ADMIN-003 | View Cafe Details | Super Admin | GET /api/v1/admin/cafes/{id}/ |
| UC-ADMIN-004 | Activate Subscription | Super Admin | POST /api/v1/admin/cafes/{id}/activate/ |
| UC-ADMIN-005 | Deactivate Subscription | Super Admin | POST /api/v1/admin/cafes/{id}/deactivate/ |
| UC-ADMIN-006 | Edit Cafe | Super Admin | PATCH /api/v1/admin/cafes/{id}/ |
| UC-ADMIN-007 | Delete Cafe | Super Admin | DELETE /api/v1/admin/cafes/{id}/ |
| UC-ADMIN-008 | View Billing History | Super Admin | GET /api/v1/admin/cafes/{id}/billing/ |
| UC-ADMIN-009 | View Platform Stats | Super Admin | GET /api/v1/admin/stats/ |
| UC-OWNER-001 | Manage Categories | Cafe Owner | POST/PATCH/DELETE /api/v1/dashboard/categories/ |
| UC-OWNER-002 | Manage Menu Items | Cafe Owner | POST/PATCH/DELETE /api/v1/dashboard/items/ |
| UC-OWNER-003 | Reorder Categories | Cafe Owner | POST /api/v1/dashboard/categories/reorder/ |
| UC-OWNER-004 | Reorder Menu Items | Cafe Owner | POST /api/v1/dashboard/items/reorder/ |
| UC-OWNER-005 | Toggle Item Availability | Cafe Owner | PATCH /api/v1/dashboard/items/{id}/availability/ |
| UC-OWNER-006 | Upload Item Image | Cafe Owner (Pro) | POST /api/v1/dashboard/items/{id}/image/ |
| UC-OWNER-007 | Generate QR Codes | Cafe Owner | POST /api/v1/dashboard/qr/generate/ |
| UC-OWNER-008 | Download QR PDF | Cafe Owner | GET /api/v1/dashboard/qr/download-pdf/ |
| UC-OWNER-009 | Update Cafe Settings | Cafe Owner | PATCH /api/v1/dashboard/settings/ |
| UC-OWNER-010 | Upload Cafe Logo | Cafe Owner (Pro) | POST /api/v1/dashboard/settings/logo/ |
| UC-OWNER-011 | Preview QR Codes | Cafe Owner | GET /api/v1/dashboard/qr/preview/ |
| UC-OWNER-012 | List Categories | Cafe Owner | GET /api/v1/dashboard/categories/ |
| UC-OWNER-013 | List Menu Items | Cafe Owner | GET /api/v1/dashboard/items/ |
| UC-OWNER-014 | View Cafe Settings | Cafe Owner | GET /api/v1/dashboard/settings/ |
| UC-GUEST-001 | View Public Menu | Customer | GET /api/v1/menu/{slug}/ |
| UC-GUEST-002 | View Inactive Cafe Screen | Customer | GET /api/v1/menu/{slug}/ |
