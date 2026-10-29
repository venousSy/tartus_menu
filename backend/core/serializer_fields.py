"""
Shared DRF serializer fields, used by more than one app (menu now, cafes later).
"""

from rest_framework import serializers
from rest_framework.fields import empty

# Global Convention 6: the most characters per language, enough for a menu card or a phone screen.
NAME_MAX_LENGTH = 100
DESCRIPTION_MAX_LENGTH = 500


class StrictCharField(serializers.CharField):
    """A CharField that accepts only real strings. DRF's CharField also turns 123 into "123"."""

    def to_internal_value(self, data):
        if not isinstance(data, str):
            self.fail('invalid')  # "Not a valid string."
        return super().to_internal_value(data)


class BilingualNameField(serializers.Field):
    """
    A name stored as JSON {"ar": "...", "en": "..."} (use_cases.md Global Convention 6).

    - "ar" is required and must be a non-empty string.
    - "en" is optional; when missing it is stored as "", so every stored name has both keys.
    - Each value has at most NAME_MAX_LENGTH characters.
    - Any other key is rejected.
    Errors use DRF's standard messages under each key, e.g. {"name": {"ar": ["This field is required."]}}.
    The object is always validated as a whole, also in a PATCH: a sent name replaces the old one.
    """

    default_error_messages = {
        'not_an_object': 'Expected an object with the keys "ar" and "en".',
        'extra_keys': 'Only the keys "ar" and "en" are allowed.',
    }

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        # Standalone child fields, not bound to the parent serializer. In a PATCH the parent
        # has partial=True, and bound fields would then let "ar" be left out.
        self.language_fields = {
            'ar': StrictCharField(max_length=NAME_MAX_LENGTH),
            'en': StrictCharField(allow_blank=True, default='', max_length=NAME_MAX_LENGTH),
        }

    def to_internal_value(self, data):
        if not isinstance(data, dict):
            self.fail('not_an_object')
        if set(data) - set(self.language_fields):
            self.fail('extra_keys')

        value, errors = {}, {}
        for key, field in self.language_fields.items():
            try:
                value[key] = field.run_validation(data.get(key, empty))
            except serializers.ValidationError as exc:
                errors[key] = exc.detail
        if errors:
            raise serializers.ValidationError(errors)
        return value

    def to_representation(self, value):
        # Always both keys in the output, so the frontend never has to check for a missing "en".
        return {'ar': value.get('ar', ''), 'en': value.get('en', '')}


class BilingualDescriptionField(BilingualNameField):
    """
    A description stored as JSON {"ar": "...", "en": "..."} (use_cases.md Global Convention 6).

    Both keys are optional strings of at most DESCRIPTION_MAX_LENGTH characters; a missing key is
    stored as "". Other keys are rejected with the same message as in a name, and a sent
    description replaces the old one as a whole.
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.language_fields = {
            'ar': StrictCharField(allow_blank=True, default='', max_length=DESCRIPTION_MAX_LENGTH),
            'en': StrictCharField(allow_blank=True, default='', max_length=DESCRIPTION_MAX_LENGTH),
        }
