# Pak fixtures

- `ascii/` is a resource pak project (`package.json` plus the files its `resources` list names): three ASCII-named resources, one of them with attributes and one empty.
- `ascii.pak` is the pak built from `ascii/`.

`ascii.pak` was built by the tool at commit `b3896f9`, before the header-size change. A pak whose names are all ASCII has the same layout either way, so the current tool must build a byte-identical pak from the same project.

To rebuild it from that commit:

1. Check out `b3896f9` of the-seed (for example `git worktree add --detach <dir> b3896f9`), then run `npm ci` and `npm run build` there.
2. From a scratch copy of `ascii/`, run `new (require("<dir>/dist/ResourcePak.js").default)(config).build(<copy>)`, where `config` is any object with a `config.prefix` (the build does not use it).
3. The result is `<copy>/ascii.pak`.
