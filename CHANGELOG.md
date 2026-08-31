# Changelog

## [1.7.0](https://github.com/chrischall/signupgenius-mcp/compare/v1.6.0...v1.7.0) (2026-08-30)


### Features

* add signupgenius_healthcheck ([#143](https://github.com/chrischall/signupgenius-mcp/issues/143)) ([8f54163](https://github.com/chrischall/signupgenius-mcp/commit/8f5416329648b33bfd625b579a48506be7d2c1eb)), closes [#144](https://github.com/chrischall/signupgenius-mcp/issues/144)

## [1.6.0](https://github.com/chrischall/signupgenius-mcp/compare/v1.5.0...v1.6.0) (2026-08-29)


### Features

* **deps:** take @fetchproxy/server 2.2.0 so the concentrator can bind its sandbox address ([#141](https://github.com/chrischall/signupgenius-mcp/issues/141)) ([660f89f](https://github.com/chrischall/signupgenius-mcp/commit/660f89fba793b2b2852ba77c4f039028408998a4))

## [1.5.0](https://github.com/chrischall/signupgenius-mcp/compare/v1.4.0...v1.5.0) (2026-08-28)


### Features

* cache the signed-in session so a restart skips the form login ([#130](https://github.com/chrischall/signupgenius-mcp/issues/130)) ([9b326ea](https://github.com/chrischall/signupgenius-mcp/commit/9b326ea282f959a21fcc09f3cba7eb32a05bde60))


### Bug Fixes

* drop the bare signupgenius.com apex from mint.yaml egress ([#127](https://github.com/chrischall/signupgenius-mcp/issues/127)) ([3363a23](https://github.com/chrischall/signupgenius-mcp/commit/3363a230afd4bdf9fc8c7fd0090ac0b16494894f))


### Documentation

* **.env.example:** match the house comment style ([#139](https://github.com/chrischall/signupgenius-mcp/issues/139)) ([293546e](https://github.com/chrischall/signupgenius-mcp/commit/293546e274ecb8ffab78cdc04e295e82402407e7))
* list the cache env vars in server.json and .env.example ([#136](https://github.com/chrischall/signupgenius-mcp/issues/136)) ([287a19b](https://github.com/chrischall/signupgenius-mcp/commit/287a19bc5d4dbf58da1d89e51e6eeca61879f1b7))
* list the session-cache vars in the Environment block ([#140](https://github.com/chrischall/signupgenius-mcp/issues/140)) ([365c882](https://github.com/chrischall/signupgenius-mcp/commit/365c882fabe9aa585f50a8b08ee0180c61b14de7))
* say which description the registry's 100-char cap applies to ([#138](https://github.com/chrischall/signupgenius-mcp/issues/138)) ([1a03e28](https://github.com/chrischall/signupgenius-mcp/commit/1a03e287bb03159caae6e471dd637fcc1ce9c402))
* **skill:** declare the name this skill actually publishes under ([#132](https://github.com/chrischall/signupgenius-mcp/issues/132)) ([656b9a9](https://github.com/chrischall/signupgenius-mcp/commit/656b9a9334c3b6762fbd2d8bbedcc0e57ae47525))

## [1.4.0](https://github.com/chrischall/signupgenius-mcp/compare/v1.3.1...v1.4.0) (2026-08-10)


### Features

* read slot availability and participants with no auth, and claim or release slots ([#116](https://github.com/chrischall/signupgenius-mcp/issues/116)) ([ed6bd56](https://github.com/chrischall/signupgenius-mcp/commit/ed6bd5602a9ee7d0705f5b2f03b3ba642b6b8ef7))


### Documentation

* correct stale requireKeyMode wording and the write-tool count ([#119](https://github.com/chrischall/signupgenius-mcp/issues/119)) ([ec3ad44](https://github.com/chrischall/signupgenius-mcp/commit/ec3ad445c37eb0be72fd0155adb8ad5566399c20))

## [1.3.1](https://github.com/chrischall/signupgenius-mcp/compare/v1.3.0...v1.3.1) (2026-08-06)


### Bug Fixes

* **deps:** move to @fetchproxy/server 2.0.0 for the v3 handshake ([#113](https://github.com/chrischall/signupgenius-mcp/issues/113)) ([74e2765](https://github.com/chrischall/signupgenius-mcp/commit/74e2765509265578aeb9fc4ba308807bfd73d328))

## [1.3.0](https://github.com/chrischall/signupgenius-mcp/compare/v1.2.2...v1.3.0) (2026-08-03)


### Features

* add unauthenticated slot listing and fix the fetchproxy session lifecycle ([#103](https://github.com/chrischall/signupgenius-mcp/issues/103)) ([941a9a1](https://github.com/chrischall/signupgenius-mcp/commit/941a9a14edeb21cb04e1221db68ef15892b167f0))


### Bug Fixes

* **slots:** correct unlimited accounting and scope legacy expiry sniffing ([#106](https://github.com/chrischall/signupgenius-mcp/issues/106)) ([b72f58f](https://github.com/chrischall/signupgenius-mcp/commit/b72f58f3d960f62e68d54f5adb8ca7f2a8a8282e)), closes [#104](https://github.com/chrischall/signupgenius-mcp/issues/104)


### Refactor

* **auth:** collapse the hand-rolled lifter onto createSessionLifter ([#107](https://github.com/chrischall/signupgenius-mcp/issues/107)) ([dfed6d8](https://github.com/chrischall/signupgenius-mcp/commit/dfed6d865c477cd33358b9de2a09f9a258a0c202))

## [1.2.2](https://github.com/chrischall/signupgenius-mcp/compare/v1.2.1...v1.2.2) (2026-07-30)


### Bug Fixes

* **deps:** bump @fetchproxy/* to 1.7.0 and @chrischall/mcp-utils to 0.14.0 ([#100](https://github.com/chrischall/signupgenius-mcp/issues/100)) ([053f8fa](https://github.com/chrischall/signupgenius-mcp/commit/053f8fa8e81735d00a36630066b0e3e026a52add))

## [1.2.1](https://github.com/chrischall/signupgenius-mcp/compare/v1.2.0...v1.2.1) (2026-07-19)


### Documentation

* replace duplicated fleet policy with a pointer ([#89](https://github.com/chrischall/signupgenius-mcp/issues/89)) ([8ccc8e0](https://github.com/chrischall/signupgenius-mcp/commit/8ccc8e085515716decb25da24273a1dd24a0659f))

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
