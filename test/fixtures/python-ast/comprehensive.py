import os
import pkg.client as pc
from .services import (
    Client as ApiClient,
    helper,
)
from .. import shared as shared_alias

__all__ = ["Service", "top_level"]


@registry.register("service")
class Service(BaseService, mixins.LoggingMixin):
    @classmethod
    async def build(cls, client: ApiClient):
        async def prepare(value):
            return transform(value)

        prepared = await prepare(client)
        instance = cls(prepared)
        await instance.initialize()
        return instance

    class Nested:
        def run(self):
            return self.worker.execute()


async def top_level(service: Service):
    client = pc.Client(os.environ)

    def inner():
        return helper(shared_alias.VALUE)

    await service.build(client)
    return inner()


def _private():
    print("private")
