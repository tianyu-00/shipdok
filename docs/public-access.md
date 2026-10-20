# Public access

By default **nothing** is reachable from outside your own network. This page explains the three modes, what your proxy must do, and
gives working examples for Nginx, Caddy, Nginx Proxy Manager and a Cloudflare Tunnel.

Shipdok ships no proxy, no tunnel and no certificates. You bring the public address and the HTTPS; Shipdok decides who is let in.

## The three modes

Set the mode and the public address in the dashboard under **Security → Public access** (changing them needs your password and takes
effect at once). If you set `SHIPDOK_PUBLIC` or `PUBLIC_URL` in the environment, that value wins and the dashboard shows the field locked.

| Mode | What an outside visitor can do | Use it for |
|---|---|---|
| **Local** (default) | Nothing. Every path answers 404, the webhook included. | Shipdok used only from your network. Deploy with the button. |
| **Webhook only** | Only `POST /api/webhooks/github`. Everything else answers 404. | Automatic deploys on push, dashboard kept private. **The recommended setup.** |
| **Full access** | The whole dashboard. | Managing Shipdok away from home. Use HTTPS only. |

Someone on your local network, or on a VPN you run, always reaches everything, whatever the mode.

The **public address** is the one outside visitors (and GitHub) use, for example `https://shipdok.example.com`. Shipdok gives it to
GitHub as the webhook address (`<public address>/api/webhooks/github`) and keeps GitHub's copy up to date when you change it. With several GitHub Apps
connected they all use the same address (each has its own secret), and a change is sent to every one of them.

## What your proxy must do

Shipdok decides who is outside by looking at the connection and at the headers a proxy adds. For that to work, the proxy has to:

1. **Run on the Shipdok machine, or on a private or VPN address.** Shipdok only believes proxies that connect from loopback or a private range
   (`10.x`, `172.16-31.x`, `192.168.x`, `fc00::/7`).
2. **Pass the original `Host` header** (the public name, not the Shipdok machine's). Shipdok checks that a request really came from its own page.
3. **Add `X-Forwarded-For`** with the visitor's real address, so rate limits, the sign-in lockout and the recent sign-ins list see real visitors.
4. **Add `X-Forwarded-Proto`** (`https`), so the login cookie is marked `Secure`.

When something is wrong, Shipdok fails closed: a visitor it cannot place counts as outside and gets 404 in `local` and `webhook` mode. It never
opens up by mistake. If the dashboard answers 404 or "Not found" when it should not, a header is usually missing.

**Never forward a router port straight to the dashboard** (`WEB_BIND=0.0.0.0` plus a port forward). The real visitor address can be lost on the
way and the visitor then looks local. Always put a proxy in between.

Behind the proxy, point it at the dashboard (`127.0.0.1:8080`, or the port in `WEB_HOST_PORT`). In `webhook` mode you can point only the
webhook at the API (`127.0.0.1:4000`, or `API_HOST_PORT`).

> **Defence in depth:** in `webhook` mode, also make your proxy forward *only* the webhook path, as in the examples below. Then nothing else is
> reachable even if a setting is changed by mistake.

## Nginx

Full access to the dashboard (use with `full` mode, or with `local`/`webhook` if you also want to reach it from the network the proxy is on):

```nginx
server {
    listen 443 ssl;
    server_name shipdok.example.com;
    # ssl_certificate and ssl_certificate_key here (for example from Certbot)

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host              $http_host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Webhook only (recommended): forward the webhook and answer 404 for everything else.

```nginx
server {
    listen 443 ssl;
    server_name shipdok.example.com;
    # ssl_certificate and ssl_certificate_key here

    location = /api/webhooks/github {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host              $http_host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        return 404;
    }
}
```

## Caddy

Caddy gets and renews the certificate for you.

Full access:

```caddyfile
shipdok.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

Webhook only (recommended). Use `handle` blocks: a bare `respond 404` next to `reverse_proxy` runs first and answers everything.

```caddyfile
shipdok.example.com {
	@webhook {
		method POST
		path /api/webhooks/github
	}
	handle @webhook {
		reverse_proxy 127.0.0.1:4000
	}
	handle {
		respond 404
	}
}
```

Caddy passes the original `Host`, adds `X-Forwarded-For` and `X-Forwarded-Proto`, and keeps them correct, so nothing else is needed.

## Nginx Proxy Manager

Nginx Proxy Manager (NPM) is Nginx with a web interface, so it behaves like the Nginx examples. *This one has not been tried here; the
settings follow from the Nginx tests, so check the first request.*

1. **Proxy Hosts → Add Proxy Host.**
   - Domain name: `shipdok.example.com`.
   - Scheme `http`, forward host name or IP: the Shipdok machine's address, forward port `8080`.
   - Leave **Websockets Support** off; the dashboard does not use it.
2. **SSL tab:** request a certificate and turn on **Force SSL**.
3. NPM already sends `Host`, `X-Forwarded-For` and `X-Forwarded-Proto`. If NPM runs on another machine, its address must be private or a VPN
   address (see above).
4. **For webhook only:** open the **Advanced** tab of the proxy host and paste this, which restricts the host to the webhook. Point it at the API
   port (`4000`) and leave the main forward port as it is:

```nginx
location = /api/webhooks/github {
    proxy_pass http://SHIPDOK_MACHINE_ADDRESS:4000;
    proxy_set_header Host              $http_host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location / {
    return 404;
}
```

   Replace `SHIPDOK_MACHINE_ADDRESS` with the address of the Shipdok machine. The API port is published on that machine's loopback by default, so
   if NPM runs elsewhere set `API_HOST_PORT` and publish it as needed, or forward the webhook to the dashboard port (`8080`) instead, which
   also accepts it.

## Cloudflare Tunnel (or another tunnel)

A tunnel is an outbound connection from your machine to the tunnel provider, so no router port has to be opened. Run the tunnel client
**on the Shipdok machine** (or on a machine on a private address) and point it at Shipdok.

Webhook only, with `cloudflared` (`~/.cloudflared/config.yml`):

```yaml
tunnel: shipdok
credentials-file: /home/you/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: shipdok.example.com
    path: ^/api/webhooks/github$
    service: http://127.0.0.1:4000
  - service: http_status:404
```

Anything that is not the webhook gets a 404 from Cloudflare itself. This is the setup the author uses for deploy-on-push. To expose the
whole dashboard instead, use `service: http://127.0.0.1:8080` with no `path`, together with `full` mode.

If you run the tunnel in front of Nginx or Caddy, point the tunnel at the proxy and let the proxy talk to Shipdok as above. The tunnel
client then connects from a private address and Shipdok trusts what it reports.

## Finishing up

1. Make your proxy or tunnel answer on the public name.
2. In the dashboard: **Security → Public access**, choose the mode, enter the public address (for example `https://shipdok.example.com`) and save.
3. On the **GitHub** page, check the **Webhook address** card shows "right address". If it shows a different one, press **Update on GitHub**.
4. Push to a tracked branch. The delivery appears in the app's deployment history.

To check from outside what a stranger would see, open the public name on a phone that is **not** on your Wi-Fi. In `webhook` mode you should
get a plain "Not found" for the dashboard.

## HTTPS

Plain HTTP is not encrypted: anyone on the path can read your password and session. Do not use `full` mode without HTTPS. Shipdok's own
dashboard is plain HTTP on port 8080; the HTTPS comes from your proxy or tunnel.
