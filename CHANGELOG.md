# Changelog

## [1.2.0](https://github.com/chrischall/signupgenius-mcp/compare/v1.1.6...v1.2.0) (2026-07-13)


### Features

* **skill:** add signupgenius api access skill ([#82](https://github.com/chrischall/signupgenius-mcp/issues/82)) ([628670e](https://github.com/chrischall/signupgenius-mcp/commit/628670e79360423a43a0d0df6745b316e28afd5d))


### Refactor

* **skill:** move root SKILL.md into skills/, point plugin.json at ./skills/ ([#84](https://github.com/chrischall/signupgenius-mcp/issues/84)) ([16c1352](https://github.com/chrischall/signupgenius-mcp/commit/16c135212de9e6271b3d16b7110b2bc8e84154c7))

## [1.1.6](https://github.com/chrischall/signupgenius-mcp/compare/v1.1.5...v1.1.6) (2026-07-07)


### Bug Fixes

* bump @chrischall/mcp-utils to 0.12.0 ([#80](https://github.com/chrischall/signupgenius-mcp/issues/80)) ([b3c9461](https://github.com/chrischall/signupgenius-mcp/commit/b3c9461b56911723923fc29a0664f700c2f0e390))


### Refactor

* adopt shared error classes from mcp-utils ([#72](https://github.com/chrischall/signupgenius-mcp/issues/72)) ([9d7e456](https://github.com/chrischall/signupgenius-mcp/commit/9d7e4566fe5b93d7cbe80928b25efca4637fab26))


### Documentation

* fix stale ModeMismatchError comments after shared-error migration ([#75](https://github.com/chrischall/signupgenius-mcp/issues/75)) ([ee27240](https://github.com/chrischall/signupgenius-mcp/commit/ee2724033ca007cb1b54a391607f2609eedbf2b8))

## [1.1.5](https://github.com/chrischall/signupgenius-mcp/compare/v1.1.4...v1.1.5) (2026-06-29)


### Documentation

* document auto-review follow-up convention ([#65](https://github.com/chrischall/signupgenius-mcp/issues/65)) ([f0e0457](https://github.com/chrischall/signupgenius-mcp/commit/f0e04578d9575ee036a18e98b99f5def54c61efd))
* require Conventional Commit PR titles for release-please ([#63](https://github.com/chrischall/signupgenius-mcp/issues/63)) ([8d41666](https://github.com/chrischall/signupgenius-mcp/commit/8d416664b8b114c73850c5777b0cd9e0dec95e20))

## [1.1.4](https://github.com/chrischall/signupgenius-mcp/compare/v1.1.3...v1.1.4) (2026-06-13)


### Bug Fixes

* bot PRs bypass the CI gate unconditionally (upstream curtaincall[#86](https://github.com/chrischall/signupgenius-mcp/issues/86) review) ([#59](https://github.com/chrischall/signupgenius-mcp/issues/59)) ([8372a93](https://github.com/chrischall/signupgenius-mcp/commit/8372a93df6ed9915c50ac98fa35ff583d4451beb))


### Documentation

* add MIT LICENSE file and README badges ([#56](https://github.com/chrischall/signupgenius-mcp/issues/56)) ([a212868](https://github.com/chrischall/signupgenius-mcp/commit/a21286815862e3f175437eb506eb2554dc912c9a))

## [1.1.3](https://github.com/chrischall/signupgenius-mcp/compare/v1.1.2...v1.1.3) (2026-06-10)


### Documentation

* flesh out CLAUDE.md to cohort quality ([#54](https://github.com/chrischall/signupgenius-mcp/issues/54)) ([c70079c](https://github.com/chrischall/signupgenius-mcp/commit/c70079c2b9891efe9863283b7712f849c84e35c0))

## [1.1.2](https://github.com/chrischall/signupgenius-mcp/compare/v1.1.1...v1.1.2) (2026-06-04)


### Bug Fixes

* adopt [@fetchproxy](https://github.com/fetchproxy) 0.13.0 (0.8 → 0.13; bridge host failover + re-pairing) ([#45](https://github.com/chrischall/signupgenius-mcp/issues/45)) ([26a6c9c](https://github.com/chrischall/signupgenius-mcp/commit/26a6c9cd0cb6309b5a08cc756a22c008c08d7b85))
* adopt @fetchproxy/server 1.0.0 + @chrischall/mcp-utils 0.5.0 ([#48](https://github.com/chrischall/signupgenius-mcp/issues/48)) ([222730a](https://github.com/chrischall/signupgenius-mcp/commit/222730a8dffa8d541aafe53a0d93e349388b519f))

## [1.1.1](https://github.com/chrischall/signupgenius-mcp/compare/v1.1.0...v1.1.1) (2026-05-29)


### Bug Fixes

* **ci:** auto-merge arm guards ([#34](https://github.com/chrischall/signupgenius-mcp/issues/34)) ([2871116](https://github.com/chrischall/signupgenius-mcp/commit/2871116efb8602c5aace260d143ad8ea5a3b5e45))

## [1.1.0](https://github.com/chrischall/signupgenius-mcp/compare/v1.0.7...v1.1.0) (2026-05-28)


### Features

* **deps:** adopt @fetchproxy/bootstrap 0.8.0 for SW-eviction-resilient startup capture ([#32](https://github.com/chrischall/signupgenius-mcp/issues/32)) ([db2d999](https://github.com/chrischall/signupgenius-mcp/commit/db2d999c652543ee9acc1003891bf62e860d3dea))

## [1.0.7](https://github.com/chrischall/signupgenius-mcp/compare/v1.0.6...v1.0.7) (2026-05-26)


### Bug Fixes

* **ci:** substitute repo name in publish workflow + add SKILL.md ([#29](https://github.com/chrischall/signupgenius-mcp/issues/29)) ([be6f852](https://github.com/chrischall/signupgenius-mcp/commit/be6f8520e869d4183c0c3dbb7475a409e5b71e97))

## [1.0.6](https://github.com/chrischall/signupgenius-mcp/compare/v1.0.5...v1.0.6) (2026-05-26)


### Documentation

* **claude:** warn against early PRs and call out first-party dep bumps ([#27](https://github.com/chrischall/signupgenius-mcp/issues/27)) ([756d388](https://github.com/chrischall/signupgenius-mcp/commit/756d388bad6a2d5025c9c57c3e67ff2803e9a81b))

## [1.0.5](https://github.com/chrischall/signupgenius-mcp/compare/v1.0.4...v1.0.5) (2026-05-25)


### Bug Fixes

* **ci:** prevent labeled event from cancelling auto-review ([#24](https://github.com/chrischall/signupgenius-mcp/issues/24)) ([4fc290c](https://github.com/chrischall/signupgenius-mcp/commit/4fc290c1f552df17381c1ed482270e9b3acc4158))

## [1.0.4](https://github.com/chrischall/signupgenius-mcp/compare/v1.0.3...v1.0.4) (2026-05-24)


### Bug Fixes

* **rsvp:** match wizard wire format so headcount RSVPs accept ([5045941](https://github.com/chrischall/signupgenius-mcp/commit/50459412b4cddc093e848c02f096a46155a72ffb))
* **rsvp:** match wizard wire format so headcount RSVPs accept ([90c139e](https://github.com/chrischall/signupgenius-mcp/commit/90c139ed19466cc8bad629b5b870443497727a40))


### Documentation

* add Acknowledgement of Terms section to README ([#18](https://github.com/chrischall/signupgenius-mcp/issues/18)) ([4fb8970](https://github.com/chrischall/signupgenius-mcp/commit/4fb8970e60ff743182ac5947a3cf8b9e568d807e))
* canonical auto-merge guidance ([#19](https://github.com/chrischall/signupgenius-mcp/issues/19)) ([30780e3](https://github.com/chrischall/signupgenius-mcp/commit/30780e3cd20f2aea5e0ccbef2e2aa23703e8911c))
* **claude-md:** call out 100-char limit on server.json description ([648f0c5](https://github.com/chrischall/signupgenius-mcp/commit/648f0c58390ab2daca46836a7c9a4f55b9c78f42))
* **claude-md:** call out 100-char limit on server.json description ([99e5287](https://github.com/chrischall/signupgenius-mcp/commit/99e5287e677e7350accbaa189e4cf0bcd7b63ddb))
* correct release-please PR handling in merge guidance ([#20](https://github.com/chrischall/signupgenius-mcp/issues/20)) ([6d8d0c4](https://github.com/chrischall/signupgenius-mcp/commit/6d8d0c441ee64b8dd9f9327cf550e672e8ea1206))
