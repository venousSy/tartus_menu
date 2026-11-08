from django.db import models

class ActiveManager(models.Manager):
    """
    Manager that only returns objects that haven't been soft-deleted.
    """
    def get_queryset(self):
        return super().get_queryset().filter(deleted_at__isnull=True)

class Category(models.Model):
    """
    Groups menu items together.
    Uses soft deletion (deleted_at): deleted rows are hidden from normal queries, not removed.
    """
    cafe = models.ForeignKey(
        'cafes.Cafe',
        on_delete=models.CASCADE,
        related_name='categories'
    )
    name = models.JSONField(default=dict)  # {"ar": "...", "en": "..."}
    sort_order = models.PositiveIntegerField(default=100)
    is_visible = models.BooleanField(default=True)
    
    deleted_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = ActiveManager()
    all_objects = models.Manager()

    class Meta:
        db_table = 'categories'
        verbose_name_plural = 'categories'
        ordering = ['sort_order', 'id']

    def __str__(self):
        # "or", not get()'s default: a missing English name is stored as "".
        return self.name.get('en') or self.name.get('ar') or f'Category {self.id}'


class MenuItem(models.Model):
    """
    A single purchasable item on the menu.
    Belongs to a category, but denormalizes cafe_id for security (RLS/tenant isolation).
    """
    category = models.ForeignKey(
        Category,
        on_delete=models.CASCADE,
        related_name='items'
    )
    cafe = models.ForeignKey(
        'cafes.Cafe',
        on_delete=models.CASCADE,
        related_name='menu_items'
    )
    name = models.JSONField(default=dict)  # {"ar": "...", "en": "..."}
    description = models.JSONField(default=dict, blank=True)  # {"ar": "...", "en": "..."}
    price = models.DecimalField(max_digits=10, decimal_places=2)  # SYP (hardcoded currency)
    image_url = models.URLField(max_length=2000, blank=True, default='')
    # The same image at most 192 px wide, for the small pictures of the menu lists. "" for an item
    # without image, and for images uploaded before thumbnails existed: readers fall back to image_url.
    thumbnail_url = models.URLField(max_length=2000, blank=True, default='')

    is_available = models.BooleanField(default=True)
    is_featured = models.BooleanField(default=False)
    is_new = models.BooleanField(default=False)
    sort_order = models.PositiveIntegerField(default=100)
    
    deleted_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = ActiveManager()
    all_objects = models.Manager()

    class Meta:
        db_table = 'menu_items'
        ordering = ['sort_order', 'id']
        constraints = [
            # system_design.md 2.2: CHECK price >= 0 (Global Convention 10), also for writers that skip the API.
            models.CheckConstraint(condition=models.Q(price__gte=0), name='menu_item_price_not_negative'),
        ]

    def save(self, *args, **kwargs):
        # Tenant-isolation invariant: the denormalized cafe must equal the category's cafe.
        # Fail loudly instead of saving an item that would leak into another cafe's menu.
        # Note: QuerySet.update() and bulk_update() bypass save(); never change cafe/category with them.
        if self.cafe_id != self.category.cafe_id:
            raise ValueError("MenuItem.cafe must match MenuItem.category.cafe.")
        super().save(*args, **kwargs)

    def __str__(self):
        return self.name.get('en') or self.name.get('ar') or f'MenuItem {self.id}'
