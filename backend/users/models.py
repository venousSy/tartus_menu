from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

class CustomUserManager(BaseUserManager):
    """
    Custom manager for the User model where email is the unique identifier
    for authentication instead of usernames.
    """
    @classmethod
    def normalize_email(cls, email):
        # Lowercase the whole address (Django only lowercases the domain part),
        # so "Owner@Cafe.com" and "owner@cafe.com" cannot become two accounts.
        return super().normalize_email(email).lower()

    def get_by_natural_key(self, username):
        # Case-insensitive login lookup; used by Django's authenticate() and simplejwt.
        return self.get(**{f"{self.model.USERNAME_FIELD}__iexact": username})

    def create_user(self, email, password=None, **extra_fields):
        if not email:
            raise ValueError(_("The Email must be set"))
        email = self.normalize_email(email)
        user = self.model(email=email, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        extra_fields.setdefault("role", User.Role.SYSTEM_ADMIN)

        if extra_fields.get("is_staff") is not True:
            raise ValueError(_("Superuser must have is_staff=True."))
        if extra_fields.get("is_superuser") is not True:
            raise ValueError(_("Superuser must have is_superuser=True."))

        return self.create_user(email, password, **extra_fields)


class User(AbstractBaseUser, PermissionsMixin):
    """
    Custom Domain User Model.
    Decoupled from standard Django 'username', utilizing 'email' as the PK-equivalent identifier.
    Includes explicit domain roles for authorization scaling.
    """
    class Role(models.TextChoices):
        SYSTEM_ADMIN = 'SYSTEM_ADMIN', _('System Admin')
        CAFE_OWNER = 'CAFE_OWNER', _('Cafe Owner')
        CAFE_STAFF = 'CAFE_STAFF', _('Cafe Staff')

    email = models.EmailField(_("email address"), unique=True, max_length=255)
    
    # Domain boundaries: Role-based Access Control (RBAC) foundation
    role = models.CharField(
        max_length=20,
        choices=Role.choices,
        default=Role.CAFE_OWNER,
    )
    
    # Required Django admin fields
    is_staff = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)
    date_joined = models.DateTimeField(default=timezone.now)

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = [] # Email and password are required by default

    objects = CustomUserManager()

    def clean(self):
        # Forms (e.g., the Django admin) call clean() but bypass create_user(),
        # so normalize the email here as well.
        super().clean()
        self.email = self.__class__.objects.normalize_email(self.email)

    def __str__(self):
        return self.email
