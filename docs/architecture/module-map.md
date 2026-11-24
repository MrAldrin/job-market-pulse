# Module map

The [TOML map](module-map.toml) assigns each TypeScript server, contract and CLI
module to a brick and describes its role. The offline test checks that all these
modules have entries and that no entries are stale.

The `python-oracle` bookmark preserves the retired Python map and implementation.
