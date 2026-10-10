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
    Uses soft deletion to preserve order history and analytics.
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
        return self.name.get('en', self.name.get('ar', f'Category {self.id}'))


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

    def __str__(self):
        return self.name.get('en', self.name.get('ar', f'MenuItem {self.id}'))
