# Render Deployment Guide

**Live deployment**: [https://signals-challenge.onrender.com](https://signals-challenge.onrender.com)

---

## Blueprint Deploy

The repository includes two Render Blueprints:

| Blueprint | File | Persistent Disk | Data Survives Deploys |
|-----------|------|-----------------|-----------------------|
| **Paid tier** | `render.yaml` | 1 GB attached | Yes |
| **Free tier** | `render_free_tier.yml` | None (ephemeral) | No |

### Steps

1. Navigate to [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint**.
2. Connect the GitHub repository and select the appropriate branch.
3. Render auto-detects the Blueprint and displays the service configuration.
4. Click **Apply**. Render will run `npm install`, start the server, and auto-generate a secure `API_KEY`.

> The free tier does not support persistent disks. SQLite data resets on each deploy, but the service operates correctly.

---

## Verification

```bash
# Health check (no authentication required)
curl https://signals-challenge.onrender.com/healthz

# Create a signal
curl -X POST https://signals-challenge.onrender.com/v1/signals \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{"userId":"user-1","type":"click","payload":"button-A"}'

# List signals
curl "https://signals-challenge.onrender.com/v1/signals?userId=user-1" \
  -H "X-API-Key: $API_KEY"
```

---

## Notes

- **Auto-deploy**: Render redeploys automatically on push to the connected branch.
- **Cold starts**: Free tier instances spin down after 15 minutes of inactivity; the first request may take ~30 seconds.
- **Docker**: Set the runtime to Docker instead of Node. Render will auto-detect the `Dockerfile`.
