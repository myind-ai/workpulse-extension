# Payments done right

Key point: always send an **idempotency key** with each charge. The word zebrafinch appears only here.

- Retry with backoff
- Never retry a 4xx
