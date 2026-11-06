# Bug Report: GameLibrary Search & Browse Discoverability (Web)

## Summary
Three compounding issues currently make a real, playable catalog title ("Red Dead Redemption 2", communityId `48260`) **completely unreachable through the web client**, via search or browse, despite it existing and working when launched directly by communityId:

1. **Bug 1 — Search calls the wrong RPC.** The web GameLibrary search feature calls the community/social search RPC (`SearchCommunity`) instead of a game-catalog search RPC, so it always returns "0 related games found" for any game title query.
2. **Bug 2 — "All Games" pagination is broken.** `GetNewGameLibrary(tagId=0, page)` reports `more:true` on page 1 but always returns 0 results on page 2+, silently capping the "All Games" browse view at the first 30 titles out of a 2197-game catalog.
3. **Bug 3 — `GetNewGameLibrary` returns a different, smaller game set for the web client than for the mobile client, for the identical tag.** Calling the exact same RPC (`GetNewGameLibrary`, `tagId=1695` "Open World", `page=1`) with a `client` string of `web;web;;1.0.0;1.0.0.0` omits RDR2 and returns only 133 total games for that tag; the identical call with a mobile `client` string (`android;33;...;4.12.1;4843;`) includes RDR2 on page 1 and returns 181 total games for the same tag. Both calls were made **without an X-Token** (this endpoint doesn't require login), ruling out account/entitlement differences as the cause — the `client` string is the only variable that changed. A second title, "Ghost of Tsushima" (communityId `51915`), was found the same way: present in the mobile-client catalog pull, absent from what the web client surfaces.

Combined, these three bugs mean there is currently **no way to find RDR2, Ghost of Tsushima, or likely many other titles through the web UI at all** — the only working access path found is launching them directly by communityId, bypassing search and browse entirely.

## Bug 1: GameLibrary Search Uses Wrong Backend RPC

### Environment
- URL: `https://www.chikiigame.com/m/chikiiwebprod/index.html#/GameLibrary?search=red+dead+redemption`
- Client bundle: `app.d03a326cc9267ac7.js`, lazy chunk `js/699.5fc5750e.js` (webpack module `74699`, component name `GameLibrary`)
- Browser: Chromium/Brave 150, desktop
- Date observed: 2026-07-14

## Steps to Reproduce
1. Open the URL above (or navigate to Game Library and search "red dead redemption").
2. Page shows: `Search results for "red dead redemption"` / `0 related games found` / `Game Not Found`.
3. Confirm the same title *is* found when searching in the Chikii mobile app.

## Evidence

### Network capture
Typing the query triggers a `POST https://api-prod.chikiigame.com/proxyyun` with protobuf envelope:
```
service: chikii.search.SearchExtObj
method:  SearchCommunity
request: { searchMsg: "red dead redemption", filterType: 1, page: 1, pageSize: 20 }
```
The response contains only request-tracing metadata (traceparent, X-Token, client, language, etc.) and **no `communityList` entries** — i.e. a legitimate empty result for a community search, not a game search.

### Source of the bug
In `js/699.5fc5750e.js`, the `GameLibrary` component's search handler:

```js
const C = async e => {
  try {
    if (!e) { s.isShowSearchPage = false; s.searchResultList.length = 0; s.page = 1; return void u(!0); }
    s.isShowSearchPage = true;
    const o = await (0, k.IZ)({ searchMsg: e, filterType: 1, page: 1, pageSize: 20 });
    s.searchResultList = o.webCommunitySearchList;
    console.log("fetchDataWhenUseSearch", o);
  } catch (o) { console.log(o); }
};
```

`k.IZ` is the exact same RPC wrapper used by the site header's live-search dropdown (`js/404.956b8844.js`), which is explicitly a community-search call:

```js
const t = await (0, ie.IZ)({ searchMsg: e, filterType: 1, page: 1, pageSize: 6 });
u.communityList = t.webCommunitySearchList.map(...)
console.log("SearchCommunity", t, u.communityList);
```

Both call sites read the response field `webCommunitySearchList`, which matches the protobuf schema:

```protobuf
SearchCommunity: { requestType: SearchCommunityReq, responseType: SearchCommunityRes }
SearchCommunityRes: { fields: { communityList: { rule: repeated, type: SearchCommunityData } } }
```

This RPC searches **communities/social groups**, not the game catalog — it will never return a game named "Red Dead Redemption" unless a community happens to share that exact name.

### The correct API is defined but unused
The bundle's protobuf schema (`app.d03a326cc9267ac7.js`) also defines a dedicated game-search RPC that is **never called anywhere in the web client**:

```protobuf
SearchGameInfo: { requestType: SearchGameInfoReq, responseType: SearchGameInfoRes }
SearchGameInfoReq:  { fields: { searchMsg: string, clientPos: ClientPosType } }
SearchGameInfoRes:  { fields: { gameList: { rule: repeated, type: GameSimpleNode } } }
```
Grepping the full web bundle (`app.js`, all lazy chunks) shows `SearchGameInfo` appears exactly once — in the schema definition — with zero call sites. This is very likely the RPC the mobile app uses to power its (working) search, and is the RPC the web GameLibrary page should be calling instead of `SearchCommunity`.

### Impact (Bug 1)
- Every game-title search on the web Game Library page returns zero results, regardless of whether the game exists in the catalog.
- Users cannot find games by name on web via the search box; tag-based browsing (`allTags` / `tagId`) is the only other discovery path, and it has its own bugs (see Bug 2 and Bug 3 below).

### Suggested Fix (Bug 1)
In the `GameLibrary` component's search handler (`C` function, `js/699.5fc5750e.js`), replace the `SearchCommunity` call with the existing-but-unused `SearchGameInfo` RPC (or whatever game-catalog search method the mobile client uses), and map its `gameList` response into `s.searchResultList` instead of `webCommunitySearchList`.

Pseudocode:
```js
const o = await (0, k.SearchGameInfo)({ searchMsg: e, clientPos: WEB /* or applicable enum */ });
s.searchResultList = o.gameList;
```

Note: the header's live-search dropdown (`js/404.956b8844.js`) intentionally calls `SearchCommunity` for its community-suggestions panel — that usage looks correct and should **not** be changed; only the `GameLibrary` page's full search-results list is miswired.

---

## Bug 2: "All Games" Pagination Broken (`GetNewGameLibrary`, `tagId=0`)

### Evidence
Calling `GetNewGameLibrary` with `tagId=0` (the default/untagged "All Games" view) and incrementing `page`, using a real authenticated session (confirmed via a successful `GetPlayer` call returning full profile data):

| page | items returned | `more` flag |
|------|------|------|
| 1 | 30 | `true` |
| 2 | **0** | — (envelope present, no `communitys` field, no `more` field) |

Page 1 explicitly reports `more:true`, promising additional pages, but page 2 (and all pages after, unlike Bug 3's tag case below) returns a well-formed but empty envelope — no error, no results, and no `more` flag at all. This directly contradicts page 1's own pagination signal.

By contrast, requesting a **specific tag** (e.g. "Open World", `tagId=1695`) paginates correctly to its real end: pages 1-4 return 30 items each with `more:true`, page 5 returns the final 13 items with `more` absent/false, and pages 6+ correctly return empty — this is expected, working pagination, not a bug. The bug is specific to `tagId=0`.

### Impact
The web "All Games" library view is effectively capped at the first 30 titles out of a 2197-game catalog (per the site's own displayed total). Any game not in that first page of 30 is unreachable via the default/untagged browse view, and (combined with Bug 1) also unreachable via search.

### Suggested Fix
Investigate why `GetNewGameLibrary(tagId=0, page>=2)` returns an empty result set despite page 1 reporting `more:true`. Per-tag pagination (non-zero `tagId`) works correctly, so the bug is likely isolated to whatever query/cursor logic handles the untagged/"all" case specifically (e.g. a missing `WHERE` clause fallback, an unset default tag filter that produces no matches on page>=2, or an off-by-one in the untagged branch of the pagination cursor).

---

## Bug 3: `GetNewGameLibrary` Returns Different Catalogs for Web vs. Mobile Clients

### Evidence
Side-by-side test of the identical RPC call, same tag, same page, only the `client` header/field value changed:

| | `client` value | tagId | page | items on page 1 | RDR2 (cid `48260`) present? | tag total |
|---|---|---|---|---|---|---|
| Web | `web;web;;1.0.0;1.0.0.0` | 1695 (Open World) | 1 | 30 | **No** | 133 |
| Mobile | `android;33;waydroid:WayDroid x86_64 Device;4.12.1;4843;` | 1695 (Open World) | 1 | 30 | **Yes** | 181 |

Both calls were made with **no `X-Token`** (this endpoint doesn't require authentication), which rules out account-specific entitlement/region differences as the explanation — the only variable that changed between the two calls was the declared client platform.

Corroborating evidence:
- RDR2 (communityId `48260`) is a real, currently-playable title — confirmed via a mobile-app traffic capture (`GetCommunityDetail(48260)`) showing full metadata (name, icon, variant list including "Red Dead Redemption 2", "Red Dead Redemption 2 (Steam)", "RDR2 Plus", "Red Dead Online (Steam)"), and confirmed launchable on web by directly invoking the `GameLibrary` component's own `selectGame({communityId: 48260})` handler (bypassing the UI list entirely) and completing a real play/queue flow through to a `GameWindow` session.
- A second title, **Ghost of Tsushima** (communityId `51915`), was found the same way: present in a broader mobile-client catalog crawl (multiple tags, 285 unique titles collected), reportedly not visible anywhere on the website by the user, matching the same web-vs-mobile catalog gap pattern.
- RDR2 also does not appear in page 1 of `tagId=0` ("All Games") for the web client; page 2+ can't be checked due to Bug 2.

### Impact
An unknown but apparently non-trivial number of catalog titles (RDR2 and Ghost of Tsushima confirmed, likely more) are fully playable and exist in the catalog, but are invisible to **every** web discovery path: search (Bug 1), the tag they should logically belong to (Bug 3, this section), and the default "All Games" view (Bug 2). The only way to reach them is knowing their numeric communityId in advance, which is not exposed anywhere in the web UI.

### Suggested Fix
Determine whether this is intentional (e.g. certain titles licensed/enabled for mobile-cloud-streaming only, deliberately excluded from the web catalog) or an unintentional divergence between whatever catalog/tag index each client type reads from. If unintentional: audit the backend catalog/tag-index logic keyed off the `client` field and reconcile the web-visible set with the mobile-visible set. If intentional: this should at minimum be documented, since it currently presents to users as "the search is broken" rather than "this title isn't available on web" — RDR2 is not disabled or delisted at the community/data level (its detail page and play flow work fine), it is simply never surfaced to a web-identified client.

---

## Overall Impact
- Combined, these three bugs make real, purchasable, playable games (at least RDR2 and Ghost of Tsushima confirmed) completely undiscoverable through the web client via any available UI path (search, specific tag, or default "All Games" browse).
- Likely affects far more than these two — any title beyond page 30 of "All Games" (Bug 2) or excluded from the web-client-scoped catalog (Bug 3) is equally unreachable, and no title is findable by name at all (Bug 1).
- Directly affects discoverability/conversion for web users — likely undercounts real demand for search- and browse-driven game discovery, and may be masking the true size of the reachable catalog from web users entirely.

## Overall Severity
High — core discovery functionality (search, tag browsing, and default library browsing) is broken or incomplete on the web client, and at least one real title is fully unreachable as a result. Each bug is independently confirmed via live network capture and should be tracked and fixed separately, but likely share a common theme of catalog/index data not being consistently synced across the services backing search, tag browse, and community detail.
