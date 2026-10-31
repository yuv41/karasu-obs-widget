# Karasu stream widget

An OBS browser source that shows a Karasu player's stats live on stream, in
karasu.live's look: ELO and level with progress to the next one, leaderboard
rank, today's matches, won/lost, ELO and K/D today, and the last five results.
When a match ends it counts the ELO to the new value, floats the change off the
number and slides the new result in.

Hosted at **https://widget.karasu.live**. The page there builds a player's
widget link, with a live preview and a button to play a sample win or loss.

## How it works

Plain HTML, CSS and JavaScript in `public/`, with no build step.

- `overlay.html` + `assets/widget.js` / `widget.css` is the widget OBS loads.
  It reads the [Karasu public API](https://karasu.live/developers)
  (`GET https://api.karasu.live/public/v1/players/{steamId}`) straight from the
  browser source every 45 seconds. CORS is open, and the 10 requests a minute
  limit is per IP, so there is no server-side proxy and one streamer can never
  use up another's limit.
- `index.html` + `assets/builder.*` is the link builder. It fetches the player
  once and hands the data to the preview frame, so changing options never
  spends the API limit.

### "Today"

The API returns only the last five matches. The widget keeps its own per-day
tally in the browser source's `localStorage`, adding today's matches on every
poll. Whenever the day's first match is still among those five, it also pins
the day's starting ELO, so "ELO today" stays exact past five games. If the
widget is first opened after more than five games that day, the match count
shows as a lower bound (`5+`). The day rolls over at local midnight, or at the
hour set with `daystart`.

## Widget link parameters

| Parameter  | Values                    | Default |
|------------|---------------------------|---------|
| `id`       | 17-digit Steam ID         | required |
| `layout`   | `card`, `bar`             | `card`  |
| `stats`    | `1` adds the last-20 row (card only) | off |
| `avatar`   | `0` hides the Steam avatar | shown  |
| `daystart` | hour `0`–`23`             | `0`     |
| `scale`    | `0.5`–`3`                 | `1`     |
| `bg`       | panel opacity `0`–`100`   | `90`    |
| `demo`     | `1` shows sample data     | off     |

## Local development

```bash
cd public && python3 -m http.server 8080
```

Open `http://localhost:8080/overlay.html?demo=1` or `http://localhost:8080/`.
The builder's preview loads `/overlay`, which nginx maps to `overlay.html`, so
use a server that does the same (or open `overlay.html` directly).

## Deploy

```bash
./deploy/deploy.sh
```

It copies `public/` to `/www/wwwroot/widget.karasu.live`. The nginx site is in
`deploy/nginx.conf`. The site is behind Cloudflare in Full (strict) mode with a
Let's Encrypt certificate issued by certbot over the webroot challenge.

## Credits

Quantico and Oxanium are licensed under the SIL Open Font License
(`public/assets/fonts/*-OFL.txt`). The Karasu name and mark belong to
Karasu.
