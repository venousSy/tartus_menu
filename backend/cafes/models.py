import uuid
from django.db import models
from django.conf import settings
from django.utils.translation import gettext_lazy as _
from django.core.validators import MinValueValidator, MaxValueValidator

class SubscriptionPlan(models.Model):
    """
    Represents available tiers in the system (e.g., Basic, Pro).
    Controls resource limits and feature flags per cafe.
    """
    class Name(models.TextChoices):
        BASIC = 'basic', _('Basic')
        PRO = 'pro', _('Pro')
        
    name = models.CharField(max_length=50, choices=Name.choices, unique=True)
    max_categories = models.PositiveIntegerField(null=True, blank=True)
    max_items = models.PositiveIntegerField(null=True, blank=True)
    allows_images = models.BooleanField(default=False)
    allows_branding = models.BooleanField(default=False)

    class Meta:
        db_table = 'subscription_plans'

    def __str__(self):
        return self.get_name_display()


class Cafe(models.Model):
    """
    The central multi-tenant entity. Every category, item, and table 
    belongs to a specific cafe. It holds branding, billing status, and localization.
    """
    owner = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='cafe'
    )
    plan = models.ForeignKey(
        SubscriptionPlan,
        on_delete=models.PROTECT,
        related_name='cafes'
    )
    slug = models.SlugField(max_length=100, unique=True)
    name = models.JSONField(default=dict)  # {"ar": "...", "en": "..."}
    primary_color = models.CharField(max_length=7, blank=True, default='')  # hex, e.g., "#FF5733"
    logo_url = models.URLField(max_length=2000, blank=True, default='')
    
    is_active = models.BooleanField(default=False)
    subscription_start_at = models.DateTimeField(null=True, blank=True)
    subscription_end_at = models.DateTimeField(null=True, blank=True)
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'cafes'

    def __str__(self):
        # Fallback to english, then arabic, then slug
        return self.name.get('en', self.name.get('ar', self.slug))


class CafeTable(models.Model):
    """
    Represents a physical table in a cafe, linking to the QR code token.
    Instead of maintaining a `table_count`, we count active instances of this model.
    """
    cafe = models.ForeignKey(
        Cafe,
        on_delete=models.CASCADE,
        related_name='tables'
    )
    table_number = models.PositiveIntegerField(
        validators=[MinValueValidator(1), MaxValueValidator(200)]
    )
    qr_token = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    is_active = models.BooleanField(default=True)
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'cafe_tables'
        constraints = [
            models.UniqueConstraint(fields=['cafe', 'table_number'], name='unique_cafe_table_number')
        ]

    def __str__(self):
        # Using self.cafe_id instead of self.cafe.slug prevents an implicit DB query for the related object
        return f"Table {self.table_number} (cafe {self.cafe_id})"


class BillingEvent(models.Model):
    """
    Audit log for subscription and billing changes made by the Super Admin.
    """
    class Action(models.TextChoices):
        ACTIVATED = 'activated', _('Activated')
        DEACTIVATED = 'deactivated', _('Deactivated')
        PLAN_CHANGED = 'plan_changed', _('Plan Changed')

    cafe = models.ForeignKey(
        Cafe,
        on_delete=models.CASCADE,
        related_name='billing_events'
    )
    action = models.CharField(max_length=20, choices=Action.choices)
    notes = models.TextField(blank=True)
    performed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name='performed_billing_events'
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'billing_events'
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.cafe.slug} - {self.get_action_display()} at {self.created_at.date()}"
