def public_python(values):
    return _complex_python(values, True)


def _complex_python(values, enabled):
    total = 0
    for value in values:
        if value > 0 and enabled:
            total += value
        elif value < 0:
            total -= value
        else:
            total += 1 if enabled else 0
    try:
        return total
    except TypeError:
        return 0


def _unused_python(value):
    return value + 1


class Hooks:
    def __init__(self):
        self.ready = True

    def _unused_method(self):
        return self.ready
