# Laura's birthday party: live server

This makes the party real. Every guest who signs up appears in the room. A green dot shows who is online.
Guests who are offline still show as their avatar. The buffet bills are kept for everyone.

## Put it online (about 15 minutes)

1. Make a free account at github.com. Click **New repository**, name it `laura-party`, and create it.
2. On the new repository page click **uploading an existing file**. Drag in everything from this folder
   (`server.js`, `package.json`, `package-lock.json`, `render.yaml` and the `public` folder). Click **Commit changes**.
3. Make an account at render.com (sign up with GitHub). Click **New**, then **Blueprint**, and pick your `laura-party` repository.
4. Render asks for two secrets. Type any simple words with letters and numbers only:
   - `VIP_KEY`: for example `lauraKey2026`. This is Laura's secret key.
   - `ADMIN_KEY`: for example `bills2026`. This opens the bills page.
5. Click **Apply**. No card needed. After a few minutes Render shows your address, like `https://laura-party.onrender.com`.

## Your links

| What | Link |
|---|---|
| For all guests | `https://YOUR-ADDRESS/` |
| For Laura only (she can blow out the candles) | `https://YOUR-ADDRESS/?vip=lauraKey2026` |
| Bills for everyone, and a button to remove a guest | `https://YOUR-ADDRESS/admin?key=bills2026` |

Laura opens her link once on her phone. After that her phone remembers her.

## Cost: free, with two trade-offs

This is set up on Render's **free** plan, so it costs nothing and no card is needed. Two things come with that:

- **It falls asleep** after 15 quiet minutes, and takes 10-30 seconds to wake up the next time someone opens the link.
- **It forgets guests, bills and photos** whenever it falls asleep, since the free plan has no disk to remember them on.
  Phones sign themselves back in on their own, but bills and photos from before it slept are gone.

For a short, casual party this is usually fine. If you want the party to stay awake the whole time and
remember everything, open `render.yaml` and follow the instructions written at the top of that file to
switch to the paid **Starter** plan (about $7.25 a month, billed by the second — check render.com/pricing).
**Delete the service on the Render dashboard when the party is over** so the charges stop.

## Change something

- Laura's name: change `BIRTHDAY_NAME` in Render, under Environment.
- The menu and prices: they are in `public/index.html` (`P.MENU`) and in `server.js` (`MENU`). Both must match.
  The server prints a warning at start-up if they do not.

## Run it on your own computer (optional)

Install Node.js 18 or newer, then in this folder run `npm install` and `npm start`.
Open http://localhost:3000. The links to Laura's page and the bills page are printed in the terminal.
