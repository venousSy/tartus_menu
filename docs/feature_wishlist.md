# Feature Wishlist (chosen 2026-11-10)

> **Status: PROPOSAL. This file is NOT a source of truth.**
> The source-of-truth documents are listed in `AGENTS.md` Section 2. Nothing here is built until the
> feature gets its own docs turns (`use_cases.md`, `system_design.md`, `implementation_plan.md`) and then
> its build steps (AGENTS.md §3, §4). The planned roadmap stays in `post_mvp_roadmap.md`; this file lists
> only features that are NOT in that roadmap.

## How this list was made

1. Research into similar products (Section 5): commercial QR-menu platforms (MENU TIGER, ChoiceQR,
   QRCarta, NordQR, UpMenu, FineDine), POS menu tools (Toast, Shift4), and digital-menu UX guides.
2. Features already planned were left out: analytics (B), item tags (G), item variants (H), email
   password reset (E2), RLS (K).
3. Features outside the project scope were left out (AGENTS.md §5): ordering, WhatsApp ordering,
   "call the waiter" button, table sessions, `CAFE_STAFF` features.
4. The user answered one multi-choice question per feature: all plans, Pro only, later, or no.

**Main lesson from the research.** In the "menu only" tier, products win with tools that save the owner
time (bulk price changes, timed offers, imports) and with a fast, clear menu for the guest. They do not
win by adding many guest features.

## 1. Chosen features

All 18 chosen features are for **all plans** (Basic and Pro), except where the "Open questions"
column says a plan flag may still limit part of it.

### 1.1 Guest menu page

| # | Feature | What it does | Notes and open questions |
|---|---|---|---|
| 1 | Cafe info section | Opening hours, an "Open now / Closed" badge, a map link, a phone / WhatsApp contact button, Instagram and Facebook links. | New cafe fields (hours per weekday, links). The badge must be computed in the browser in `Asia/Damascus` time, because the menu page is cached. The WhatsApp button is for contact only, never for orders. Validate links (only `https://`, known hosts for social links). |
| 2 | Search inside the menu | The guest types a word and sees matching items in Arabic and English. | Runs in the browser on the data already loaded. No backend change. Arabic search should ignore diacritics and treat أ/إ/آ/ا as the same letter. |
| 3 | Item detail sheet | Tap an item to see a large photo and the full description. | Uses the 1200 px image that exists but is never shown (roadmap item J). Images stay a Pro feature (`allows_images`, GC 7), so a Basic cafe's sheet shows text only. |
| 4 | Sold-out items shown greyed | Unavailable items show in grey with a "Sold out" label, instead of being hidden. | **Owner's choice** per cafe: hide (today's behavior) or show greyed. Changes UC-GUEST-001, which hides them today. New cafe setting. |
| 11 | Dark mode | Follows the phone's setting, with a toggle button. | The guest's choice is kept in `localStorage`. The brand color must keep a safe contrast in both themes. |

### 1.2 Offers and marketing

| # | Feature | What it does | Notes and open questions |
|---|---|---|---|
| 5 | Announcement banner | A short owner text at the top of the menu (for example "20% off desserts today") with a start and an end date. | Bilingual text (`ar` required, GC 6). It hides itself after the end date: the check runs in the browser, and the cached page must also be revalidated. |
| 6 | Sale price | The old price is shown crossed out next to the new price, with an optional end date. | New item fields (sale price, end date). Sale price must be lower than the normal price. Interacts with variants (H): decide whether variants get sale prices too. |
| 7 | Time-based categories | A category (for example "Breakfast") is shown only at set hours and weekdays. | Hidden in the browser because the page is cached. Time zone `Asia/Damascus`. Decide what an empty menu shows when every category is out of hours. |
| 8 | "Often ordered with" suggestions | The owner links an item to other items (coffee -> croissant). The suggestions show in the item detail sheet (feature 3). | A link table between items of the same cafe (tenant check, like `MenuItem.save()`). Limit the number of links per item. Hidden or sold-out targets are not suggested. Depends on feature 3. |

### 1.3 Guest engagement

| # | Feature | What it does | Notes and open questions |
|---|---|---|---|
| 9 | Private feedback | The guest gives 1-5 stars and an optional comment. Only the owner sees it, in the dashboard. | Public endpoint without login: needs an Nginx rate-limit zone (like the planned `views` zone) and a length limit. Store no IP, user agent or cookie (same privacy rule as analytics). Optional table number. |
| 10 | "Rate us on Google" button | A direct link to the cafe's Google Maps review page, set by the owner. | Shown to every guest. **No filtering by star rating**: sending only happy guests to Google is against Google's review rules. |

### 1.4 Printing

| # | Feature | What it does | Notes and open questions |
|---|---|---|---|
| 12 | Printable menu | A paper copy of the same menu for guests who do not scan the code (research: only 40-60% of guests scan). | The backend has no Arabic text shaping for ReportLab today. Two options: (a) a print-friendly Next.js page and the browser's "Save as PDF" (no new dependency, correct Arabic); (b) a server PDF with `arabic-reshaper` + `python-bidi` (two new dependencies). Option (a) is simpler. |
| 18 | QR card designs | Ready-made table-card templates with the cafe logo, color and a "Scan for the menu" text, instead of the plain code. | Logo and color are hidden for plans without `allows_branding` (GC 7). Decide: Basic gets the templates without logo and color, or the feature becomes Pro. Keep the QR rules: level M/Q, 4-module quiet zone, dark code on a light background. |

### 1.5 Owner dashboard tools

| # | Feature | What it does | Notes and open questions |
|---|---|---|---|
| 13 | Bulk price change | Raise or lower all prices (or one category) by a percentage, with rounding (for example to the nearest 5 SYP) and a preview before confirming. | Useful with frequent price changes. One transaction under the cafe lock (GC 8). Prices never go below 0. Revalidate the menu once at the end. Decide whether sale prices (feature 6) and variants (H) change too. |
| 14 | Menu import and export | Upload a whole menu from a file, with an error preview before saving; download the menu as a file. | CSV needs no new dependency; real Excel files (`.xlsx`) need `openpyxl` (new dependency). Import respects `max_categories` and `max_items`. All-or-nothing in one transaction. No images in the file. |
| 15 | Trash (restore deleted) | The owner restores a category or item deleted by mistake. | Soft delete (`deleted_at`) already exists. Restoring respects the plan limits. Restoring an item whose category is deleted needs a rule. Decide how long deleted rows stay restorable. |
| 16 | Duplicate item | A "Duplicate" button creates a new item with the same data for the owner to edit. | Respects `max_items` and the cafe lock. Decide whether the image file is copied or shared, and the new item's name (for example "(copy)"). |
| 19 | Change log | A list of "who changed what and when" (for example the latte price from 15000 to 18000), seen by the owner and the Super Admin for support. | New table written by the services (not by signals, so bulk updates are logged too). Store old and new values of changed fields only. Needs a retention period. Tenant-isolated like every cafe-owned table. |

## 2. Declined features

| # | Feature | Why it was considered |
|---|---|---|
| 17 | Several branches per owner account | Common in commercial products. Declined: it breaks the "one user, one cafe" rule (`request.user.cafe`) that tenant isolation is built on. |
| 20 | Automatic Arabic -> English translation with AI | Common in 2026 products. Declined: needs a paid external service and a new dependency. |

## 3. Excluded before asking (out of scope)

Ordering by WhatsApp or in the app, a "call the waiter" button, table sessions and `CAFE_STAFF`
features are common in the Middle East market, but `AGENTS.md` §5 puts them out of scope.

## 4. Suggested grouping for later planning

This is only a suggestion; the order is decided in `implementation_plan.md`.

| Group | Features | Why together |
|---|---|---|
| Menu page, frontend only | 2 search, 11 dark mode | No backend change. Smallest steps. |
| Item detail | 3 detail sheet, then 8 suggestions | 8 shows inside 3. |
| Cafe settings | 1 cafe info, 4 sold-out choice, 10 Google review link | All are new cafe fields in owner settings (UC-OWNER-009). |
| Offers | 5 banner, 6 sale price, 7 time-based categories | All are time-based and checked in the browser in Damascus time. |
| Owner productivity | 13 bulk price, 16 duplicate, 15 trash, 14 import/export | Same services and the same cafe lock. |
| Feedback | 9 private feedback | A new public write endpoint, like the analytics beacon. |
| Printing | 12 printable menu, 18 QR card designs | Same printing concerns. |
| Support | 19 change log | Best built after the other write features, so it can log them all. |

## 5. Sources

Most sources are vendor pages. Treat their numbers as rough estimates, not facts.

- QR menu app comparison: https://www.qrstuff.com/feeds/blog/qr-menu-apps-restaurants-2024
- MENU TIGER, best QR menus: https://www.menutiger.com/blog/best-qr-code-menu-for-restaurants
- ChoiceQR contactless menu (promotions, banners): https://choiceqr.com/products-en/contactless-menu
- QRCarta (daily specials carousel): https://qrcarta.com/en/
- Daily specials on QR menus: https://en.qrcode-gen.com/blog/how-to-change-the-daily-specials-on-the-qr-code-menu
- Time-based menus (Toast): https://support.toasttab.com/en/article/Settings-Menu-Availability
- Dayparting: https://www.pickcel.com/blog/dayparting-digital-menu-boards/
- Timed items (Peazi): https://www.peazi.app/features/timed-menu
- Bulk price change with rounding (NordQR changelog): https://www.nordqr.com/changelog
- Bulk import (Toast): https://doc.toasttab.com/doc/platformguide/platformBulkImportToolOverview.html
- Multi-location price updates: https://supy.io/blog/learn-bulk-menu-price-update-multiple-locations
- Upselling with QR menus: https://en.qrcode-gen.com/blog/boost-upselling-and-cross-selling-with-smart-suggestions-from-dynamic-qr-code-menus
- Digital upselling: https://www.mydigimenu.com/post/what-is-menu-upselling-strategies-that-drive-revenue
- QR feedback: https://www.qrstuff.com/feeds/blog/restaurants-qr-codes-menus-feedback
- Google review QR codes: https://www.qrcodechimp.com/google-review-qr-code-for-restaurants/
- Mobile menu UX: https://www.tryperdiem.com/post/optimize-mobile-menu-for-restaurant-orders
- Guest engagement with digital menus: https://mydigimenu.com/post/boost-guest-engagement-digital-menus-2026
- WhatsApp ordering in the region: https://thikaa.com/blog/restaurant-whatsapp-ordering?lang=en
