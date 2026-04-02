# Thrill Session PNL

Chrome extension that injects per-session PNL next to the bet count on
`thrill.com/account/transactions?transactionType=casino`.

## Install

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select this folder
4. Navigate to the Thrill transactions page — PNL badges will appear automatically

## How it works

For each session card on the list page, the extension fetches the session detail
page in the background, sums all individual bet PNL values (`+€X.XX` / `-€X.XX`),
and displays the total next to the bet count.

- 🟢 Green = profitable session
- 🔴 Red = losing session  
- `—` = could not load data (see below)

## If you see `—` on all cards (API fallback needed)

Thrill likely renders the detail page client-side (JavaScript), so a plain `fetch()`
returns an empty shell with no transaction data.

**Fix: intercept the GraphQL/REST call the detail page makes.**

1. On Thrill, navigate to any session detail page
2. Open DevTools → **Network** tab → filter by `graphql` or `XHR`
3. Find the request that returns the list of bets (look for a response containing
   the amounts like `-0.17`, `1.10`, etc.)
4. Share: the request URL, method (GET/POST), headers, and body
5. We'll update `content.js` to call that endpoint directly instead of scraping HTML

## Files

```
thrill-pnl/
├── manifest.json   Chrome extension manifest (MV3)
└── content.js      Content script — fetch + parse + inject
```
